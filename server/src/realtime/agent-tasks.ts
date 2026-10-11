import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "../db/client.js";
import type { AgentCapabilities, AgentMessage } from "@navloom/contracts";
import { AGENT_PROTOCOL_VERSION } from "@navloom/contracts";
import { WebSocket } from "ws";

type TaskResult = Extract<AgentMessage, { type: "task_result" }>;
type TaskRow = {
  id: string; agentId: string; operation: string; status: string;
  createdAt: number; dispatchedAt: number; deadlineAt: number;
  finishedAt: number | null; resultJson: string | null;
};
const taskSelect = "SELECT id, agent_id AS agentId, operation, status, created_at AS createdAt, dispatched_at AS dispatchedAt, deadline_at AS deadlineAt, finished_at AS finishedAt, result_json AS resultJson FROM agent_tasks";

export class AgentTasks {
  constructor(private readonly db: DatabaseConnection, private readonly timeoutMs = 15_000) {
    // A Server restart cannot prove whether a remote task executed.
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE status = 'sent'").run();
  }

  /** Only this fixed read-only operation is executable before Docker controls are implemented. */
  dispatchCapabilityProbe(agentId: string, socket: WebSocket): string {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Agent connection unavailable");
    const existing = this.db.sqlite.prepare(
      "SELECT id FROM agent_tasks WHERE agent_id = ? AND operation = 'capability_probe' AND status = 'sent' AND deadline_at > ? LIMIT 1",
    ).get(agentId, Date.now()) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = Date.now();
    this.db.sqlite.prepare(
      "INSERT INTO agent_tasks (id, agent_id, operation, status, arguments_json, created_at, dispatched_at, deadline_at) VALUES (?, ?, 'capability_probe', 'sent', '{}', ?, ?, ?)",
    ).run(id, agentId, now, now, now + this.timeoutMs);
    const message = {
      protocol_version: AGENT_PROTOCOL_VERSION,
      message_id: randomUUID(),
      agent_id: agentId,
      sent_at: new Date().toISOString(),
      type: "task_dispatch",
      task_id: id,
      payload: { operation: "capability_probe", arguments: {} },
    };
    try {
      socket.send(JSON.stringify(message), (error) => {
        if (error) this.markUnknown(id);
      });
    } catch {
      this.markUnknown(id);
      throw new Error("Agent task delivery not confirmed");
    }
    return id;
  }

  acceptResult(agentId: string, message: TaskResult): boolean {
    const row = this.db.sqlite.prepare(taskSelect + " WHERE id = ?").get(message.task_id) as TaskRow | undefined;
    if (!row || row.agentId !== agentId || row.operation !== "capability_probe") return false;
    if (row.status === "succeeded" || row.status === "failed") return true; // idempotent late/duplicate result
    if (row.status !== "sent" && row.status !== "unknown") return false;
    if (message.payload.success && !message.payload.capabilities) return false;
    if (!message.payload.success && message.payload.capabilities) return false;
    const now = Date.now();
    this.db.sqlite.transaction(() => {
      const updated = this.db.sqlite.prepare(
        "UPDATE agent_tasks SET status = ?, finished_at = ?, result_json = ? WHERE id = ? AND status IN ('sent','unknown')",
      ).run(message.payload.success ? "succeeded" : "failed", now, JSON.stringify(message.payload), row.id);
      if (updated.changes !== 1) return;
      if (message.payload.success && message.payload.capabilities) {
        const capabilities = message.payload.capabilities;
        this.db.sqlite.prepare(
          "INSERT INTO agent_capabilities (agent_id, capabilities_json, checked_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(agent_id) DO UPDATE SET capabilities_json = excluded.capabilities_json, checked_at = excluded.checked_at " +
          "WHERE excluded.checked_at >= agent_capabilities.checked_at",
        ).run(agentId, JSON.stringify(capabilities), row.dispatchedAt);
        this.db.sqlite.prepare("UPDATE agents SET platform = ?, architecture = ? WHERE id = ? AND revoked_at IS NULL")
          .run(capabilities.platform, capabilities.architecture, agentId);
      }
    })();
    return true;
  }

  getTask(id: string): (Omit<TaskRow, "resultJson"> & { result: unknown }) | null {
    const row = this.db.sqlite.prepare(taskSelect + " WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) return null;
    const { resultJson, ...publicRow } = row;
    return { ...publicRow, result: resultJson ? JSON.parse(resultJson) as unknown : null };
  }

  getCapabilities(agentId: string): { capabilities: AgentCapabilities | null; checkedAt: number | null } {
    const row = this.db.sqlite.prepare(
      "SELECT capabilities_json AS json, checked_at AS checkedAt FROM agent_capabilities WHERE agent_id = ?",
    ).get(agentId) as { json: string; checkedAt: number } | undefined;
    return row ? { capabilities: JSON.parse(row.json) as AgentCapabilities, checkedAt: row.checkedAt } :
      { capabilities: null, checkedAt: null };
  }

  markAgentUnknown(agentId: string): void {
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE agent_id = ? AND status = 'sent'").run(agentId);
  }

  markUnknown(taskId: string): void {
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE id = ? AND status = 'sent'").run(taskId);
  }

  expire(): void {
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE status = 'sent' AND deadline_at < ?")
      .run(Date.now());
  }
}
