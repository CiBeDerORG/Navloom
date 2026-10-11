import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/client.js";
import { hashPassword } from "./security/password.js";

const csrf = { "x-navloom-csrf": "1", "content-type": "application/json" };
type Identity = { id: string; credential: string };
const uuid = () => randomUUID();

async function setup(t: TestContext, heartbeatTimeoutMs = 45000, agentSweepIntervalMs = 5000) {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(uuid(), "admin", await hashPassword("test-admin-password-123"), Date.now());
  const app = buildApp({ logger: false }, { database: db, agentHeartbeatTimeoutMs: heartbeatTimeoutMs, agentSweepIntervalMs });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); db.close(); });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login", headers: csrf, payload: {
    username: "admin", password: "test-admin-password-123",
  } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"] as string;
  const createIdentity = (): Identity => {
    const id = uuid();
    const credential = randomBytes(32).toString("base64url");
    db.sqlite.prepare("INSERT INTO agents (id, name, credential_hash, registered_at) VALUES (?, ?, ?, ?)")
      .run(id, "test-nas", createHash("sha256").update(credential).digest("hex"), Date.now());
    return { id, credential };
  };
  const headers = (identity: Identity) => ({
    authorization: "Bearer " + identity.credential,
    "x-navloom-agent-id": identity.id,
    "x-navloom-protocol-version": "1",
  });
  const list = async () => (await app.inject({ method: "GET", url: "/api/v1/admin/agents", headers: { cookie } })).json().agents as Array<{
    id: string; status: string; lastSeenAt: number | null; version: string | null;
  }>;
  return { db, app, address: address.replace(/^http/, "ws") + "/agent", cookie, createIdentity, headers, list };
}

async function dial(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_req, response) => {
      response.resume();
      reject(new Error("HTTP " + response.statusCode));
    });
    socket.once("error", reject);
  });
}

async function closed(socket: WebSocket): Promise<number> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("WebSocket close timed out")); }, 1500);
    socket.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

function message(id: string, type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return {
    protocol_version: 1, message_id: uuid(), agent_id: id, sent_at: new Date().toISOString(), type, payload, ...extras,
  };
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 1200): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("M2 WSS: independent credential handshake, heartbeat and admin online/offline state", async (t) => {
  const { app, address, createIdentity, headers, list, db } = await setup(t);
  const a = createIdentity();
  const b = createIdentity();
  await assert.rejects(dial(address, {}), /HTTP 401/);
  await assert.rejects(dial(address, { ...headers(a), authorization: "Bearer " + b.credential }), /HTTP 401/);
  await assert.rejects(dial(address, { ...headers(a), "x-navloom-protocol-version": "99" }), /HTTP 401/);
  const socket = await dial(address, headers(a));
  t.after(() => socket.terminate());
  await until(async () => (await list()).find((agent) => agent.id === a.id)?.status === "online");
  assert.equal((await list()).find((agent) => agent.id === b.id)?.status, "offline");
  socket.send(JSON.stringify(message(a.id, "hello", { version: "agent-test-1" })));
  socket.send(JSON.stringify(message(a.id, "heartbeat", { uptime_seconds: 42 })));
  await until(async () => (await list()).find((agent) => agent.id === a.id)?.version === "agent-test-1");
  const lastSeen = (await list()).find((agent) => agent.id === a.id)?.lastSeenAt;
  assert.ok(lastSeen && lastSeen > 0);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM agents WHERE id = ?").get(a.id) as { count: number }).count, 1);
  const closing = closed(socket);
  socket.close();
  await closing;
  await until(async () => (await list()).find((agent) => agent.id === a.id)?.status === "offline");
  assert.equal((await list()).find((agent) => agent.id === a.id)?.lastSeenAt, lastSeen);
  await app.ready();
});

test("M2 WSS: duplicate connection replaces old, revoke closes live socket, old credential denied", async (t) => {
  const { app, address, createIdentity, headers, list, cookie } = await setup(t);
  const a = createIdentity();
  const first = await dial(address, headers(a));
  t.after(() => first.terminate());
  const firstClosing = closed(first);
  const second = await dial(address, headers(a));
  t.after(() => second.terminate());
  assert.equal(await firstClosing, 4001);
  await until(async () => (await list()).find((agent) => agent.id === a.id)?.status === "online");
  const secondClosing = closed(second);
  const revoked = await app.inject({ method: "POST", url: "/api/v1/admin/agents/" + a.id + "/revoke", headers: { ...csrf, cookie }, payload: {} });
  assert.equal(revoked.statusCode, 200);
  assert.equal(await secondClosing, 4003);
  assert.equal((await list()).find((agent) => agent.id === a.id)?.status, "revoked");
  await assert.rejects(dial(address, headers(a)), /HTTP 401/);
});

test("M2 WSS: rejects invalid protocol, wrong Agent ID, unknown operations and oversized frames", async (t) => {
  const { address, createIdentity, headers } = await setup(t);
  const a = createIdentity();
  const cases: Array<[string, string, number]> = [
    ["invalid-version", JSON.stringify({ ...message(a.id, "hello", { version: "1" }), protocol_version: 99 }), 1008],
    ["unknown-type", JSON.stringify(message(a.id, "shell", { command: "id" })), 1008],
    ["other-agent", JSON.stringify(message(uuid(), "hello", { version: "1" })), 1008],
    ["invalid-heartbeat", JSON.stringify(message(a.id, "heartbeat", { uptime_seconds: -1 })), 1008],
    ["bad-json", "{", 1007],
    ["oversize", "X".repeat(70 * 1024), 1009],
  ];
  for (const [name, raw, expected] of cases) {
    const socket = await dial(address, headers(a));
    const wait = closed(socket);
    socket.send(raw);
    assert.equal(await wait, expected, name);
  }
});

test("M2 WSS: heartbeat timeout closes stale socket; reconnect uses same persisted identity", async (t) => {
  const { address, createIdentity, headers, list, db } = await setup(t, 100, 20);
  const a = createIdentity();
  const socket = await dial(address, headers(a));
  const wait = closed(socket);
  assert.equal(await wait, 4000);
  assert.equal((await list()).find((agent) => agent.id === a.id)?.status, "offline");
  const reconnect = await dial(address, headers(a));
  t.after(() => reconnect.terminate());
  await until(async () => (await list()).find((agent) => agent.id === a.id)?.status === "online");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number }).count, 1);
});


const capabilities = {
  platform: "linux", architecture: "amd64",
  docker: { available: false, api_version: null, reason: "socket_missing" },
  compose: { available: false, version: null, reason: "cli_missing" },
};

async function dispatchOnHello(socket: WebSocket, agentId: string): Promise<{
  task_id: string; agent_id: string; payload: { operation: string; arguments: unknown };
}> {
  const received = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no capability dispatch")), 1500);
    socket.once("message", (data) => { clearTimeout(timer); resolve(data.toString()); });
  });
  socket.send(JSON.stringify(message(agentId, "hello", { version: "m2-tasks" })));
  const task = JSON.parse(await received) as {
    task_id: string; agent_id: string; payload: { operation: string; arguments: unknown };
  };
  assert.equal(task.agent_id, agentId);
  assert.equal(task.payload.operation, "capability_probe");
  assert.deepEqual(task.payload.arguments, {});
  return task;
}

test("M2 task routing: directed read-only probe, capability persistence, idempotent results", async (t) => {
  const { app, address, cookie, createIdentity, headers, db } = await setup(t);
  const a = createIdentity();
  const b = createIdentity();
  const socketA = await dial(address, headers(a));
  const socketB = await dial(address, headers(b));
  t.after(() => { socketA.terminate(); socketB.terminate(); });
  const [taskA, taskB] = await Promise.all([dispatchOnHello(socketA, a.id), dispatchOnHello(socketB, b.id)]);
  assert.notEqual(taskA.task_id, taskB.task_id);
  const taskPath = "/api/v1/admin/agent-tasks/" + taskA.task_id;
  assert.equal((await app.inject({ method: "GET", url: taskPath })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: taskPath, headers: { cookie } })).json().task.status, "sent");
  const result = message(a.id, "task_result", { success: true, exit_code: null, capabilities }, { task_id: taskA.task_id });
  socketA.send(JSON.stringify(result));
  await until(async () => (await app.inject({ method: "GET", url: taskPath, headers: { cookie } })).json().task.status === "succeeded");
  socketA.send(JSON.stringify({ ...result, message_id: uuid(), payload: { success: false, exit_code: 1, error: "conflicting result" } }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await app.inject({ method: "GET", url: taskPath, headers: { cookie } })).json().task.status, "succeeded");
  const detailA = (await app.inject({ method: "GET", url: "/api/v1/admin/agents/" + a.id, headers: { cookie } })).json().agent;
  const detailB = (await app.inject({ method: "GET", url: "/api/v1/admin/agents/" + b.id, headers: { cookie } })).json().agent;
  assert.deepEqual(detailA.capabilities, capabilities);
  assert.ok(detailA.checkedAt > 0);
  assert.equal(detailB.capabilities, null);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_tasks").get() as { n: number }).n, 2);
  const refreshed = await app.inject({
    method: "POST", url: "/api/v1/admin/agents/" + a.id + "/capability-probe",
    headers: { ...csrf, cookie }, payload: {},
  });
  assert.equal(refreshed.statusCode, 202);
  assert.notEqual(refreshed.json().taskId, taskA.task_id);
  const denied = await app.inject({
    method: "POST", url: "/api/v1/admin/agents/" + a.id + "/capability-probe",
    headers: { ...csrf, cookie }, payload: { operation: "shell", command: "id" },
  });
  assert.equal(denied.statusCode, 400);
  assert.equal((await app.inject({
    method: "POST", url: "/api/v1/admin/agents/" + a.id + "/capability-probe",
    headers: csrf, payload: {},
  })).statusCode, 401);
  assert.equal((await app.inject({
    method: "POST", url: "/api/v1/admin/agents/" + a.id + "/capability-probe",
    headers: { cookie }, payload: {},
  })).statusCode, 403);
});

test("M2 task routing: wrong Agent result rejected, disconnect unknown, late result recovered", async (t) => {
  const { app, address, cookie, createIdentity, headers, db } = await setup(t, 45000, 10);
  const a = createIdentity();
  const b = createIdentity();
  const socketA = await dial(address, headers(a));
  const socketB = await dial(address, headers(b));
  t.after(() => { socketA.terminate(); socketB.terminate(); });
  const [taskA, taskB] = await Promise.all([dispatchOnHello(socketA, a.id), dispatchOnHello(socketB, b.id)]);
  const closeB = closed(socketB);
  socketB.send(JSON.stringify(message(b.id, "task_result", { success: true, exit_code: null, capabilities }, { task_id: taskA.task_id })));
  assert.equal(await closeB, 1008);
  const pathA = "/api/v1/admin/agent-tasks/" + taskA.task_id;
  const pathB = "/api/v1/admin/agent-tasks/" + taskB.task_id;
  assert.equal((await app.inject({ method: "GET", url: pathA, headers: { cookie } })).json().task.status, "sent");
  await until(async () => (await app.inject({ method: "GET", url: pathB, headers: { cookie } })).json().task.status === "unknown");
  const closeA = closed(socketA);
  socketA.close();
  await closeA;
  await until(async () => (await app.inject({ method: "GET", url: pathA, headers: { cookie } })).json().task.status === "unknown");
  const reconnect = await dial(address, headers(a));
  t.after(() => reconnect.terminate());
  const newTask = await dispatchOnHello(reconnect, a.id);
  assert.notEqual(newTask.task_id, taskA.task_id);
  // A late result can be correlated after a disconnect; unknown != failed.
  reconnect.send(JSON.stringify(message(a.id, "task_result", { success: true, exit_code: null, capabilities }, { task_id: taskA.task_id })));
  await until(async () => (await app.inject({ method: "GET", url: pathA, headers: { cookie } })).json().task.status === "succeeded");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_capabilities").get() as { n: number }).n, 1);
});

test("M2 task routing: task timeout stays unknown; missing capabilities and unissued task rejected", async (t) => {
  const { app, address, cookie, createIdentity, headers } = await setup(t, 45000, 15);
  const a = createIdentity();
  const socket = await dial(address, headers(a));
  t.after(() => socket.terminate());
  const task = await dispatchOnHello(socket, a.id);
  const closedPromise = closed(socket);
  socket.send(JSON.stringify(message(a.id, "task_result", { success: true, exit_code: null }, { task_id: task.task_id })));
  assert.equal(await closedPromise, 1008);
  await until(async () => (await app.inject({
    method: "GET", url: "/api/v1/admin/agent-tasks/" + task.task_id, headers: { cookie },
  })).json().task.status === "unknown");
  const offline = await app.inject({
    method: "POST", url: "/api/v1/admin/agents/" + a.id + "/capability-probe",
    headers: { ...csrf, cookie }, payload: {},
  });
  assert.equal(offline.statusCode, 409);
});
