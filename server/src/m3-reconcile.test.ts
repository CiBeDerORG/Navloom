import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocket } from "ws";
import { AgentMessageSchema, type AgentMessage } from "@navloom/contracts";
import { openDatabase } from "./db/client.js";
import { InstallTaskStore } from "./install/tasks.js";
import { AgentTasks } from "./realtime/agent-tasks.js";
import { buildApp } from "./app.js";
import { hashPassword } from "./security/password.js";

type Result = Extract<AgentMessage, { type: "task_result" }>;

function mockSocket() {
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw: string, done: (error?: Error) => void) {
      sent.push(JSON.parse(raw) as unknown);
      done();
    },
  } as unknown as WebSocket;
  return { socket, sent };
}
function result(agentId: string, queryTaskId: string, receipt: unknown): Result {
  return AgentMessageSchema.parse({
    protocol_version: 2, agent_id: agentId, task_id: queryTaskId,
    message_id: randomUUID(), sent_at: new Date().toISOString(), type: "task_result",
    payload: { success: true, exit_code: null, install_receipt: receipt },
  }) as Result;
}

test("T-081: read-only WSS receipt query enforces original Agent and persists confirmed exit", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID(), b = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas-a");
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "nas-b");
  const installed = new InstallTaskStore(db);
  const draft = installed.reservePrepared({
    agentId: a, templateId: "nginx", templateVersion: "1.0.0", idempotencyKey: randomUUID().replace(/-/g, ""),
    parameters: { http_port: 18080 },
    navigation: { title: "Web", url: "https://test.example/", icon: null,
      groupId: null, description: null, openTarget: "_blank" },
  }, Buffer.alloc(32, 5));
  const tasks = new AgentTasks(db);
  const connection = mockSocket();
  assert.throws(() => tasks.dispatchInstallReceiptQuery(a, draft.id, connection.socket), /not eligible/,
    "stored draft must never become executable through reconciliation");
  const install = installed.reserve({
    agentId: a, templateId: "nginx", templateVersion: "1.0.0", idempotencyKey: randomUUID().replace(/-/g, ""),
  });
  installed.markStarted(install.id);
  const queryId = tasks.dispatchInstallReceiptQuery(a, install.id, connection.socket);
  assert.equal(connection.sent.length, 1);
  assert.deepEqual(connection.sent[0], {
    protocol_version: 2, agent_id: a,
    message_id: (connection.sent[0] as { message_id: string }).message_id,
    sent_at: (connection.sent[0] as { sent_at: string }).sent_at,
    task_id: queryId, type: "task_dispatch",
    payload: { operation: "compose_status", arguments: { install_task_id: install.id } },
  });
  const good = {
    install_task_id: install.id, status: "succeeded", project: "navloom-nginx-abcdefgh", exit_code: 0,
  };
  assert.equal(tasks.acceptResult(b, result(b, queryId, good)), false, "forged peer B cannot confirm A task");
  assert.equal(tasks.acceptResult(a, result(a, queryId, {
    ...good, install_task_id: randomUUID(),
  })), false, "WSS query cannot confirm a different install task");
  assert.equal(tasks.acceptResult(a, result(a, queryId, {
    ...good, status: "failed", exit_code: 0,
  })), false, "conflicting exit status is invalid");
  assert.equal(installed.get(install.id)?.status, "running");
  assert.equal(tasks.acceptResult(a, result(a, queryId, good)), true);
  assert.equal(installed.get(install.id)?.status, "succeeded");
  assert.equal(installed.get(install.id)?.exitCode, 0);
  assert.equal(tasks.acceptResult(a, result(a, queryId, good)), true, "identical result replay is harmless");
  assert.equal(tasks.acceptResult(a, result(a, queryId, {
    ...good, status: "failed", exit_code: 17,
  })), false, "a later contradictory report cannot rewrite success");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM install_tasks").get() as { n: number }).n, 2,
    "read-only status query creates no new install tasks or instances");
});

test("T-081: admin-only task metadata hides encrypted inputs and prepared tasks do not execute", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const agentId = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(agentId, "nas");
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("m3-reconcile-admin-password"), Date.now());
  const task = new InstallTaskStore(db).reservePrepared({
    agentId, templateId: "nginx", templateVersion: "1.0.0",
    idempotencyKey: randomUUID().replace(/-/g, ""),
    parameters: { http_port: 18080, private_password: "must-not-appear" },
    navigation: { title: "Web", url: "https://test.example/", icon: null, groupId: null,
      description: null, openTarget: "_blank" },
  }, Buffer.alloc(32, 9));
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });
  const url = "/api/v1/admin/install/tasks/" + task.id;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login",
    headers: { "x-navloom-csrf": "1" },
    payload: { username: "admin", password: "m3-reconcile-admin-password" } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: login.headers["set-cookie"] as string, "x-navloom-csrf": "1" };
  const response = await app.inject({ method: "GET", url, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().task.status, "prepared");
  assert.equal(response.body.includes("must-not-appear"), false);
  assert.equal(response.body.includes("parametersCiphertext"), false);
  const reconcile = await app.inject({ method: "POST", url: url + "/reconcile", headers, payload: {} });
  assert.equal(reconcile.statusCode, 409);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE operation = 'compose_status'").get() as { n: number }).n, 0);
});
