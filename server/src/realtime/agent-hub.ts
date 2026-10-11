import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import { AgentMessageSchema } from "@navloom/contracts";
import { AgentTasks } from "./agent-tasks.js";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { DatabaseConnection } from "../db/client.js";
import { ApiFailure, Access } from "../security/access.js";
import type { PagePresence } from "./page-presence.js";

const MAX_MESSAGE_BYTES = 64 * 1024;

type Session = {
  socket: WebSocket;
  agentId: string;
  lastCommunication: number;
  helloReceived: boolean;
  seenMessages: Set<string>;
  pendingProbe: ReturnType<typeof setTimeout> | null;
  helloTimeout: ReturnType<typeof setTimeout> | null;
  connectedAt: number;
  lastPongAt: number | null;
};

export class AgentHub {
  private readonly sessions = new Map<string, Session>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private readonly helloTimeoutMs: number;
  readonly tasks: AgentTasks;

  constructor(private readonly db: DatabaseConnection, options: { sweepIntervalMs: number; taskTimeoutMs?: number; helloTimeoutMs?: number }) {
    this.helloTimeoutMs = options.helloTimeoutMs ?? 8_000;
    this.tasks = new AgentTasks(db, options.taskTimeoutMs);
    this.sweep = setInterval(() => this.expire(), options.sweepIntervalMs);
    this.sweep.unref();
  }

  isOnline(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    return Boolean(session && session.socket.readyState === WebSocket.OPEN && session.helloReceived);
  }

  connectionObservation(agentId: string): { connectedAt: number | null; lastPongAt: number | null; handshakePending: boolean } {
    const session = this.sessions.get(agentId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) {
      return { connectedAt: null, lastPongAt: null, handshakePending: false };
    }
    return {
      connectedAt: session.helloReceived ? session.connectedAt : null,
      lastPongAt: session.lastPongAt,
      handshakePending: !session.helloReceived,
    };
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
      if (!session.helloReceived ||
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

  connect(agentId: string, socket: WebSocket): void {
    // Newest valid connection wins. Old socket callbacks cannot modify the new session.
    this.disconnect(agentId, 4001, "replaced");
    const session: Session = {
      agentId, socket, lastCommunication: Date.now(), helloReceived: false, seenMessages: new Set(),
      pendingProbe: null, helloTimeout: null, connectedAt: Date.now(), lastPongAt: null,
    };
    this.sessions.set(agentId, session);
    // Mutual TLS alone is not a completed Agent protocol session.
    // An Agent that never sends a valid v2 hello must not occupy this socket indefinitely.
    session.helloTimeout = setTimeout(() => {
      if (this.sessions.get(agentId) === session && !session.helloReceived) {
        this.reject(session, 1008, "hello timeout");
      }
    }, this.helloTimeoutMs);
    session.helloTimeout.unref();
    socket.on("pong", () => {
        if (this.sessions.get(agentId) !== session || !session.pendingProbe) return;
        clearTimeout(session.pendingProbe);
        session.pendingProbe = null;
        session.lastCommunication = Date.now();
        session.lastPongAt = session.lastCommunication;
      });
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
    if (session.helloTimeout) clearTimeout(session.helloTimeout);
    session.pendingProbe = null;
    session.helloTimeout = null;
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
      if (session.helloTimeout) clearTimeout(session.helloTimeout);
      session.pendingProbe = null;
      session.helloTimeout = null;
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
        !["hello", "task_result"].includes(message.type) ||
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
      if (session.helloTimeout) clearTimeout(session.helloTimeout);
      session.helloTimeout = null;
      this.touch(session, message.payload.version);
      // Capability tasks require a separate explicit administrator request.
    } else if (message.type === "task_result") {
      if (!this.tasks.acceptResult(session.agentId, message)) {
        this.reject(session, 1008, "task result rejected");
        return;
      }
      this.touch(session);
    }
  }

  private expire(): void { this.tasks.expire(); }
}

/** Only browsers register presence on the Server. Agent WSS is outbound to trusted NAS IPs. */
export function registerPagePresenceTransport(
  app: FastifyInstance, db: DatabaseConnection, presence: PagePresence, production: boolean,
): void {
  app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false } });
    const access = new Access(db, production);
    scope.get("/api/v1/presence", {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        let allowed = false;
        if (typeof origin === "string") {
          try {
            const url = new URL(origin);
            allowed = ["http:", "https:"].includes(url.protocol) &&
              (!production || url.protocol === "https:") &&
              url.host === request.headers.host && !url.username && !url.password;
          } catch { /* malformed origins are rejected */ }
        }
        if (!allowed) throw new ApiFailure(403, "ORIGIN_REJECTED", "页面来源不受信任");
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
  });
}
