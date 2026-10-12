import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase } from "./db/client.js";
import { InstallStateError, InstallTaskStore } from "./install/tasks.js";

test("T-071/T-073: persisted install tasks are unique per request key across DB reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "navloom-m3-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "install.db");
  const a = randomUUID(), b = randomUUID(), key = randomUUID().replace(/-/g, "") + "a";
  const firstDb = openDatabase(file);
  migrate(firstDb.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  firstDb.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas-a");
  firstDb.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "nas-b");
  const first = new InstallTaskStore(firstDb);
  const request = { agentId: a, templateId: "nginx", templateVersion: "1.0.0", idempotencyKey: key };
  const reserved = first.reserve(request);
  assert.equal(reserved.created, true);
  assert.equal(first.reserve(request).created, false);
  assert.equal(first.reserve(request).id, reserved.id);
  assert.throws(() => first.reserve({ ...request, agentId: b }), InstallStateError);
  assert.throws(() => first.reserve({ ...request, templateVersion: "2.0.0" }), InstallStateError);
  assert.equal(first.get(reserved.id)?.status, "pending");
  firstDb.close();

  const secondDb = openDatabase(file);
  t.after(() => secondDb.close());
  const afterRestart = new InstallTaskStore(secondDb);
  assert.equal(afterRestart.reserve(request).id, reserved.id);
  const started = afterRestart.markStarted(reserved.id);
  assert.equal(started.status, "running");
  assert.equal(afterRestart.markUncertain(reserved.id).status, "unknown");
  assert.throws(() => afterRestart.markStarted(reserved.id), /Invalid install state transition/,
    "unknown must never auto-run a second Docker Compose up");
  assert.equal(afterRestart.reportExit(reserved.id, 0).status, "succeeded");
  assert.equal(afterRestart.reportExit(reserved.id, 0).status, "succeeded",
    "identical Agent result replay is a no-op");
  assert.throws(() => afterRestart.reportExit(reserved.id, 3), /Invalid install state transition/,
    "conflicting late result cannot overwrite recorded success");
});

test("T-071/T-079/T-081: Compose status is exit-code based and failures do not requeue", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas");
  const tasks = new InstallTaskStore(db);
  const input = { agentId: a, templateId: "nginx", templateVersion: "1.0.0" };
  const failed = tasks.reserve({ ...input, idempotencyKey: randomUUID().replace(/-/g, "") });
  assert.throws(() => tasks.reportExit(failed.id, 0), /Invalid install state transition/,
    "cannot mark a task successful before dispatch/start");
  tasks.markStarted(failed.id);
  assert.equal(tasks.reportExit(failed.id, 17).status, "failed");
  assert.equal(tasks.get(failed.id)?.exitCode, 17);
  assert.equal(tasks.reportExit(failed.id, 17).status, "failed");
  assert.throws(() => tasks.markUncertain(failed.id), /Invalid install state transition/);
  assert.throws(() => tasks.reportExit(failed.id, 0), /Invalid install state transition/);

  const unknown = tasks.reserve({ ...input, idempotencyKey: randomUUID().replace(/-/g, "") });
  tasks.markUncertain(unknown.id);
  assert.equal(tasks.reportExit(unknown.id, 1).status, "failed",
    "unknown task can accept a later authenticated nonzero Compose exit code");
  assert.throws(() => tasks.reserve({ ...input, idempotencyKey: "bad" }), /Invalid install task identity/);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM install_tasks").get() as { count: number }).count, 2);
});
