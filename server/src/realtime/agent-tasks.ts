import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseConnection } from "../db/client.js";
import type { AgentCapabilities, AgentMessage, AgentContainer } from "@navloom/contracts";
import { AGENT_PROTOCOL_VERSION } from "@navloom/contracts";
import { InstallTaskStore } from "../install/tasks.js";
import { WebSocket } from "ws";

type TaskResult = Extract<AgentMessage, { type: "task_result" }>;
type InventoryChunk = Extract<AgentMessage, { type: "inventory_chunk" }>;
type TaskRow = {
  id: string; agentId: string; operation: string; status: string;
  createdAt: number; dispatchedAt: number; deadlineAt: number;
  finishedAt: number | null; resultJson: string | null;
};
const taskSelect = "SELECT id, agent_id AS agentId, operation, status, created_at AS createdAt, dispatched_at AS dispatchedAt, deadline_at AS deadlineAt, finished_at AS finishedAt, result_json AS resultJson FROM agent_tasks";

export class AgentTasks {
  private readonly inventoryPending = new Map<string, { agentId: string; records: AgentContainer[]; chunks: number }>();
  constructor(private readonly db: DatabaseConnection, private readonly timeoutMs = 15_000) {
    // A Server restart cannot prove whether a remote task executed.
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE status = 'sent'").run();
    this.db.sqlite.prepare("UPDATE install_tasks SET status = 'unknown', updated_at = ? WHERE status = 'running'").run(Date.now());
  }

  /**
   * Query an existing installation's durable Agent receipt without executing
   * Compose. Only the target Agent can answer; prepared drafts are excluded.
   * A lost query can safely be requested again with a new query task ID.
   */
  dispatchInstallReceiptQuery(agentId: string, installTaskId: string, socket: WebSocket): string {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Agent connection unavailable");
    const install = new InstallTaskStore(this.db).get(installTaskId);
    if (!install || install.agentId !== agentId || install.status === "prepared") {
      throw new Error("Install task not eligible for reconciliation");
    }
    const id = randomUUID(), now = Date.now();
    const args = { install_task_id: installTaskId };
    this.db.sqlite.prepare(
      "INSERT INTO agent_tasks (id, agent_id, operation, status, arguments_json, created_at, dispatched_at, deadline_at) " +
      "VALUES (?, ?, 'compose_status', 'sent', ?, ?, ?, ?)",
    ).run(id, agentId, JSON.stringify(args), now, now, now + this.timeoutMs);
    const message = {
      protocol_version: AGENT_PROTOCOL_VERSION, message_id: randomUUID(), agent_id: agentId,
      sent_at: new Date().toISOString(), type: "task_dispatch", task_id: id,
      payload: { operation: "compose_status", arguments: args },
    };
    try {
      socket.send(JSON.stringify(message), (error) => { if (error) this.markUnknown(id); });
    } catch {
      this.markUnknown(id);
      throw new Error("Agent status query delivery failed");
    }
    return id;
  }

  /**
   * One administrator action activates exactly one prepared installation.
   * The database reservation and Agent task row commit atomically BEFORE
   * sending any secret-bearing bytes over the paired mTLS socket. Restart,
   * timeout and disconnection can mark the attempt unknown, NEVER resend it.
   * The persisted agent_tasks.arguments_json contains only public identity
   * and project metadata; never environment variables or installer secrets.
   */
  dispatchInstallation(agentId: string, installTaskId: string,
    manifest: { name: string; services: Record<string, unknown>; volumes?: Record<string, unknown> },
    socket: WebSocket): string {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Agent connection unavailable");
    const now = Date.now();
    const payload = {
      protocol_version: AGENT_PROTOCOL_VERSION, message_id: randomUUID(), agent_id: agentId,
      sent_at: new Date(now).toISOString(), type: "task_dispatch", task_id: installTaskId,
      payload: { operation: "compose_deploy", arguments: { install_task_id: installTaskId, manifest } },
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > 48 * 1024) {
      throw new Error("Installation manifest exceeds secure WSS dispatch limit");
    }
    this.db.sqlite.transaction(() => {
      const task = new InstallTaskStore(this.db).get(installTaskId);
      if (!task || task.agentId !== agentId || task.status !== "prepared") {
        throw new Error("Installation was already activated or belongs to another Agent");
      }
      // Serialise same-Agent installations, including unconfirmed previous
      // dispatches. Never write into a possibly still-running Compose project.
      if (this.db.sqlite.prepare(
        "SELECT id FROM install_tasks WHERE agent_id = ? AND id <> ? AND status IN ('pending','running','unknown') LIMIT 1",
      ).get(agentId, installTaskId)) throw new Error("Target Agent has an unresolved installation");
      if (this.db.sqlite.prepare(
        "SELECT id FROM app_instances WHERE agent_id = ? AND compose_project = ? LIMIT 1",
      ).get(agentId, manifest.name)) throw new Error("Compose project is already registered");
      const updated = this.db.sqlite.prepare(
        "UPDATE install_tasks SET status = 'running', updated_at = ? WHERE id = ? AND agent_id = ? AND status = 'prepared'",
      ).run(now, installTaskId, agentId);
      if (updated.changes !== 1) throw new Error("Installation activation was already claimed");
      this.db.sqlite.prepare(
        "INSERT INTO agent_tasks (id, agent_id, operation, status, arguments_json, created_at, dispatched_at, deadline_at) " +
        "VALUES (?, ?, 'compose_deploy', 'sent', ?, ?, ?, ?)",
      ).run(installTaskId, agentId, JSON.stringify({
        install_task_id: installTaskId, compose_project: manifest.name,
      }), now, now, now + 360_000);
    })();
    try {
      socket.send(serialized, (error) => { if (error) this.markUnknown(installTaskId); });
    } catch {
      this.markUnknown(installTaskId);
      // No claim can be safely retried; the caller may only reconcile.
      throw new Error("Installation delivery uncertain; check the durable Agent receipt");
    }
    return installTaskId;
  }

  /** Fixed read-only capability probe over authenticated WSS. */
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

  /** A Docker event must cause a fresh scan after an older in-flight scan
   * settles; merging into that task could publish an out-of-date snapshot.
   */
  hasPendingInventoryRefresh(agentId: string): boolean {
    return Boolean(this.db.sqlite.prepare(
      "SELECT 1 FROM agent_tasks WHERE agent_id = ? AND operation = 'inventory_refresh' AND status = 'sent' AND deadline_at > ? LIMIT 1",
    ).get(agentId, Date.now()));
  }

  /** Inventory is read-only and runs only after an explicit admin request. */
  dispatchInventoryRefresh(agentId: string, socket: WebSocket): string {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Agent connection unavailable");
    const existing = this.db.sqlite.prepare(
      "SELECT id FROM agent_tasks WHERE agent_id = ? AND operation = 'inventory_refresh' AND status = 'sent' AND deadline_at > ? LIMIT 1",
    ).get(agentId, Date.now()) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = Date.now();
    this.db.sqlite.prepare(
      "INSERT INTO agent_tasks (id, agent_id, operation, status, arguments_json, created_at, dispatched_at, deadline_at) VALUES (?, ?, 'inventory_refresh', 'sent', '{}', ?, ?, ?)",
    ).run(id, agentId, now, now, now + 30_000);
    this.inventoryPending.set(id, { agentId, records: [], chunks: 0 });
    const msg = {
      protocol_version: AGENT_PROTOCOL_VERSION, message_id: randomUUID(), agent_id: agentId,
      sent_at: new Date().toISOString(), type: "task_dispatch", task_id: id,
      payload: { operation: "inventory_refresh", arguments: {} },
    };
    try {
      socket.send(JSON.stringify(msg), (error) => { if (error) this.markUnknown(id); });
    } catch {
      this.markUnknown(id);
      throw new Error("Agent inventory dispatch failed");
    }
    return id;
  }

  /** Side-effect tasks require explicit admin action and a durable request UUID.
   * A duplicate idempotency key only returns the original task; it never sends again.
   */
  dispatchContainerTask(
    agentId: string, operation: "container_start" | "container_stop" | "container_restart" | "container_logs",
    containerId: string, socket: WebSocket, idempotencyKey?: string,
  ): string {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Agent connection unavailable");
    if (operation !== "container_logs" && !idempotencyKey) throw new Error("Idempotency key required");
    if (idempotencyKey) {
      const previous = this.db.sqlite.prepare(
        "SELECT id, agent_id AS agentId, operation, arguments_json AS json FROM agent_tasks WHERE idempotency_key = ?",
      ).get(idempotencyKey) as { id: string; agentId: string; operation: string; json: string } | undefined;
      if (previous) {
        if (previous.agentId !== agentId || previous.operation !== operation ||
            (JSON.parse(previous.json) as { container_id: string }).container_id !== containerId) {
          throw new Error("Idempotency key already used for another operation");
        }
        return previous.id;
      }
    }
    const id = randomUUID();
    const now = Date.now();
    const args = { container_id: containerId };
    this.db.sqlite.prepare(
      "INSERT INTO agent_tasks (id, agent_id, operation, status, arguments_json, idempotency_key, created_at, dispatched_at, deadline_at) VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?)",
    ).run(id, agentId, operation, JSON.stringify(args), idempotencyKey ?? null, now, now, now + 45_000);
    const msg = {
      protocol_version: AGENT_PROTOCOL_VERSION, message_id: randomUUID(), agent_id: agentId,
      sent_at: new Date().toISOString(), type: "task_dispatch", task_id: id,
      payload: { operation, arguments: args },
    };
    try {
      socket.send(JSON.stringify(msg), (error) => { if (error) this.markUnknown(id); });
    } catch {
      this.markUnknown(id);
      throw new Error("Agent Docker task delivery not confirmed");
    }
    return id;
  }

  acceptTaskLog(agentId: string, message: Extract<AgentMessage, { type: "task_log" }>): boolean {
    const row = this.db.sqlite.prepare(taskSelect + " WHERE id = ?").get(message.task_id) as TaskRow | undefined;
    if (!row || row.agentId !== agentId || row.operation !== "container_logs" || row.status !== "sent" ||
        row.deadlineAt <= Date.now() || message.payload.sequence > 99 ||
        Buffer.byteLength(message.payload.line, "utf8") > 512 ||
        !this.db.sqlite.prepare("SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL").get(agentId)) return false;
    try {
      this.db.sqlite.prepare(
        "INSERT INTO agent_task_logs (task_id, sequence, line, created_at) VALUES (?, ?, ?, ?)",
      ).run(row.id, message.payload.sequence, message.payload.line, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  getTaskLogs(taskId: string): Array<{ sequence: number; line: string }> {
    return this.db.sqlite.prepare(
      "SELECT sequence, line FROM agent_task_logs WHERE task_id = ? ORDER BY sequence LIMIT 100",
    ).all(taskId) as Array<{ sequence: number; line: string }>;
  }

  /** Apply safe, known event transitions to one Agent's historical row;
   * a debounced full reconcile follows to correct ports, renames and gaps.
   */
  applyInventoryEvent(agentId: string, containerId: string, action: string): void {
    if (!this.db.sqlite.prepare("SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL").get(agentId)) return;
    if (action === "destroy") {
      this.db.sqlite.prepare("DELETE FROM container_inventory WHERE agent_id = ? AND container_id = ?")
        .run(agentId, containerId);
      return;
    }
    const state = ({
      start: "running", restart: "restarting", unpause: "running",
      pause: "paused", die: "exited", stop: "exited",
      create: "created",
    } as Record<string, string>)[action];
    if (state) {
      this.db.sqlite.prepare(
        "UPDATE container_inventory SET state = ?, last_seen_at = ? WHERE agent_id = ? AND container_id = ?",
      ).run(state, Date.now(), agentId, containerId);
    }
  }

  acceptInventoryChunk(agentId: string, message: InventoryChunk): boolean {
    const row = this.db.sqlite.prepare(taskSelect + " WHERE id = ?").get(message.task_id) as TaskRow | undefined;
    const pending = this.inventoryPending.get(message.task_id);
    if (!row || row.agentId !== agentId || row.operation !== "inventory_refresh" ||
        row.status !== "sent" || row.deadlineAt <= Date.now() ||
        !pending || pending.agentId !== agentId || message.payload.sequence !== pending.chunks ||
        pending.records.length + message.payload.containers.length > 2000) return false;
    const active = this.db.sqlite.prepare("SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL").get(agentId);
    if (!active) return false;
    pending.records.push(...message.payload.containers);
    pending.chunks++;
    return true;
  }

  acceptResult(agentId: string, message: TaskResult): boolean {
    const row = this.db.sqlite.prepare(taskSelect + " WHERE id = ?").get(message.task_id) as TaskRow | undefined;
    if (!row || row.agentId !== agentId || !["capability_probe", "inventory_refresh", "container_start", "container_stop", "container_restart", "container_logs", "compose_status", "compose_deploy"].includes(row.operation)) return false;
    // A revoked Agent must never report a delayed completion, even if its
    // original task remains in the audit history.
    const activeAgent = this.db.sqlite.prepare("SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL").get(agentId);
    if (!activeAgent) return false;
    if (row.status === "succeeded" || row.status === "failed") {
      // A genuinely identical delivery is idempotent. A conflicting result is
      // a protocol violation and must not be silently acknowledged.
      return row.resultJson !== null && isDeepStrictEqual(JSON.parse(row.resultJson), message.payload);
    }
    if (row.status !== "sent" && row.status !== "unknown") return false;
    if (row.operation === "capability_probe") {
      if (message.payload.success && !message.payload.capabilities) return false;
      if (message.payload.inventory_count !== undefined || message.payload.inventory_chunks !== undefined) return false;
    } else if (row.operation === "inventory_refresh") {
      if (message.payload.capabilities) return false;
      const pending = this.inventoryPending.get(row.id);
      if (message.payload.success && (
          !pending || pending.agentId !== agentId ||
          message.payload.inventory_count !== pending.records.length ||
          message.payload.inventory_chunks !== pending.chunks ||
          row.status !== "sent" || row.deadlineAt <= Date.now())) return false;
      if (!message.payload.success &&
          (message.payload.inventory_count !== undefined || message.payload.inventory_chunks !== undefined)) return false;
    }
    if (row.operation.startsWith("container_") &&
        (message.payload.capabilities || message.payload.inventory_count !== undefined ||
         message.payload.inventory_chunks !== undefined)) return false;
    if (!message.payload.success && message.payload.capabilities) return false;
    if (row.operation === "compose_deploy") {
      if (message.payload.capabilities || message.payload.inventory_count !== undefined ||
          message.payload.inventory_chunks !== undefined) return false;
      const receipt = message.payload.install_receipt;
      if (message.payload.success !== Boolean(receipt)) {
        if (message.payload.success || receipt) return false;
      }
      if (receipt) {
        const recorded = this.db.sqlite.prepare(
          "SELECT arguments_json AS data FROM agent_tasks WHERE id = ?",
        ).get(row.id) as { data: string } | undefined;
        const args = recorded ? JSON.parse(recorded.data) as { install_task_id: string; compose_project: string } : null;
        if (!args || receipt.install_task_id !== row.id ||
            receipt.install_task_id !== args.install_task_id ||
            (receipt.project && receipt.project !== args.compose_project) ||
            ((receipt.status === "succeeded") !== (receipt.exit_code === 0)) ||
            ((receipt.status === "not_found" || receipt.status === "unknown") && receipt.exit_code !== null) ||
            (receipt.status === "failed" && (receipt.exit_code === null || receipt.exit_code === 0))) return false;
        const install = new InstallTaskStore(this.db).get(receipt.install_task_id);
        if (!install || install.agentId !== agentId || install.status === "prepared" ||
            ((install.status === "succeeded" || install.status === "failed") &&
             (receipt.status === "succeeded" || receipt.status === "failed") &&
             (install.status !== receipt.status || install.exitCode !== receipt.exit_code))) return false;
      }
    } else if (message.payload.install_receipt && row.operation !== "compose_status") return false;
    if (row.operation === "compose_status") {
      if (message.payload.capabilities || message.payload.inventory_count !== undefined ||
          message.payload.inventory_chunks !== undefined) return false;
      const receipt = message.payload.install_receipt;
      if (message.payload.success !== Boolean(receipt)) return false;
      if (receipt) {
        const requested = this.db.sqlite.prepare(
          "SELECT arguments_json AS data FROM agent_tasks WHERE id = ?",
        ).get(row.id) as { data: string } | undefined;
        if (!requested || (JSON.parse(requested.data) as { install_task_id?: string }).install_task_id !== receipt.install_task_id ||
            ((receipt.status === "succeeded") !== (receipt.exit_code === 0)) ||
            ((receipt.status === "unknown" || receipt.status === "not_found") && receipt.exit_code !== null) ||
            (receipt.status === "failed" && (receipt.exit_code === null || receipt.exit_code === 0))) return false;
        const install = new InstallTaskStore(this.db).get(receipt.install_task_id);
        if (!install || install.agentId !== agentId || install.status === "prepared" ||
            (install.status === "pending" && (receipt.status === "succeeded" || receipt.status === "failed"))) return false;
        if ((install.status === "succeeded" || install.status === "failed") &&
            (receipt.status === "succeeded" || receipt.status === "failed") &&
            (install.status !== receipt.status || install.exitCode !== receipt.exit_code)) return false;
      }
    } else if (message.payload.install_receipt) {
      return false;
    }
    const now = Date.now();
    this.db.sqlite.transaction(() => {
      const updated = this.db.sqlite.prepare(
        "UPDATE agent_tasks SET status = ?, finished_at = ?, result_json = ? WHERE id = ? AND status IN ('sent','unknown')",
      ).run(message.payload.success ? "succeeded" : "failed", now, JSON.stringify(message.payload), row.id);
      if (updated.changes !== 1) return;
      if (row.operation === "compose_deploy") {
        if (message.payload.install_receipt) {
          const receipt = message.payload.install_receipt;
          new InstallTaskStore(this.db).reconcileAgentResult({
            taskId: receipt.install_task_id, agentId, status: receipt.status, exitCode: receipt.exit_code,
          });
        } else {
          new InstallTaskStore(this.db).markUncertain(row.id);
        }
      }
      if (row.operation === "compose_status" && message.payload.install_receipt) {
        const receipt = message.payload.install_receipt;
        new InstallTaskStore(this.db).reconcileAgentResult({
          taskId: receipt.install_task_id, agentId, status: receipt.status,
          exitCode: receipt.exit_code,
        });
      }
      if (row.operation === "inventory_refresh" && message.payload.success) {
        const pending = this.inventoryPending.get(row.id);
        if (!pending) throw new Error("Inventory buffer was lost");
        // Commit new snapshot and metadata as one transaction. Empty snapshots
        // remove stale rows; interrupted transfers preserve the old snapshot.
        this.db.sqlite.prepare("DELETE FROM container_inventory WHERE agent_id = ?").run(agentId);
        const insert = this.db.sqlite.prepare(
          "INSERT INTO container_inventory (id, agent_id, container_id, name, image, state, ports_json, labels_json, compose_project, compose_service, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const unique = new Set<string>();
        for (const item of pending.records) {
          if (unique.has(item.container_id)) throw new Error("Duplicate container in inventory");
          unique.add(item.container_id);
          insert.run(randomUUID(), agentId, item.container_id, item.name, item.image, item.state,
            JSON.stringify(item.ports), JSON.stringify(item.labels), item.compose_project,
            item.compose_service, now);
        }
        this.db.sqlite.prepare(
          "INSERT INTO agent_inventory_snapshots (agent_id, updated_at, container_count, task_id) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(agent_id) DO UPDATE SET updated_at = excluded.updated_at, container_count = excluded.container_count, task_id = excluded.task_id",
        ).run(agentId, now, pending.records.length, row.id);
      }
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
    this.inventoryPending.delete(row.id);
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
    this.db.sqlite.prepare("UPDATE install_tasks SET status = 'unknown', updated_at = ? WHERE agent_id = ? AND status = 'running'").run(Date.now(), agentId);
    for (const [id, pending] of this.inventoryPending) {
      if (pending.agentId === agentId) this.inventoryPending.delete(id);
    }
  }

  markUnknown(taskId: string): void {
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE id = ? AND status = 'sent'").run(taskId);
    this.db.sqlite.prepare("UPDATE install_tasks SET status = 'unknown', updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), taskId);
    this.inventoryPending.delete(taskId);
  }

  expire(): void {
    this.db.sqlite.prepare("UPDATE agent_tasks SET status = 'unknown' WHERE status = 'sent' AND deadline_at < ?")
      .run(Date.now());
    this.db.sqlite.prepare(
      "UPDATE install_tasks SET status = 'unknown', updated_at = ? WHERE status = 'running' AND id IN " +
      "(SELECT id FROM agent_tasks WHERE operation = 'compose_deploy' AND status = 'unknown')",
    ).run(Date.now());
    for (const id of this.inventoryPending.keys()) {
      const row = this.db.sqlite.prepare("SELECT status FROM agent_tasks WHERE id = ?").get(id) as { status: string } | undefined;
      if (row?.status !== "sent") this.inventoryPending.delete(id);
    }
  }
}
