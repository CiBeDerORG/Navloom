import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { AgentMessageSchema, type AgentCapabilities, type AgentMessage } from "@navloom/contracts";
import { WebSocket } from "ws";
import { openDatabase } from "./db/client.js";
import { AgentTasks } from "./realtime/agent-tasks.js";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function setup(t: import("node:test").TestContext) {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID();
  const b = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas-a");
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "nas-b");
  return { db, a, b };
}

function dummySocket() {
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw: string, callback: (error?: Error) => void) {
      sent.push(JSON.parse(raw) as unknown);
      callback();
    },
  } as unknown as WebSocket;
  return { socket, sent };
}

function result(agentId: string, taskId: string, success = true): Extract<AgentMessage, { type: "task_result" }> {
  const capabilities: AgentCapabilities = {
    platform: "linux", architecture: "amd64",
    docker: { available: false, api_version: null, reason: "socket_missing" },
    compose: { available: false, version: null, reason: "cli_missing" },
  };
  return AgentMessageSchema.parse({
    protocol_version: 2, message_id: randomUUID(), agent_id: agentId,
    sent_at: new Date().toISOString(), type: "task_result", task_id: taskId,
    payload: { success, exit_code: success ? null : 1, ...(success ? { capabilities } : { error: "probe failure" }) },
  }) as Extract<AgentMessage, { type: "task_result" }>;
}

test("T-043/T-044: isolated tasks are idempotent and revoked Agents cannot finish pending work", (t) => {
  const { db, a, b } = setup(t);
  const tasks = new AgentTasks(db);
  const first = dummySocket();
  const taskA = tasks.dispatchCapabilityProbe(a, first.socket);
  assert.equal(tasks.dispatchCapabilityProbe(a, first.socket), taskA, "duplicate dispatch reuses pending task");
  assert.equal(first.sent.length, 1);
  assert.equal(tasks.getTask(taskA)?.status, "sent");

  const completionA = result(a, taskA);
  assert.equal(tasks.acceptResult(b, result(b, taskA)), false, "Agent B cannot complete A's task");
  tasks.markAgentUnknown(a);
  assert.equal(tasks.getTask(taskA)?.status, "unknown", "disconnect is not a false failure");
  assert.equal(tasks.acceptResult(a, completionA), true, "late result from still-trusted Agent is linkable");
  assert.equal(tasks.getTask(taskA)?.status, "succeeded");
  assert.equal(tasks.acceptResult(a, completionA), true, "identical duplicate remains idempotent");

  const altered = { ...completionA, payload: { success: false, exit_code: 1, error: "conflicting result" } };
  assert.equal(tasks.acceptResult(a, altered), false, "conflicting terminal result must be rejected");
  assert.equal(tasks.getTask(taskA)?.status, "succeeded");
  assert.ok(tasks.getCapabilities(a).capabilities);
  assert.equal(tasks.getCapabilities(b).capabilities, null);

  const second = dummySocket();
  const pending = tasks.dispatchCapabilityProbe(a, second.socket);
  assert.notEqual(pending, taskA);
  assert.equal(tasks.getTask(pending)?.status, "sent");
  db.sqlite.prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").run(Date.now(), a);
  tasks.markAgentUnknown(a);
  assert.equal(tasks.acceptResult(a, result(a, pending)), false, "revoked identity cannot submit late results");
  assert.equal(tasks.getTask(pending)?.status, "unknown");
  assert.equal(tasks.acceptResult(a, completionA), false, "even identical replies are refused after revoke");
  assert.equal(tasks.getCapabilities(b).capabilities, null, "revoking A cannot alter B");
});

test("T-044: deadline and Server restart produce unknown without implicit retransmission", async (t) => {
  const { db, a, b } = setup(t);
  const tasks = new AgentTasks(db, 10);
  const aSocket = dummySocket();
  const bSocket = dummySocket();
  const aTask = tasks.dispatchCapabilityProbe(a, aSocket.socket);
  const bTask = tasks.dispatchCapabilityProbe(b, bSocket.socket);
  await wait(20);
  tasks.expire();
  assert.equal(tasks.getTask(aTask)?.status, "unknown");
  assert.equal(tasks.getTask(bTask)?.status, "unknown");
  assert.equal(aSocket.sent.length, 1);
  assert.equal(bSocket.sent.length, 1);
  assert.equal(tasks.acceptResult(a, result(a, aTask)), true);

  // A task which was sent just before Server restart is uncertain.
  const newTask = tasks.dispatchCapabilityProbe(b, bSocket.socket);
  assert.equal(tasks.getTask(newTask)?.status, "sent");
  const restarted = new AgentTasks(db);
  assert.equal(restarted.getTask(newTask)?.status, "unknown");
  assert.equal(bSocket.sent.length, 2, "constructing a recovery manager never replays a task");
  assert.equal(restarted.acceptResult(b, result(b, newTask)), true);
});
