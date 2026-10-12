import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocket } from "ws";
import { AgentMessageSchema, type AgentMessage } from "@navloom/contracts";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/client.js";
import { AgentTasks } from "./realtime/agent-tasks.js";
import { hashPassword } from "./security/password.js";

type Chunk = Extract<AgentMessage, { type: "inventory_chunk" }>;
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
function envelope(agentId: string, taskId: string, type: string, payload: unknown) {
  return AgentMessageSchema.parse({
    protocol_version: 2, agent_id: agentId, task_id: taskId,
    message_id: randomUUID(), sent_at: new Date().toISOString(), type, payload,
  });
}
const container = (id: string, name: string, state = "running") => ({
  container_id: id.repeat(64), name, image: "example/image:1", state,
  ports: [{ private_port: 80, public_port: 8080, protocol: "tcp", ip: "0.0.0.0" }],
  labels: { "com.docker.compose.project": "website" },
  compose_project: "website", compose_service: "web",
});

test("T-048/T-049/T-051: streamed snapshot persists atomically, isolates Agents and handles stopped containers", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID(), b = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas-a");
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "nas-b");
  const tasks = new AgentTasks(db);
  const net = mockSocket();
  const taskId = tasks.dispatchInventoryRefresh(a, net.socket);
  assert.equal(tasks.dispatchInventoryRefresh(a, net.socket), taskId);
  assert.equal(net.sent.length, 1, "same pending inventory refresh is not duplicated");
  assert.equal(tasks.acceptInventoryChunk(b, envelope(b, taskId, "inventory_chunk", {
    sequence: 0, containers: [container("c", "forged")],
  }) as Chunk), false, "Agent B cannot inject records into A");

  assert.equal(tasks.acceptInventoryChunk(a, envelope(a, taskId, "inventory_chunk", {
    sequence: 1, containers: [container("c", "out-of-order")],
  }) as Chunk), false, "out-of-order chunk rejected");
  assert.equal(tasks.acceptInventoryChunk(a, envelope(a, taskId, "inventory_chunk", {
    sequence: 0, containers: [container("a", "running"), container("b", "old-stopped", "exited")],
  }) as Chunk), true);
  assert.equal(tasks.acceptInventoryChunk(a, envelope(a, taskId, "inventory_chunk", {
    sequence: 0, containers: [container("a", "replay")],
  }) as Chunk), false, "duplicate sequence cannot append twice");
  assert.equal(tasks.acceptResult(a, envelope(a, taskId, "task_result", {
    success: true, exit_code: null, inventory_count: 3, inventory_chunks: 1,
  }) as Result), false, "mismatched count does not publish an incomplete snapshot");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM container_inventory").get() as { n: number }).n, 0);
  assert.equal(tasks.acceptResult(a, envelope(a, taskId, "task_result", {
    success: true, exit_code: null, inventory_count: 2, inventory_chunks: 1,
  }) as Result), true);
  const rows = db.sqlite.prepare("SELECT name, state, compose_project AS project FROM container_inventory ORDER BY name").all() as
    Array<{ name: string; state: string; project: string }>;
  assert.deepEqual(rows, [
    { name: "old-stopped", state: "exited", project: "website" },
    { name: "running", state: "running", project: "website" },
  ]);
  const snapshot = db.sqlite.prepare("SELECT container_count AS n FROM agent_inventory_snapshots WHERE agent_id = ?").get(a) as { n: number };
  assert.equal(snapshot.n, 2);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM container_inventory WHERE agent_id = ?").get(b) as { n: number }).n, 0);

  const refreshed = tasks.dispatchInventoryRefresh(a, net.socket);
  assert.equal(tasks.acceptResult(a, envelope(a, refreshed, "task_result", {
    success: true, exit_code: null, inventory_count: 0, inventory_chunks: 0,
  }) as Result), true);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM container_inventory WHERE agent_id = ?").get(a) as { n: number }).n, 0,
    "successful empty scan deletes old rows rather than leaving phantom containers");
});

test("T-049/T-054: failed or interrupted refresh retains the prior successful snapshot", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas");
  db.sqlite.prepare("INSERT INTO container_inventory (id, agent_id, container_id, name, image, state, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), a, "a".repeat(64), "retained", "example:1", "exited", Date.now() - 100000);
  const tasks = new AgentTasks(db);
  const task = tasks.dispatchInventoryRefresh(a, mockSocket().socket);
  assert.equal(tasks.acceptInventoryChunk(a, envelope(a, task, "inventory_chunk", {
    sequence: 0, containers: [container("b", "not-committed")],
  }) as Chunk), true);
  tasks.markAgentUnknown(a);
  assert.equal(tasks.getTask(task)?.status, "unknown");
  assert.equal(tasks.acceptResult(a, envelope(a, task, "task_result", {
    success: true, exit_code: null, inventory_count: 1, inventory_chunks: 1,
  }) as Result), false, "unknown in-flight scan cannot replace historical data");
  const row = db.sqlite.prepare("SELECT name FROM container_inventory WHERE agent_id = ?").get(a) as { name: string };
  assert.equal(row.name, "retained");
});

test("T-052/T-054/T-057: admin-only pool filters and stable Compose association", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const a = randomUUID(), instanceId = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas");
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("admin-password-inventory-123"), Date.now());
  db.sqlite.prepare("INSERT INTO app_instances (id, agent_id, template_id, template_version, compose_project, deployment_path, install_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(instanceId, a, "web", "1", "website", "/isolated/example", randomUUID(), Date.now());
  db.sqlite.prepare("INSERT INTO container_inventory (id, agent_id, container_id, name, image, state, ports_json, labels_json, compose_project, compose_service, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), a, "a".repeat(64), "site-web", "nginx:1", "running", "[]", "{}", "website", "web", Date.now());
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });
  const path = "/api/v1/admin/containers";
  assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login", headers: {
    "x-navloom-csrf": "1", "content-type": "application/json",
  }, payload: { username: "admin", password: "admin-password-inventory-123" } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"] as string;
  const query = await app.inject({ method: "GET", url: path + "?search=site&state=running&agentId=" + a, headers: { cookie } });
  assert.equal(query.statusCode, 200);
  assert.equal(query.json().total, 1);
  assert.equal(query.json().containers[0].instanceId, instanceId);
  assert.equal(query.json().containers[0].historical, true);
  assert.equal(query.json().containers[0].stale, true);
  assert.equal((await app.inject({ method: "GET", url: path + "?state=bogus", headers: { cookie } })).statusCode, 400);
  const association = await app.inject({ method: "GET", url: "/api/v1/admin/app-instances", headers: { cookie } });
  assert.equal(association.json().instances[0].containerCount, 1);
  const zeroPage = await app.inject({ method: "POST", url: "/api/v1/admin/agents/" + a + "/inventory-refresh",
    headers: { cookie, "x-navloom-csrf": "1", "content-type": "application/json" }, payload: {} });
  assert.equal(zeroPage.statusCode, 409, "no active Agent connection means no Docker access");
});
