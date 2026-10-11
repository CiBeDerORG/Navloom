import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { WebSocket } from "ws";
import { AGENT_PROTOCOL_VERSION } from "@navloom/contracts";
import type { DatabaseConnection } from "../db/client.js";
import { privateHost } from "../api/agent-pairing.js";
import type { AgentClientIdentity } from "./agent-client-identity.js";
import type { AgentHub } from "./agent-hub.js";

type EndpointRow = {
  id: string;
  endpointHost: string;
  endpointPort: number;
  tlsCertPem: string;
  tlsCertFingerprint: string;
};

/**
 * T-037 foundation: the Server is the only party that dials a private Agent WSS.
 * setActive() must be driven by the global authenticated-page presence manager (T-040).
 * This class is not wired into app startup until that presence manager is available.
 */
export class ReverseAgentDialer {
  private active = false;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly connecting = new Map<string, WebSocket>();

  constructor(
    private readonly db: DatabaseConnection,
    private readonly identity: AgentClientIdentity | null,
    private readonly hub: AgentHub,
  ) {}

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      for (const id of [...this.connecting.keys(), ...this.sockets.keys()]) this.closeAgent(id);
      return;
    }
    if (!this.identity) return; // fail closed: no mTLS identity means no Agent connections.
    const rows = this.db.sqlite.prepare(
      "SELECT id FROM agents WHERE revoked_at IS NULL AND endpoint_host IS NOT NULL AND endpoint_port IS NOT NULL AND tls_cert_pem IS NOT NULL AND tls_cert_fingerprint IS NOT NULL",
    ).all() as Array<{ id: string }>;
    for (const row of rows) this.connectAgent(row.id);
  }

  connectAgent(agentId: string): boolean {
    if (!this.active || !this.identity || this.connecting.has(agentId) || this.sockets.has(agentId)) return false;
    const row = this.db.sqlite.prepare(
      "SELECT id, endpoint_host AS endpointHost, endpoint_port AS endpointPort, tls_cert_pem AS tlsCertPem, tls_cert_fingerprint AS tlsCertFingerprint FROM agents WHERE id = ? AND revoked_at IS NULL",
    ).get(agentId) as EndpointRow | undefined;
    if (!row || !row.endpointHost || !row.endpointPort || !row.tlsCertPem || !row.tlsCertFingerprint ||
        !privateHost(row.endpointHost) || isIP(row.endpointHost) === 0 ||
        !Number.isInteger(row.endpointPort) || row.endpointPort < 1 || row.endpointPort > 65535) {
      return false;
    }
    let cert: X509Certificate;
    try { cert = new X509Certificate(row.tlsCertPem); }
    catch { return false; }
    const now = Date.now();
    if (cert.ca || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now ||
        cert.checkIP(row.endpointHost) !== row.endpointHost ||
        cert.fingerprint256.replaceAll(":", "").toLowerCase() !== row.tlsCertFingerprint) return false;

    const host = isIP(row.endpointHost) === 6 ? "[" + row.endpointHost + "]" : row.endpointHost;
    const socket = new WebSocket("wss://" + host + ":" + row.endpointPort + "/agent", {
      cert: this.identity.certificatePem,
      key: this.identity.keyPem,
      ca: row.tlsCertPem,
      rejectUnauthorized: true,
      perMessageDeflate: false,
      handshakeTimeout: 8_000,
      followRedirects: false,
      headers: {
        "X-Navloom-Agent-Id": agentId,
        "X-Navloom-Protocol-Version": String(AGENT_PROTOCOL_VERSION),
      },
      checkServerIdentity: (_hostname, peer) => {
        const mismatch = checkServerIdentity(row.endpointHost, peer);
        if (mismatch) return mismatch;
        if (!peer.raw || createHash("sha256").update(peer.raw).digest("hex") !== row.tlsCertFingerprint) {
          return new Error("Agent TLS certificate fingerprint mismatch");
        }
        return undefined;
      },
    });
    this.connecting.set(agentId, socket);
    socket.on("error", () => {
      // Never log peer certificates, private keys, or Agent credentials.
      // Connection failure remains distinct from a historical health result.
    });
    socket.once("open", () => {
      if (this.connecting.get(agentId) !== socket || !this.active) {
        socket.terminate();
        return;
      }
      this.connecting.delete(agentId);
      this.sockets.set(agentId, socket);
      this.hub.connect(agentId, socket);
    });
    socket.once("close", () => {
      if (this.connecting.get(agentId) === socket) this.connecting.delete(agentId);
      if (this.sockets.get(agentId) === socket) this.sockets.delete(agentId);
    });
    return true;
  }

  closeAgent(agentId: string): void {
    const connecting = this.connecting.get(agentId);
    this.connecting.delete(agentId);
    const connected = this.sockets.get(agentId);
    this.sockets.delete(agentId);
    if (connected) this.hub.disconnect(agentId, 1001, "no active page");
    if (connecting && connecting.readyState !== WebSocket.CLOSED) connecting.terminate();
    if (connected && connected.readyState !== WebSocket.CLOSED) connected.terminate();
  }

  shutdown(): void {
    this.setActive(false);
  }
}
