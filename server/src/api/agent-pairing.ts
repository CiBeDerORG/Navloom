import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection } from "../db/client.js";
import { Access, ApiFailure, AttemptLimiter } from "../security/access.js";
import type { AgentHub } from "../realtime/agent-hub.js";
import type { PagePresence } from "../realtime/page-presence.js";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");
const newSecret = (): string => randomBytes(32).toString("base64url");
const tokenTTL = 10 * 60 * 1000;
const endpointRequest = z.object({
  host: z.string().min(3).max(64),
  port: z.number().int().min(1).max(65535),
  certificatePem: z.string().min(100).max(8192),
}).strict();
const pairRequest = z.object({
  token: z.string().regex(tokenPattern),
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(80),
  architecture: z.string().trim().min(1).max(80),
  endpoint: endpointRequest.optional(),
}).strict();
const renameRequest = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const idRequest = z.object({ id: z.string().uuid() });
const emptyRequest = z.object({}).strict();

export function privateHost(host: string): boolean {
  if (isIP(host) === 4) {
    const [a, rawB] = host.split(".").map(Number);
    const b = rawB ?? -1;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return /^f[cd][0-9a-f:]+$/i.test(host);
  return false; // IP literal only: prevent DNS rebinding and public-network SSRF.
}

function validateEndpoint(input: z.infer<typeof endpointRequest> | undefined): {
  host: string; port: number; certificatePem: string; fingerprint: string;
} | null {
  if (!input) return null; // legacy registrations remain unconfigured until re-paired.
  if (!privateHost(input.host)) throw new ApiFailure(401, "PAIRING_REJECTED", "Agent 私网端点无效");
  let cert: X509Certificate;
  try { cert = new X509Certificate(input.certificatePem); }
  catch { throw new ApiFailure(401, "PAIRING_REJECTED", "Agent TLS 证书无效"); }
  const now = Date.now();
  if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now ||
      !cert.subjectAltName?.split(", ").includes("IP Address:" + input.host)) {
    throw new ApiFailure(401, "PAIRING_REJECTED", "Agent TLS 证书地址或有效期无效");
  }
  return {
    host: input.host, port: input.port, certificatePem: input.certificatePem,
    fingerprint: cert.fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

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

export function registerAgentPairing(app: FastifyInstance, db: DatabaseConnection, access: Access, hub: AgentHub, serverClientCertificatePem?: string, presence?: PagePresence): void {
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
      const endpoint = validateEndpoint(input.data.endpoint);
      if (endpoint && !serverClientCertificatePem) {
        throw new ApiFailure(503, "PAIRING_NOT_READY", "Server 尚未配置 Agent 客户端 TLS 身份");
      }
      db.sqlite.transaction(() => {
        const token = db.sqlite.prepare(
          "SELECT id FROM agent_pair_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        ).get(tokenDigest(input.data.token), now) as { id: string } | undefined;
        if (!token) throw new ApiFailure(401, "PAIRING_REJECTED", "接入令牌无效或已失效");
        db.sqlite.prepare(
          "INSERT INTO agents (id, name, credential_hash, version, platform, architecture, registered_at, endpoint_host, endpoint_port, tls_cert_pem, tls_cert_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(agentId, input.data.name, tokenDigest(credential), input.data.version, input.data.platform, input.data.architecture, now,
          endpoint?.host ?? null, endpoint?.port ?? null, endpoint?.certificatePem ?? null, endpoint?.fingerprint ?? null);
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
    // If a page is already online, schedule this newly paired Agent immediately.
    // With zero pages, connectAgent is gated and never sends a network packet.
    if (input.data.endpoint) presence?.agentPaired(agentId);
    reply.status(201);
    reply.header("Cache-Control", "no-store");
    return { agentId, credential, ...(input.data.endpoint ? { serverClientCertificatePem } : {}) };
  });

  app.get("/api/v1/admin/agent-tasks/:id", async (request) => {
    access.requireAdmin(request);
    const id = idRequest.safeParse(request.params);
    if (!id.success) throw new ApiFailure(400, "INVALID_INPUT", "任务 ID 无效");
    const task = hub.tasks.getTask(id.data.id);
    if (!task) throw new ApiFailure(404, "TASK_NOT_FOUND", "任务不存在");
    return { task };
  });

  app.post("/api/v1/admin/agents/:id/capability-probe", async (request, reply) => {
    access.requireAdmin(request);
    const id = idRequest.safeParse(request.params);
    const body = emptyRequest.safeParse(request.body);
    if (!id.success || !body.success) throw new ApiFailure(400, "INVALID_INPUT", "设备 ID 或参数无效");
    const taskId = hub.requestCapabilityProbe(id.data.id);
    reply.status(202);
    return { taskId };
  });

  app.get("/api/v1/admin/agents", async (request) => {
    access.requireAdmin(request);
    const agents = db.sqlite.prepare(
      "SELECT id, name, version, platform, architecture, registered_at AS registeredAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt, endpoint_host AS endpointHost, endpoint_port AS endpointPort FROM agents ORDER BY name COLLATE NOCASE ASC, id ASC",
    ).all() as Array<{
      id: string; name: string; version: string | null; platform: string | null;
      architecture: string | null; registeredAt: number | null; lastSeenAt: number | null; revokedAt: number | null;
      endpointHost: string | null; endpointPort: number | null;
    }>;
    return { agents: agents.map((agent) => ({
      ...agent,
      status: agent.revokedAt !== null ? "revoked" :
        (agent.endpointHost && presence?.activePages === 0 ? "paused" : hub.isOnline(agent.id) ? "online" : "offline"),
      ...hub.tasks.getCapabilities(agent.id),
    })) };
  });

  app.get("/api/v1/admin/agents/:id", async (request) => {
    access.requireAdmin(request);
    const id = idRequest.safeParse(request.params);
    if (!id.success) throw new ApiFailure(400, "INVALID_INPUT", "设备 ID 无效");
    const agent = db.sqlite.prepare(
      "SELECT id, name, version, platform, architecture, registered_at AS registeredAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt, endpoint_host AS endpointHost, endpoint_port AS endpointPort FROM agents WHERE id = ?",
    ).get(id.data.id) as {
      id: string; name: string; version: string | null; platform: string | null;
      architecture: string | null; registeredAt: number | null; lastSeenAt: number | null; revokedAt: number | null;
      endpointHost: string | null; endpointPort: number | null;
    } | undefined;
    if (!agent) throw new ApiFailure(404, "AGENT_NOT_FOUND", "设备不存在");
    return { agent: {
      ...agent,
      status: agent.revokedAt !== null ? "revoked" :
        (agent.endpointHost && presence?.activePages === 0 ? "paused" : hub.isOnline(agent.id) ? "online" : "offline"),
      ...hub.tasks.getCapabilities(agent.id),
    } };
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
