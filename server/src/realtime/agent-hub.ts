import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import { AgentMessageSchema, AGENT_PROTOCOL_VERSION } from "@navloom/contracts";
import { AgentTasks } from "./agent-tasks.js";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { DatabaseConnection } from "../db/client.js";
import { ApiFailure, AttemptLimiter } from "../security/access.js";
import { verifyAgentCredential } from "../api/agent-pairing.js";
import { Access } from "../security/access.js";
import type { PagePresence } from "./page-presence.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const AGENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

type Session = {
  socket: WebSocket;
  agentId: string;
  lastCommunication: number;
  helloReceived: boolean;
  seenMessages: Set<string>;
  mode: "legacy" | "reverse";
  pendingProbe: ReturnType<typeof setTimeout> | null;
  lastProbeAt: number | null;
};

export class AgentHub {
  private readonly sessions = new Map<string, Session>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private readonly heartbeatTimeoutMs: number;
  readonly tasks: AgentTasks;

  constructor(private readonly db: DatabaseConnection, options: { heartbeatTimeoutMs: number; sweepIntervalMs: number; taskTimeoutMs?: number }) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.tasks = new AgentTasks(db, options.taskTimeoutMs);
    this.sweep = setInterval(() => this.expire(), options.sweepIntervalMs);
    this.sweep.unref();
  }

  isOnline(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    return Boolean(session && session.socket.readyState === WebSocket.OPEN &&
      (session.mode === "reverse"
        ? session.helloReceived
        : Date.now() - session.lastCommunication <= this.heartbeatTimeoutMs));
  }

  requestCapabilityProbe(agentId: string): string {
    const session = this.sessions.get(agentId);
    if (!session || !session.helloReceived || !this.isOnline(agentId)) {
      throw new ApiFailure(409, "AGENT_OFFLINE", "设备离线或尚未完成协议握手");
    }
    const active = this.db.sqlite.prepare("SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL").get(agentId);
    if (!active) throw new ApiFailure(404, "AGENT_NOT_FOUND", "设备不存在或已撤销");
    return this.tasks.dispatchCapabilityProbe(agentId, session.socket);
  }

  /** Connectivity probes use only WSS Ping/Pong and never write heartbeat rows to SQLite. */
  probeReverseAll(): number {
    let sent = 0;
    for (const session of this.sessions.values()) {
      if (session.mode !== "reverse" || !session.helloReceived ||
          session.socket.readyState !== WebSocket.OPEN || session.pendingProbe) continue;
      try {
        session.socket.ping();
        sent++;
        session.pendingProbe = setTimeout(() => {
          if (this.sessions.get(session.agentId) === session) {
            this.disconnect(session.agentId, 4000, "Pong timeout");
          }
        }, 10_000);
        session.pendingProbe.unref();
      } catch {
        this.disconnect(session.agentId, 4000, "Ping failed");
      }
    }
    return sent;
  }

  connect(agentId: string, socket: WebSocket, mode: "legacy" | "reverse" = "legacy"): void {
    // Newest valid connection wins. Old socket callbacks cannot modify the new session.
    this.disconnect(agentId, 4001, "replaced");
    const session: Session = {
      agentId, socket, lastCommunication: Date.now(), helloReceived: false, seenMessages: new Set(),
      mode, pendingProbe: null, lastProbeAt: null,
    };
    this.sessions.set(agentId, session);
    if (mode === "legacy") this.touch(session);
    if (mode === "reverse") {
      socket.on("pong", () => {
        if (this.sessions.get(agentId) !== session || !session.pendingProbe) return;
        clearTimeout(session.pendingProbe);
        session.pendingProbe = null;
        session.lastCommunication = Date.now();
        session.lastProbeAt = session.lastCommunication;
      });
    }
    socket.on("message", (data, isBinary) => {
      if (this.sessions.get(agentId) !== session) return;
      if (isBinary) { socket.close(1003, "text required"); return; }
      this.receive(session, data.toString());
    });
    socket.on("close", () => this.detach(session));
    socket.on("error", () => this.detach(session));
  }

  disconnect(agentId: string, code = 4003, reason = "disconnected"): void {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);
    if (session.pendingProbe) clearTimeout(session.pendingProbe);
    session.pendingProbe = null;
    this.tasks.markAgentUnknown(agentId);
    if (session.socket.readyState === WebSocket.OPEN) session.socket.close(code, reason);
    else session.socket.terminate();
  }

  shutdown(): void {
    clearInterval(this.sweep);
    for (const id of this.sessions.keys()) this.disconnect(id, 1001, "server shutdown");
  }

  private detach(session: Session): void {
    if (this.sessions.get(session.agentId) === session) {
      this.sessions.delete(session.agentId);
      if (session.pendingProbe) clearTimeout(session.pendingProbe);
      session.pendingProbe = null;
      this.tasks.markAgentUnknown(session.agentId);
    }
  }

  private touch(session: Session, version?: string): void {
    session.lastCommunication = Date.now();
    if (version) {
      this.db.sqlite.prepare("UPDATE agents SET last_seen_at = ?, version = ? WHERE id = ? AND revoked_at IS NULL")
        .run(session.lastCommunication, version, session.agentId);
    } else {
      this.db.sqlite.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(session.lastCommunication, session.agentId);
    }
  }

  private reject(session: Session, code: number, reason: string): void {
    // Security audit contains only a fixed event name, never a raw task or credential.
    this.db.sqlite.prepare("INSERT INTO agent_audit_events (id, agent_id, event, created_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), session.agentId, "protocol_rejected", Date.now());
    session.socket.close(code, reason);
  }

  private receive(session: Session, raw: string): void {
    if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
      this.reject(session, 1009, "message too large");
      return;
    }
    let input: unknown;
    try { input = JSON.parse(raw); }
    catch { this.reject(session, 1007, "invalid json"); return; }
    const parsed = AgentMessageSchema.safeParse(input);
    if (!parsed.success) { this.reject(session, 1008, "invalid protocol message"); return; }
    const message = parsed.data;
    if (message.agent_id !== session.agentId ||
        !(session.mode === "reverse"
          ? ["hello", "task_result"].includes(message.type)
          : ["hello", "heartbeat", "task_result"].includes(message.type)) ||
        (message.type === "hello" && session.helloReceived) ||
        (message.type !== "hello" && !session.helloReceived) ||
        session.seenMessages.has(message.message_id)) {
      this.reject(session, 1008, "message not allowed");
      return;
    }
    session.seenMessages.add(message.message_id);
    if (session.seenMessages.size > 512) {
      const oldest = session.seenMessages.values().next().value;
      if (oldest) session.seenMessages.delete(oldest);
    }
    if (message.type === "hello") {
      session.helloReceived = true;
      this.touch(session, message.payload.version);
      // Reverse mode is demand-driven: no implicit capability task or JSON heartbeat.
      if (session.mode === "legacy") {
        try { this.tasks.dispatchCapabilityProbe(session.agentId, session.socket); }
        catch { /* Delivery failure remains unknown. */ }
      }
    } else if (message.type === "task_result") {
      if (!this.tasks.acceptResult(session.agentId, message)) {
        this.reject(session, 1008, "task result rejected");
        return;
      }
      this.touch(session);
    } else {
      this.touch(session);
    }
  }

  private expire(): void {
    this.tasks.expire();
    for (const [id, session] of this.sessions) {
      if (session.mode === "legacy" && Date.now() - session.lastCommunication > this.heartbeatTimeoutMs) {
        this.disconnect(id, 4000, "heartbeat timeout");
      }
    }
  }
}

function loopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

export function registerAgentTransport(
  app: FastifyInstance, db: DatabaseConnection, hub: AgentHub, production: boolean, presence?: PagePresence,
): void {
  const limiter = new AttemptLimiter(20);
  app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false } });
    if (presence) {
      const access = new Access(db, production);
      scope.get("/api/v1/presence", {
        websocket: true,
        preValidation: async (request) => {
          const origin = request.headers.origin;
          let originAllowed = false;
          if (typeof origin === "string") {
            try {
              const url = new URL(origin);
              originAllowed = ["http:", "https:"].includes(url.protocol) &&
                (!production || url.protocol === "https:") &&
                url.host === request.headers.host && !url.username && !url.password;
            } catch { /* reject malformed origins */ }
          }
          if (!originAllowed) throw new ApiFailure(403, "ORIGIN_REJECTED", "页面来源不受信任");
          if (presence.activePages >= 256) throw new ApiFailure(429, "PRESENCE_LIMIT", "在线页面数量已达上限");
          if (!access.admin(request) && !access.home(request)) {
            throw new ApiFailure(401, "HOME_ACCESS_REQUIRED", "请先登录或解锁导航首页");
          }
        },
      }, (socket, request) => {
        if (!access.admin(request) && !access.home(request)) {
          socket.close(1008, "credential expired");
          return;
        }
        presence.add(socket, request, access);
      });
    }
    scope.get("/agent", {
      websocket: true,
      preValidation: async (request) => {
        const key = "wss:" + request.ip;
        limiter.check(key);
        const agentId = request.headers["x-navloom-agent-id"];
        const authorization = request.headers.authorization;
        const protocol = request.headers["x-navloom-protocol-version"];
        const secureSocket = "encrypted" in request.raw.socket && request.raw.socket.encrypted === true;
        if (production && !secureSocket && !loopback(request.raw.socket.remoteAddress)) {
          limiter.failure(key);
          throw new ApiFailure(403, "SECURE_TRANSPORT_REQUIRED", "Agent 连接必须经过 TLS 反向代理");
        }
        if (typeof agentId !== "string" || !AGENT_ID.test(agentId) ||
            typeof authorization !== "string" || !authorization.startsWith("Bearer ") ||
            !CREDENTIAL.test(authorization.slice(7)) ||
            protocol !== String(AGENT_PROTOCOL_VERSION) ||
            !verifyAgentCredential(db, agentId, authorization.slice(7))) {
          limiter.failure(key);
          throw new ApiFailure(401, "AGENT_UNAUTHORIZED", "Agent 凭据或协议版本无效");
        }
        limiter.success(key);
      },
    }, (socket, request) => {
      const id = request.headers["x-navloom-agent-id"];
      if (typeof id !== "string") { socket.close(1008, "identity required"); return; }
      // Recheck in case admin revoked between preValidation and upgrade.
      const authorization = request.headers.authorization;
      if (typeof authorization !== "string" || !verifyAgentCredential(db, id, authorization.slice(7))) {
        socket.close(1008, "revoked"); return;
      }
      hub.connect(id, socket);
    });
  });
}
