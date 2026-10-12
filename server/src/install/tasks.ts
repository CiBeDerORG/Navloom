import { createHmac, randomUUID } from "node:crypto";
import { sealInstallParameters } from "./secrets.js";
import type { InstallNavigationDraft } from "./preflight.js";
import type { DatabaseConnection } from "../db/client.js";

export type InstallStatus = "prepared" | "pending" | "running" | "unknown" | "succeeded" | "failed";
type InstallRow = {
  id: string; agentId: string; templateId: string; templateVersion: string;
  idempotencyKey: string; status: InstallStatus; exitCode: number | null;
  createdAt: number; updatedAt: number;
};
export type NewInstallTask = {
  agentId: string; templateId: string; templateVersion: string; idempotencyKey: string;
};

const select = "SELECT id, agent_id AS agentId, template_id AS templateId, template_version AS templateVersion, " +
  "idempotency_key AS idempotencyKey, status, exit_code AS exitCode, created_at AS createdAt, updated_at AS updatedAt " +
  "FROM install_tasks";

export class InstallStateError extends Error {}

/**
 * This is a persistence-only foundation: creating an install task here does
 * NOT authorize sending Compose to an Agent. T-068 / T-072 / T-074 must first
 * add encrypted/opaque parameters, preflight and authenticated dispatch.
 */
export class InstallTaskStore {
  constructor(private readonly db: DatabaseConnection) {}

  get(id: string): InstallRow | null {
    return this.db.sqlite.prepare(select + " WHERE id = ?").get(id) as InstallRow | undefined ?? null;
  }

  reserve(input: NewInstallTask): { id: string; created: boolean } {
    if (!/^[0-9a-f-]{36}$/i.test(input.agentId) ||
      !/^[a-z][a-z0-9-]{1,47}$/.test(input.templateId) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(input.templateVersion) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) {
      throw new InstallStateError("Invalid install task identity");
    }
    return this.db.sqlite.transaction(() => {
      const old = this.db.sqlite.prepare(select + " WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as InstallRow | undefined;
      if (old) {
        if (old.agentId !== input.agentId || old.templateId !== input.templateId ||
            old.templateVersion !== input.templateVersion) {
          throw new InstallStateError("Idempotency key belongs to another installation");
        }
        return { id: old.id, created: false };
      }
      const agent = this.db.sqlite.prepare(
        "SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL",
      ).get(input.agentId);
      if (!agent) throw new InstallStateError("Agent not found or revoked");
      const id = randomUUID(), now = Date.now();
      this.db.sqlite.prepare(
        "INSERT INTO install_tasks (id, agent_id, template_id, template_version, idempotency_key, " +
        "status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      ).run(id, input.agentId, input.templateId, input.templateVersion, input.idempotencyKey, now, now);
      return { id, created: true };
    })();
  }

  /**
   * Saves a preflight-approved intent, without executing or dispatching it.
   * The runtime MUST provide a persistent external 32-byte encryption key;
   * duplicate requests compare a keyed digest, not plaintext or unkeyed SHA.
   */
  reservePrepared(input: NewInstallTask & {
    parameters: Record<string, string | number | boolean>;
    navigation: InstallNavigationDraft;
  }, key: Buffer): { id: string; created: boolean; status: "prepared" } {
    if (key.length !== 32) throw new InstallStateError("Install vault key unavailable");
    if (!/^[0-9a-f-]{36}$/i.test(input.agentId) ||
        !/^[a-z][a-z0-9-]{1,47}$/.test(input.templateId) ||
        !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(input.templateVersion) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)) {
      throw new InstallStateError("Invalid install task identity");
    }
    const stableParameters = Object.fromEntries(Object.entries(input.parameters)
      .sort(([a], [b]) => a.localeCompare(b)));
    const navigation = JSON.stringify(input.navigation);
    const digest = createHmac("sha256", key).update(JSON.stringify([
      input.agentId, input.templateId, input.templateVersion,
      stableParameters, JSON.parse(navigation) as unknown,
    ])).digest("hex");
    return this.db.sqlite.transaction(() => {
      const existing = this.db.sqlite.prepare(select + " WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as InstallRow | undefined;
      if (existing) {
        const old = this.db.sqlite.prepare("SELECT request_digest AS digest FROM install_task_inputs WHERE task_id = ?")
          .get(existing.id) as { digest: string } | undefined;
        if (!old || old.digest !== digest || existing.status !== "prepared") {
          throw new InstallStateError("Idempotency key conflicts with an existing installation");
        }
        return { id: existing.id, created: false, status: "prepared" as const };
      }
      if (!this.db.sqlite.prepare("SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL")
        .get(input.agentId)) {
        throw new InstallStateError("Agent not found or revoked");
      }
      const id = randomUUID(), now = Date.now();
      const ciphertext = sealInstallParameters(stableParameters, key, id,
        input.agentId, input.templateId, input.templateVersion);
      this.db.sqlite.prepare(
        "INSERT INTO install_tasks (id, agent_id, template_id, template_version, idempotency_key, " +
        "status, parameters_ref, navigation_draft_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)",
      ).run(id, input.agentId, input.templateId, input.templateVersion,
        input.idempotencyKey, "install_task_inputs:" + id, navigation, now, now);
      this.db.sqlite.prepare(
        "INSERT INTO install_task_inputs (task_id, request_digest, parameters_ciphertext, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, digest, ciphertext, now);
      return { id, created: true, status: "prepared" as const };
    })();
  }

  transition(id: string, target: InstallStatus, exitCode: number | null = null): InstallRow {
    return this.db.sqlite.transaction(() => {
      const row = this.get(id);
      if (!row) throw new InstallStateError("Install task not found");
      if (row.status === target && ["succeeded", "failed"].includes(target) && row.exitCode === exitCode) {
        return row; // identical Agent result replay: no second state transition
      }
      const possible: Record<InstallStatus, InstallStatus[]> = {
        prepared: [], // never dispatch from a draft until a reviewed, explicit activation API exists
        pending: ["running", "unknown"],
        running: ["succeeded", "failed", "unknown"],
        unknown: ["succeeded", "failed"],
        succeeded: [],
        failed: [],
      };
      if (!possible[row.status].includes(target)) throw new InstallStateError("Invalid install state transition");
      if (target === "succeeded" && exitCode !== 0 ||
          target === "failed" && (!Number.isInteger(exitCode) || exitCode === 0) ||
          !["succeeded", "failed"].includes(target) && exitCode !== null) {
        throw new InstallStateError("Invalid Compose result exit code");
      }
      const changed = this.db.sqlite.prepare(
        "UPDATE install_tasks SET status = ?, exit_code = ?, updated_at = ? WHERE id = ? AND status = ?",
      ).run(target, exitCode, Date.now(), id, row.status);
      if (changed.changes !== 1) throw new InstallStateError("Concurrent install state update");
      return this.get(id)!;
    })();
  }

  // Task dispatch is allowed only from pending, and the Agent must journal a
  // task ID before executing. Unknown is never auto-resubmitted as pending.
  markStarted(id: string): InstallRow { return this.transition(id, "running"); }
  markUncertain(id: string): InstallRow { return this.transition(id, "unknown"); }
  reportExit(id: string, exitCode: number): InstallRow {
    if (!Number.isSafeInteger(exitCode)) throw new InstallStateError("Invalid Compose exit code");
    return this.transition(id, exitCode === 0 ? "succeeded" : "failed", exitCode);
  }
}
