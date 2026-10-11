import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseConnection } from "../db/client.js";

export class ApiFailure extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

const HOME_MAX_AGE = 60 * 60 * 24 * 365 * 10;
const ADMIN_MAX_AGE = 60 * 60 * 24 * 7;
const HOME_COOKIE = "navloom_home";
const ADMIN_COOKIE = "navloom_admin";
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function getCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

function cookie(reply: FastifyReply, name: string, token: string, age: number, secure: boolean): void {
  reply.header(
    "Set-Cookie",
    `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`,
  );
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class Access {
  constructor(private readonly db: DatabaseConnection, private readonly secureCookies: boolean) {}

  homeConfigured(): boolean {
    return Boolean(this.db.sqlite.prepare("SELECT id FROM home_access_settings WHERE id = 'global'").get());
  }

  adminConfigured(): boolean {
    return Boolean(this.db.sqlite.prepare("SELECT id FROM admin_users LIMIT 1").get());
  }

  admin(request: FastifyRequest): { id: string; username: string } | null {
    const token = getCookie(request, ADMIN_COOKIE);
    if (!token) return null;
    const row = this.db.sqlite.prepare(
      `SELECT u.id, u.username FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    ).get(tokenHash(token), Date.now()) as { id: string; username: string } | undefined;
    return row ?? null;
  }

  home(request: FastifyRequest, reply?: FastifyReply): boolean {
    const token = getCookie(request, HOME_COOKIE);
    if (!token) return false;
    const row = this.db.sqlite.prepare(
      `SELECT c.id, c.expires_at AS expiresAt FROM home_credentials c
       JOIN home_access_settings s ON s.id = 'global' AND s.credential_version = c.credential_version
       WHERE c.token_hash = ? AND c.revoked_at IS NULL AND c.expires_at > ?`,
    ).get(tokenHash(token), Date.now()) as { id: string; expiresAt: number } | undefined;
    if (!row) return false;
    // Sliding ten-year lifetime; rotate only when less than nine years remain.
    if (reply && row.expiresAt < Date.now() + HOME_MAX_AGE * 1000 * 9 / 10) {
      this.db.sqlite.prepare("UPDATE home_credentials SET revoked_at = ? WHERE id = ?").run(Date.now(), row.id);
      this.issueHome(reply);
    }
    return true;
  }

  requireAdmin(request: FastifyRequest): { id: string; username: string } {
    const admin = this.admin(request);
    if (!admin) throw new ApiFailure(401, "ADMIN_REQUIRED", "需要管理员登录");
    return admin;
  }

  requireHome(request: FastifyRequest, reply: FastifyReply): void {
    if (!this.admin(request) && !this.home(request, reply)) {
      throw new ApiFailure(401, "HOME_ACCESS_REQUIRED", "需要首页访问口令");
    }
  }

  issueHome(reply: FastifyReply): void {
    const token = newToken();
    const now = Date.now();
    const settings = this.db.sqlite.prepare("SELECT credential_version AS version FROM home_access_settings WHERE id = 'global'").get() as { version: number } | undefined;
    if (!settings) throw new ApiFailure(503, "HOME_NOT_CONFIGURED", "首页口令尚未设置");
    this.db.sqlite.prepare(
      "INSERT INTO home_credentials (id, token_hash, credential_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), tokenHash(token), settings.version, now, now + HOME_MAX_AGE * 1000);
    cookie(reply, HOME_COOKIE, token, HOME_MAX_AGE, this.secureCookies);
  }

  issueAdmin(reply: FastifyReply, adminId: string): void {
    const token = newToken();
    const now = Date.now();
    this.db.sqlite.prepare(
      "INSERT INTO admin_sessions (id, admin_user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), adminId, tokenHash(token), now, now + ADMIN_MAX_AGE * 1000);
    cookie(reply, ADMIN_COOKIE, token, ADMIN_MAX_AGE, this.secureCookies);
  }

  logoutAdmin(request: FastifyRequest, reply: FastifyReply): void {
    const token = getCookie(request, ADMIN_COOKIE);
    if (token) this.db.sqlite.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?").run(Date.now(), tokenHash(token));
    cookie(reply, ADMIN_COOKIE, "", 0, this.secureCookies);
  }

  revokeAllHome(): void {
    this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare("UPDATE home_access_settings SET credential_version = credential_version + 1, updated_at = ? WHERE id = 'global'").run(Date.now());
      this.db.sqlite.prepare("DELETE FROM home_credentials").run();
    })();
  }
}

export class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxAttempts: number, private readonly windowMs = 15 * 60 * 1000) {}

  check(key: string): void {
    const record = this.attempts.get(key);
    if (record && record.resetAt > Date.now() && record.count >= this.maxAttempts) {
      throw new ApiFailure(429, "RATE_LIMITED", "尝试次数过多，请稍后重试");
    }
  }

  failure(key: string): void {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      current.count++;
    }
    // Bounded memory for a single-server deployment.
    if (this.attempts.size > 10000) {
      for (const [id, item] of this.attempts) {
        if (item.resetAt <= now) this.attempts.delete(id);
      }
      if (this.attempts.size > 10000) this.attempts.delete(this.attempts.keys().next().value!);
    }
  }

  success(key: string): void {
    this.attempts.delete(key);
  }
}
