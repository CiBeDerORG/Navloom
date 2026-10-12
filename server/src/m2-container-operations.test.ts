import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocket } from "ws";
import { AgentMessageSchema, type AgentMessage } from "@navloom/contracts";
import { openDatabase } from "./db/client.js";
import { AgentTasks } from "./realtime/agent-tasks.js";

function socketStub() {
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw: string, callback: (err?: Error) => void) {
      sent.push(JSON.parse(raw) as unknown);
      callback();
    },
  } as unknown as WebSocket;
  return { socket, sent };
}
function response(agentId: string, taskId: string): Extract<AgentMessage, { type: "task_result" }> {
  return AgentMessageSchema.parse({
    protocol_version: 2, message_id: randomUUID(), agent_id: agentId,
    sent_at: new Date().toISOString(), type: "task_result", task_id: taskId,
    payload: { success: true, exit_code: null },
  }) as Extract<AgentMessage, { type: "task_result" }>;
}

test("T-055: durable idempotency prevents duplicate or crash-replayed Docker mutations", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const agentId = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(agentId, "nas");
  const tasks = new AgentTasks(db);
  const peer = socketStub();
  const containerId = "a".repeat(64);
  const requestKey = randomUUID();
  const taskId = tasks.dispatchContainerTask(agentId, "container_restart", containerId, peer.socket, requestKey);
  assert.equal(peer.sent.length, 1);
  assert.equal(tasks.dispatchContainerTask(agentId, "container_restart", containerId, peer.socket, requestKey), taskId);
  assert.equal(peer.sent.length, 1, "identical HTTP retry cannot send a second Docker operation");
  assert.throws(() => tasks.dispatchContainerTask(agentId, "container_stop", containerId, peer.socket, requestKey),
    /Idempotency key/);

  tasks.markAgentUnknown(agentId);
  assert.equal(tasks.getTask(taskId)?.status, "unknown");
  const restarted = new AgentTasks(db);
  assert.equal(restarted.dispatchContainerTask(agentId, "container_restart", containerId, peer.socket, requestKey), taskId);
  assert.equal(peer.sent.length, 1, "restart after uncertain outcome cannot replay side effects");
  assert.equal(restarted.acceptResult(agentId, response(agentId, taskId)), true);
  assert.equal(restarted.getTask(taskId)?.status, "succeeded");
  assert.equal(restarted.acceptResult(agentId, response(agentId, taskId)), true);
  assert.equal(peer.sent.length, 1);
});

test("T-058: logs are ordered, bounded, Agent-isolated, and inaccessible from unrelated tasks", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const a = randomUUID(), b = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "nas-a");
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "nas-b");
  const tasks = new AgentTasks(db);
  const taskId = tasks.dispatchContainerTask(a, "container_logs", "b".repeat(64), socketStub().socket);
  const makeLog = (agentId: string, sequence: number, line: string) =>
    AgentMessageSchema.parse({
      protocol_version: 2, message_id: randomUUID(), agent_id: agentId,
      sent_at: new Date().toISOString(), type: "task_log", task_id: taskId,
      payload: { sequence, line },
    }) as Extract<AgentMessage, { type: "task_log" }>;
  assert.equal(tasks.acceptTaskLog(b, makeLog(b, 0, "intrusion")), false);
  assert.equal(tasks.acceptTaskLog(a, makeLog(a, 0, "hello")), true);
  assert.equal(tasks.acceptTaskLog(a, makeLog(a, 0, "duplicate")), false);
  assert.equal(tasks.acceptTaskLog(a, makeLog(a, 1, "world")), true);
  assert.deepEqual(tasks.getTaskLogs(taskId), [
    { sequence: 0, line: "hello" }, { sequence: 1, line: "world" },
  ]);
  assert.equal(tasks.acceptResult(a, response(a, taskId)), true);
  assert.equal(tasks.acceptTaskLog(a, makeLog(a, 2, "late")), false);
  assert.equal(tasks.getTaskLogs(taskId).length, 2);
});
