import { isIP } from "node:net";
import websocket from "@fastify/websocket";
import { AgentMessageSchema, AGENT_PROTOCOL_VERSION } from "@navloom/contracts";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { DatabaseConnection } from "../db/client.js";
import { ApiFailure, AttemptLimiter } from "../security/access.js";
import { verifyAgentCredential } from "../api/agent-pairing.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const AGENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

type Session = {
  socket: WebSocket;
  agentId: string;
  lastCommunication: number;
  helloReceived: boolean;
  seenMessages: Set<string>;
};

export class AgentHub {
  private readonly sessions = new Map<string, Session>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private readonly heartbeatTimeoutMs: number;

  constructor(private readonly db: DatabaseConnection, options: { heartbeatTimeoutMs: number; sweepIntervalMs: number }) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.sweep = setInterval(() => this.expire(), options.sweepIntervalMs);
    this.sweep.unref();
  }

  isOnline(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    return Boolean(session && session.socket.readyState === WebSocket.OPEN &&
      Date.now() - session.lastCommunication <= this.heartbeatTimeoutMs);
  }

  connect(agentId: string, socket: WebSocket): void {
    // Newest valid connection wins. Old socket callbacks cannot modify the new session.
    this.disconnect(agentId, 4001, "replaced");
    const session: Session = {
      agentId, socket, lastCommunication: Date.now(), helloReceived: false, seenMessages: new Set(),
    };
    this.sessions.set(agentId, session);
    this.touch(session);
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
    if (session.socket.readyState === WebSocket.OPEN) session.socket.close(code, reason);
    else session.socket.terminate();
  }

  shutdown(): void {
    clearInterval(this.sweep);
    for (const id of this.sessions.keys()) this.disconnect(id, 1001, "server shutdown");
  }

  private detach(session: Session): void {
    if (this.sessions.get(session.agentId) === session) this.sessions.delete(session.agentId);
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

  private receive(session: Session, raw: string): void {
    if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
      session.socket.close(1009, "message too large");
      return;
    }
    let input: unknown;
    try { input = JSON.parse(raw); }
    catch { session.socket.close(1007, "invalid json"); return; }
    const parsed = AgentMessageSchema.safeParse(input);
    if (!parsed.success) { session.socket.close(1008, "invalid protocol message"); return; }
    const message = parsed.data;
    if (message.agent_id !== session.agentId ||
        (message.type !== "hello" && message.type !== "heartbeat") ||
        (message.type === "hello" && session.helloReceived) ||
        (message.type === "heartbeat" && !session.helloReceived) ||
        session.seenMessages.has(message.message_id)) {
      session.socket.close(1008, "message not allowed");
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
    } else {
      this.touch(session);
    }
  }

  private expire(): void {
    for (const [id, session] of this.sessions) {
      if (Date.now() - session.lastCommunication > this.heartbeatTimeoutMs) {
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

export function registerAgentTransport(app: FastifyInstance, db: DatabaseConnection, hub: AgentHub, production: boolean): void {
  const limiter = new AttemptLimiter(20);
  app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false } });
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
