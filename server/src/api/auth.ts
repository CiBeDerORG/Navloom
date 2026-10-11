import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection } from "../db/client.js";
import { Access, ApiFailure, AttemptLimiter } from "../security/access.js";
import { hashPassword, verifyPassword } from "../security/password.js";

const unlockSchema = z.object({ passphrase: z.string().min(1).max(128) }).strict();
const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();
const changeHomeSchema = z.object({ passphrase: z.string().min(4).max(128) }).strict();
const changePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string().min(12).max(256) }).strict();

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiFailure(400, "INVALID_INPUT", "提交的数据格式不正确");
  return result.data;
}

export function registerAuth(app: FastifyInstance, db: DatabaseConnection, access: Access): void {
  const homeLimiter = new AttemptLimiter(8);
  const adminIPLimiter = new AttemptLimiter(15);
  const adminNameLimiter = new AttemptLimiter(8);

  app.get("/api/v1/auth/home/status", async (request, reply) => ({
    configured: access.homeConfigured(),
    authenticated: access.home(request, reply) || Boolean(access.admin(request)),
  }));

  app.post("/api/v1/auth/home/unlock", async (request, reply) => {
    const { passphrase } = parse(unlockSchema, request.body);
    const key = "home:" + request.ip;
    homeLimiter.check(key);
    const row = db.sqlite.prepare("SELECT password_hash AS hash FROM home_access_settings WHERE id = 'global'").get() as { hash: string } | undefined;
    const valid = await verifyPassword(passphrase, row?.hash ?? null);
    if (!valid) {
      homeLimiter.failure(key);
      throw new ApiFailure(401, "INVALID_CREDENTIALS", "口令不正确");
    }
    homeLimiter.success(key);
    access.issueHome(reply);
    return { ok: true };
  });

  app.get("/api/v1/auth/admin/session", async (request) => {
    const admin = access.admin(request);
    return { authenticated: Boolean(admin), username: admin?.username ?? null, configured: access.adminConfigured() };
  });

  app.post("/api/v1/auth/admin/login", async (request, reply) => {
    const { username, password } = parse(loginSchema, request.body);
    const normalized = username.trim().toLowerCase();
    const ipKey = "admin-ip:" + request.ip;
    const nameKey = "admin-name:" + normalized;
    adminIPLimiter.check(ipKey);
    adminNameLimiter.check(nameKey);
    const row = db.sqlite.prepare("SELECT id, username, password_hash AS hash FROM admin_users WHERE username = ?").get(normalized) as { id: string; username: string; hash: string } | undefined;
    const valid = await verifyPassword(password, row?.hash ?? null);
    if (!valid || !row) {
      adminIPLimiter.failure(ipKey);
      adminNameLimiter.failure(nameKey);
      throw new ApiFailure(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    }
    adminIPLimiter.success(ipKey);
    adminNameLimiter.success(nameKey);
    access.issueAdmin(reply, row.id);
    return { ok: true, username: row.username };
  });

  app.post("/api/v1/auth/admin/logout", async (request, reply) => {
    access.logoutAdmin(request, reply);
    return { ok: true };
  });

  app.patch("/api/v1/admin/settings/password", async (request, reply) => {
    const admin = access.requireAdmin(request);
    const { currentPassword, newPassword } = parse(changePasswordSchema, request.body);
    const row = db.sqlite.prepare("SELECT password_hash AS hash FROM admin_users WHERE id = ?").get(admin.id) as { hash: string };
    if (!await verifyPassword(currentPassword, row.hash)) {
      throw new ApiFailure(401, "INVALID_CREDENTIALS", "当前密码不正确");
    }
    const nextHash = await hashPassword(newPassword);
    db.sqlite.transaction(() => {
      const updated = db.sqlite.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ? AND password_hash = ?").run(nextHash, admin.id, row.hash);
      if (!updated.changes) throw new ApiFailure(409, "PASSWORD_CHANGED", "密码已发生变化，请重新登录");
      db.sqlite.prepare("DELETE FROM admin_sessions WHERE admin_user_id = ?").run(admin.id);
    })();
    access.logoutAdmin(request, reply);
    return { ok: true, relogin: true };
  });

  app.patch("/api/v1/admin/settings/home-passphrase", async (request) => {
    access.requireAdmin(request);
    const { passphrase } = parse(changeHomeSchema, request.body);
    const passwordHash = await hashPassword(passphrase);
    db.sqlite.transaction(() => {
      const now = Date.now();
      db.sqlite.prepare(
        `INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at)
         VALUES ('global', ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash,
           credential_version = home_access_settings.credential_version + 1,
           updated_at = excluded.updated_at`,
      ).run(passwordHash, now);
      db.sqlite.prepare("DELETE FROM home_credentials").run();
    })();
    return { ok: true, revoked: true };
  });

  app.post("/api/v1/admin/settings/home/revoke", async (request) => {
    access.requireAdmin(request);
    if (!access.homeConfigured()) throw new ApiFailure(409, "HOME_NOT_CONFIGURED", "首页口令尚未设置");
    access.revokeAllHome();
    return { ok: true };
  });
}
