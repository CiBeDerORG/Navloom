import type { FastifyRequest } from "fastify";
import type { DatabaseConnection } from "../db/client.js";
import type { Access } from "../security/access.js";
import type { AgentHub } from "./agent-hub.js";
import type { ReverseAgentDialer } from "./agent-dialer.js";
import { WebSocket } from "ws";

export type ProbeSettings = { mode: "auto" | "manual"; intervalMs: number; updatedAt: number };
type Page = {
  socket: WebSocket;
  request: FastifyRequest;
  access: Access;
  awaitingPong: boolean;
  lastPong: number;
};

/** One Server-wide presence counter, independent of tabs, devices and browser visibility. */
export class PagePresence {
  private readonly pages = new Set<Page>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private autoProbe: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly dialer: ReverseAgentDialer,
    private readonly hub: AgentHub,
    private readonly options: { sweepIntervalMs?: number; pongTimeoutMs?: number } = {},
  ) {}

  get activePages(): number { return this.pages.size; }

  settings(): ProbeSettings {
    const row = this.db.sqlite.prepare(
      "SELECT mode, interval_ms AS intervalMs, updated_at AS updatedAt FROM agent_probe_settings WHERE id = 'global'",
    ).get() as ProbeSettings | undefined;
    return row ?? { mode: "manual", intervalMs: 30_000, updatedAt: 0 };
  }

  updateSettings(mode: "auto" | "manual", intervalMs: number): ProbeSettings {
    const now = Date.now();
    this.db.sqlite.prepare(
      "INSERT INTO agent_probe_settings (id, mode, interval_ms, updated_at) VALUES ('global', ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, interval_ms = excluded.interval_ms, updated_at = excluded.updated_at",
    ).run(mode, intervalMs, now);
    this.resetAutoProbe();
    const settings = this.settings();
    this.broadcast({ type: "probe_settings", settings });
    return settings;
  }

  agentPaired(agentId: string): void {
    if (this.pages.size > 0) this.dialer.connectAgent(agentId);
  }

  agentRevoked(agentId: string): void {
    this.dialer.closeAgent(agentId);
  }

  probeNow(): number {
    return this.pages.size > 0 ? this.hub.probeReverseAll() : 0;
  }

  add(socket: WebSocket, request: FastifyRequest, access: Access): void {
    if (socket.readyState !== WebSocket.OPEN || (!access.admin(request) && !access.home(request))) {
      socket.close(1008, "login required");
      return;
    }
    const page: Page = { socket, request, access, awaitingPong: false, lastPong: Date.now() };
    const first = this.pages.size === 0;
    this.pages.add(page);
    socket.on("pong", () => { page.awaitingPong = false; page.lastPong = Date.now(); });
    socket.on("message", () => socket.close(1008, "presence is read-only"));
    socket.on("close", () => this.remove(page));
    socket.on("error", () => this.remove(page));
    socket.send(JSON.stringify({ type: "probe_settings", settings: this.settings() }));
    if (first) {
      this.dialer.setActive(true);
      this.sweep = setInterval(() => this.verifyPages(), this.options.sweepIntervalMs ?? 15_000);
      this.sweep.unref();
      this.resetAutoProbe();
    }
  }

  private remove(page: Page): void {
    if (!this.pages.delete(page)) return;
    if (this.pages.size !== 0) return;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    if (this.autoProbe) clearInterval(this.autoProbe);
    this.autoProbe = null;
    this.dialer.setActive(false);
  }

  private verifyPages(): void {
    const now = Date.now();
    for (const page of [...this.pages]) {
      if (page.socket.readyState !== WebSocket.OPEN ||
          (!page.access.admin(page.request) && !page.access.home(page.request)) ||
          (page.awaitingPong && now - page.lastPong > (this.options.pongTimeoutMs ?? 45_000))) {
        this.remove(page);
        page.socket.terminate();
        continue;
      }
      if (!page.awaitingPong) {
        page.awaitingPong = true;
        try { page.socket.ping(); }
        catch { this.remove(page); page.socket.terminate(); }
      }
    }
  }

  private resetAutoProbe(): void {
    if (this.autoProbe) clearInterval(this.autoProbe);
    this.autoProbe = null;
    const settings = this.settings();
    if (this.pages.size === 0 || settings.mode !== "auto") return;
    this.autoProbe = setInterval(() => { this.hub.probeReverseAll(); }, settings.intervalMs);
    this.autoProbe.unref();
  }

  private broadcast(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const page of this.pages) {
      if (page.socket.readyState === WebSocket.OPEN) page.socket.send(payload);
    }
  }

  shutdown(): void {
    for (const page of [...this.pages]) {
      this.remove(page);
      page.socket.terminate();
    }
    if (this.sweep) clearInterval(this.sweep);
    if (this.autoProbe) clearInterval(this.autoProbe);
    this.sweep = null;
    this.autoProbe = null;
    this.dialer.shutdown();
  }
}
