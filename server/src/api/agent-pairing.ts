import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection } from "../db/client.js";
import { Access, ApiFailure, AttemptLimiter } from "../security/access.js";
import type { AgentHub } from "../realtime/agent-hub.js";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");
const newSecret = (): string => randomBytes(32).toString("base64url");
const tokenTTL = 10 * 60 * 1000;
const pairRequest = z.object({
  token: z.string().regex(tokenPattern),
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(80),
  architecture: z.string().trim().min(1).max(80),
}).strict();
const renameRequest = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const idRequest = z.object({ id: z.string().uuid() });

function audit(db: DatabaseConnection, event: string, agentId: string | null = null): void {
  db.sqlite.prepare("INSERT INTO agent_audit_events (id, agent_id, event, created_at) VALUES (?, ?, ?, ?)").run(
    randomUUID(), agentId, event, Date.now(),
  );
}

/** Agent identity check for WSS; never accept homepage/admin cookies as device credentials. */
export function verifyAgentCredential(db: DatabaseConnection, agentId: string, credential: string): boolean {
  if (!z.string().uuid().safeParse(agentId).success || !tokenPattern.test(credential)) return false;
  const row = db.sqlite.prepare("SELECT credential_hash AS hash FROM agents WHERE id = ? AND revoked_at IS NULL")
    .get(agentId) as { hash: string | null } | undefined;
  if (!row?.hash || !/^[0-9a-f]{64}$/.test(row.hash)) return false;
  return timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(tokenDigest(credential), "hex"));
}

export function registerAgentPairing(app: FastifyInstance, db: DatabaseConnection, access: Access, hub: AgentHub): void {
  const pairLimiter = new AttemptLimiter(8);
  app.post("/api/v1/admin/agents/pair-tokens", async (request, reply) => {
    const admin = access.requireAdmin(request);
    const now = Date.now();
    const token = newSecret();
    db.sqlite.transaction(() => {
      const active = db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM agent_pair_tokens WHERE used_at IS NULL AND expires_at > ?",
      ).get(now) as { count: number };
      if (active.count >= 5) throw new ApiFailure(429, "PAIR_TOKEN_LIMIT", "待使用的接入令牌过多，请稍后重试");
      db.sqlite.prepare(
        "INSERT INTO agent_pair_tokens (id, token_hash, created_by_admin_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(randomUUID(), tokenDigest(token), admin.id, now, now + tokenTTL);
      audit(db, "pair_token_issued");
    })();
    reply.status(201);
    reply.header("Cache-Control", "no-store");
    // Raw token is shown exactly once. Never store or log it.
    return { token, expiresAt: new Date(now + tokenTTL).toISOString() };
  });

  app.post("/api/v1/agent/pair", async (request, reply) => {
    const key = "pair:" + request.ip;
    pairLimiter.check(key);
    const input = pairRequest.safeParse(request.body);
    if (!input.success) {
      pairLimiter.failure(key);
      audit(db, "pair_rejected");
      throw new ApiFailure(401, "PAIRING_REJECTED", "接入令牌无效或已失效");
    }
    const now = Date.now();
    const agentId = randomUUID();
    const credential = newSecret();
    try {
      db.sqlite.transaction(() => {
        const token = db.sqlite.prepare(
          "SELECT id FROM agent_pair_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        ).get(tokenDigest(input.data.token), now) as { id: string } | undefined;
        if (!token) throw new ApiFailure(401, "PAIRING_REJECTED", "接入令牌无效或已失效");
        db.sqlite.prepare(
          "INSERT INTO agents (id, name, credential_hash, version, platform, architecture, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(agentId, input.data.name, tokenDigest(credential), input.data.version, input.data.platform, input.data.architecture, now);
        const used = db.sqlite.prepare(
          "UPDATE agent_pair_tokens SET used_at = ?, agent_id = ? WHERE id = ? AND used_at IS NULL",
        ).run(now, agentId, token.id);
        if (used.changes !== 1) throw new ApiFailure(401, "PAIRING_REJECTED", "接入令牌无效或已失效");
        audit(db, "paired", agentId);
      })();
    } catch (error) {
      if (error instanceof ApiFailure) {
        pairLimiter.failure(key);
        audit(db, "pair_rejected");
      }
      throw error;
    }
    pairLimiter.success(key);
    reply.status(201);
    reply.header("Cache-Control", "no-store");
    return { agentId, credential };
  });

  app.get("/api/v1/admin/agents", async (request) => {
    access.requireAdmin(request);
    const agents = db.sqlite.prepare(
      "SELECT id, name, version, platform, architecture, registered_at AS registeredAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM agents ORDER BY name COLLATE NOCASE ASC, id ASC",
    ).all() as Array<{
      id: string; name: string; version: string | null; platform: string | null;
      architecture: string | null; registeredAt: number | null; lastSeenAt: number | null; revokedAt: number | null;
    }>;
    return { agents: agents.map((agent) => ({ ...agent, status: agent.revokedAt === null ? (hub.isOnline(agent.id) ? "online" : "offline") : "revoked" })) };
  });

  app.patch("/api/v1/admin/agents/:id", async (request) => {
    access.requireAdmin(request);
    const id = idRequest.safeParse(request.params);
    const body = renameRequest.safeParse(request.body);
    if (!id.success || !body.success) throw new ApiFailure(400, "INVALID_INPUT", "设备 ID 或名称无效");
    const result = db.sqlite.prepare("UPDATE agents SET name = ? WHERE id = ? AND revoked_at IS NULL").run(body.data.name, id.data.id);
    if (result.changes !== 1) throw new ApiFailure(404, "AGENT_NOT_FOUND", "设备不存在或已撤销");
    audit(db, "renamed", id.data.id);
    return { ok: true };
  });

  app.post("/api/v1/admin/agents/:id/revoke", async (request) => {
    access.requireAdmin(request);
    const id = idRequest.safeParse(request.params);
    if (!id.success) throw new ApiFailure(400, "INVALID_INPUT", "设备 ID 无效");
    const result = db.sqlite.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id.data.id);
    if (result.changes !== 1) throw new ApiFailure(404, "AGENT_NOT_FOUND", "设备不存在或已撤销");
    audit(db, "revoked", id.data.id);
    hub.disconnect(id.data.id, 4003, "revoked");
    return { ok: true };
  });
}
