import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase } from "./db/client.js";
import { InstallTaskStore } from "./install/tasks.js";
import { unsealInstallParameters, type SealedInstallParameters } from "./install/secrets.js";

test("T-068/T-071/T-073: encrypted prepared install intent is durable and request-idempotent", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "navloom-m3-vault-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "tasks.db");
  const db = openDatabase(file);
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const agentId = randomUUID(), key = randomBytes(32), idempotencyKey = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(agentId, "nas");
  const input = {
    agentId, templateId: "postgres-adminer", templateVersion: "1.0.0", idempotencyKey,
    parameters: { db_password: "not-in-sqlite-plaintext-value", web_port: 18081 },
    navigation: {
      title: "My Database", url: "https://apps.example.test/database",
      icon: "🗄️", description: "test", groupId: null, openTarget: "_blank" as const,
    },
  };
  const first = new InstallTaskStore(db).reservePrepared(input, key);
  assert.equal(first.created, true);
  assert.equal(first.status, "prepared");
  assert.equal(new InstallTaskStore(db).reservePrepared(input, key).id, first.id);
  assert.equal(new InstallTaskStore(db).reservePrepared({
    ...input, parameters: { web_port: 18081, db_password: input.parameters.db_password },
  }, key).created, false, "parameter key order cannot break idempotency");
  assert.throws(() => new InstallTaskStore(db).reservePrepared({
    ...input, parameters: { ...input.parameters, db_password: "different-secret-value" },
  }, key), /Idempotency key conflicts/);
  assert.throws(() => new InstallTaskStore(db).reservePrepared({
    ...input, navigation: { ...input.navigation, url: "https://different.example.test/" },
  }, key), /Idempotency key conflicts/);
  const row = db.sqlite.prepare(
    "SELECT status, parameters_ref AS parametersRef, navigation_draft_json AS draft FROM install_tasks WHERE id = ?",
  ).get(first.id) as { status: string; parametersRef: string; draft: string };
  assert.equal(row.status, "prepared");
  assert.equal(row.parametersRef, "install_task_inputs:" + first.id);
  assert.equal(JSON.parse(row.draft).url, input.navigation.url);
  const vault = db.sqlite.prepare(
    "SELECT parameters_ciphertext AS encrypted, request_digest AS digest FROM install_task_inputs WHERE task_id = ?",
  ).get(first.id) as { encrypted: SealedInstallParameters; digest: string };
  assert.equal(vault.digest.length, 64);
  assert.equal(vault.encrypted.includes(input.parameters.db_password), false);
  assert.deepEqual({ ...unsealInstallParameters(vault.encrypted, key, first.id, agentId, "postgres-adminer", "1.0.0") },
    input.parameters);
  assert.throws(() => new InstallTaskStore(db).markStarted(first.id), /Invalid install state transition/,
    "prepared intent must never auto-trigger Compose");
  db.close();

  const reopen = openDatabase(file);
  t.after(() => reopen.close());
  const tasks = new InstallTaskStore(reopen);
  assert.equal(tasks.get(first.id)?.status, "prepared");
  assert.equal(tasks.reservePrepared(input, key).created, false);
  const rows = reopen.sqlite.prepare("SELECT COUNT(*) AS n FROM install_tasks").get() as { n: number };
  assert.equal(rows.n, 1);
});

test("T-068: missing/weak vault key cannot save a prepared installation", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const agentId = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(agentId, "nas");
  const input = {
    agentId, templateId: "nginx", templateVersion: "1.0.0", idempotencyKey: randomUUID(),
    parameters: { http_port: 18080 },
    navigation: { title: "Web", url: "https://web.example.test", icon: null, description: null,
      groupId: null, openTarget: "_blank" as const },
  };
  assert.throws(() => new InstallTaskStore(db).reservePrepared(input, Buffer.alloc(16)), /key unavailable/);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM install_tasks").get() as { n: number }).n, 0);
  const valid = new InstallTaskStore(db).reservePrepared(input, randomBytes(32));
  assert.equal(valid.created, true);
  db.sqlite.prepare("DELETE FROM install_tasks WHERE id = ?").run(valid.id);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM install_task_inputs").get() as { n: number }).n, 0,
    "deleting a prepared task must cascade its encrypted secret material");
});
