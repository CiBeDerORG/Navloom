import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocket } from "ws";
import { AgentMessageSchema, type AgentMessage } from "@navloom/contracts";
import { openDatabase } from "./db/client.js";
import { InstallTaskStore } from "./install/tasks.js";
import { AgentTasks } from "./realtime/agent-tasks.js";
import { renderTrustedCompose } from "./catalog/template.js";
import { loadBuiltinCatalog } from "./catalog/registry.js";
import { buildApp } from "./app.js";
import { hashPassword } from "./security/password.js";

type Result = Extract<AgentMessage, { type: "task_result" }>;
const catalog = loadBuiltinCatalog();
function setup(t: TestContext) {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID(), b = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "one");
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "two");
  const store = new InstallTaskStore(db);
  const prepared = (agentId = a) => store.reservePrepared({
    agentId, templateId: "nginx", templateVersion: "1.0.0",
    idempotencyKey: randomUUID().replace(/-/g, ""),
    parameters: { http_port: 18080 },
    navigation: { title: "Nginx", url: "https://test.example/", icon: null,
      description: null, groupId: null, openTarget: "_blank" },
  }, Buffer.alloc(32, 35)).id;
  const messages: unknown[] = [];
  const socket = { readyState: WebSocket.OPEN, send(raw: string, callback: (err?: Error) => void) {
    messages.push(JSON.parse(raw) as unknown); callback();
  } } as unknown as WebSocket;
  const manifest = renderTrustedCompose(catalog.get("nginx")!, { http_port: 18080 }, "abcdef123456");
  return { db, a, b, store, prepared, messages, socket, manifest };
}
function receipt(agentId: string, taskId: string, status: string, exitCode: number | null, project: string): Result {
  return AgentMessageSchema.parse({
    protocol_version: 2, message_id: randomUUID(), agent_id: agentId,
    sent_at: new Date().toISOString(), type: "task_result", task_id: taskId,
    payload: { success: true, exit_code: null, install_receipt: {
      install_task_id: taskId, status, project, exit_code: exitCode,
    } },
  }) as Result;
}

test("T-074: atomic explicit install activation is one shot, Agent-bound and omits secrets from persisted task metadata", t => {
  const f = setup(t);
  const taskId = f.prepared();
  const tasks = new AgentTasks(f.db);
  assert.throws(() => tasks.dispatchInstallation(f.b, taskId, f.manifest, f.socket), /another Agent/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.store.get(taskId)?.status, "prepared");
  assert.equal(tasks.dispatchInstallation(f.a, taskId, f.manifest, f.socket), taskId);
  assert.equal(f.store.get(taskId)?.status, "running");
  const msg = f.messages[0] as { task_id: string; agent_id: string;
    payload: { operation: string; arguments: { install_task_id: string; manifest: unknown } } };
  assert.equal(msg.task_id, taskId);
  assert.equal(msg.agent_id, f.a);
  assert.equal(msg.payload.operation, "compose_deploy");
  assert.equal(msg.payload.arguments.install_task_id, taskId);
  assert.equal(AgentMessageSchema.safeParse(msg).success, true);
  const row = f.db.sqlite.prepare("SELECT arguments_json AS args FROM agent_tasks WHERE id = ?").get(taskId) as { args: string };
  assert.equal(row.args.includes("manifest"), false);
  assert.equal(row.args.includes("environment"), false);
  assert.throws(() => tasks.dispatchInstallation(f.a, taskId, f.manifest, f.socket), /already activated/);
  assert.equal(f.messages.length, 1);
  const other = f.prepared();
  assert.throws(() => tasks.dispatchInstallation(f.a, other, {
    ...f.manifest, name: "navloom-nginx-fedcba987654",
  }, f.socket), /unresolved/);
  assert.equal(f.store.get(other)?.status, "prepared");
});

test("T-079/T-081: success, failure and unknown receipts respect exit codes without replaying compose", t => {
  const f = setup(t);
  const tasks = new AgentTasks(f.db);
  const goodId = f.prepared();
  tasks.dispatchInstallation(f.a, goodId, f.manifest, f.socket);
  assert.equal(tasks.acceptResult(f.b, receipt(f.b, goodId, "succeeded", 0, f.manifest.name)), false);
  assert.equal(tasks.acceptResult(f.a, receipt(f.a, goodId, "failed", 0, f.manifest.name)), false);
  assert.equal(tasks.acceptResult(f.a, receipt(f.a, goodId, "succeeded", 0,
    "navloom-nginx-00000000")), false);
  const good = receipt(f.a, goodId, "succeeded", 0, f.manifest.name);
  assert.equal(tasks.acceptResult(f.a, good), true);
  assert.equal(f.store.get(goodId)?.status, "succeeded");
  assert.equal(f.store.get(goodId)?.exitCode, 0);
  assert.equal(tasks.acceptResult(f.a, good), true, "identical receipt is idempotent");
  assert.equal(tasks.acceptResult(f.a, receipt(f.a, goodId, "failed", 17, f.manifest.name)), false);

  const failId = f.prepared();
  tasks.dispatchInstallation(f.a, failId, { ...f.manifest, name: "navloom-nginx-11111111" }, f.socket);
  assert.equal(tasks.acceptResult(f.a, receipt(f.a, failId, "failed", 17, "navloom-nginx-11111111")), true);
  assert.equal(f.store.get(failId)?.status, "failed");
  assert.equal(f.store.get(failId)?.exitCode, 17);

  const uncertainId = f.prepared();
  tasks.dispatchInstallation(f.a, uncertainId, { ...f.manifest, name: "navloom-nginx-22222222" }, f.socket);
  tasks.markAgentUnknown(f.a);
  assert.equal(f.store.get(uncertainId)?.status, "unknown");
  assert.throws(() => tasks.dispatchInstallation(f.a, uncertainId,
    { ...f.manifest, name: "navloom-nginx-22222222" }, f.socket), /already activated/);
  assert.equal(f.store.reconcileAgentResult({
    taskId: uncertainId, agentId: f.a, status: "not_found", exitCode: null,
  }).status, "unknown");
  assert.equal(f.store.reconcileAgentResult({
    taskId: uncertainId, agentId: f.a, status: "succeeded", exitCode: 0,
  }).status, "succeeded");
});

test("T-074: a Server restart turns in-flight installs into unknown without resending", t => {
  const f = setup(t);
  const id = f.prepared();
  new AgentTasks(f.db).dispatchInstallation(f.a, id, f.manifest, f.socket);
  assert.equal(f.messages.length, 1);
  new AgentTasks(f.db); // simulated Server restart / crash recovery
  assert.equal(f.store.get(id)?.status, "unknown");
  assert.throws(() => new AgentTasks(f.db).dispatchInstallation(f.a, id, f.manifest, f.socket), /already activated/);
  assert.equal(f.messages.length, 1);
});

test("T-074: remote install is disabled by default even to administrator", async t => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const original = process.env.NAVLOOM_ENABLE_REMOTE_INSTALL;
  delete process.env.NAVLOOM_ENABLE_REMOTE_INSTALL;
  t.after(() => { if (original === undefined) delete process.env.NAVLOOM_ENABLE_REMOTE_INSTALL;
    else process.env.NAVLOOM_ENABLE_REMOTE_INSTALL = original; db.close(); });
  const a = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas");
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("test-m3-explicit-optin-123"), Date.now());
  const task = new InstallTaskStore(db).reservePrepared({
    agentId: a, templateId: "nginx", templateVersion: "1.0.0",
    idempotencyKey: randomUUID().replace(/-/g, ""),
    parameters: { http_port: 18080 },
    navigation: { title: "Nginx", url: "https://test.example/", icon: null,
      description: null, groupId: null, openTarget: "_blank" },
  }, Buffer.alloc(32, 8));
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); });
  const url = "/api/v1/admin/install/tasks/" + task.id + "/activate";
  assert.equal((await app.inject({ method: "POST", url, payload: { confirmation: "DEPLOY" },
    headers: { "x-navloom-csrf": "1" } })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login",
    headers: { "x-navloom-csrf": "1" },
    payload: { username: "admin", password: "test-m3-explicit-optin-123" } });
  const cookie = login.headers["set-cookie"] as string;
  assert.equal((await app.inject({ method: "POST", url, payload: { confirmation: "DEPLOY" },
    headers: { "x-navloom-csrf": "1", cookie } })).statusCode, 503);
  assert.equal(new InstallTaskStore(db).get(task.id)?.status, "prepared");
});
