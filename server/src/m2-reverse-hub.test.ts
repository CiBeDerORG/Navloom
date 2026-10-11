import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocket, WebSocketServer } from "ws";
import { openDatabase } from "./db/client.js";
import { AgentHub } from "./realtime/agent-hub.js";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("T-039: reverse Agent accepts hello, no automatic JSON task/heartbeat, Pong without DB write", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const agentId = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, 'passive-nas')").run(agentId);
  const hub = new AgentHub(db, { heartbeatTimeoutMs: 45, sweepIntervalMs: 10 });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { hub.shutdown(); for (const socket of server.clients) socket.terminate(); await new Promise<void>((done) => server.close(() => done())); db.close(); });
  const accepted = new Promise<void>((done) => server.once("connection", (socket) => {
    hub.connect(agentId, socket, "reverse");
    done();
  }));
  await new Promise<void>((done) => server.once("listening", () => done()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket("ws://127.0.0.1:" + address.port);
  t.after(() => client.terminate());
  await new Promise<void>((done) => client.once("open", () => done()));
  await accepted;
  let unsolicited = 0;
  let pingCount = 0;
  client.on("message", () => unsolicited++);
  client.on("ping", () => pingCount++);
  client.send(JSON.stringify({
    protocol_version: 1,
    message_id: randomUUID(),
    agent_id: agentId,
    sent_at: new Date().toISOString(),
    type: "hello",
    payload: { version: "passive-test" },
  }));
  await wait(30);
  assert.equal(hub.isOnline(agentId), true);
  await wait(90); // > legacy 45ms heartbeat timeout; reverse session must not expire.
  assert.equal(hub.isOnline(agentId), true);
  assert.equal(unsolicited, 0, "no automatic capability probe or JSON heartbeat in reverse mode");
  assert.equal(pingCount, 0, "manual mode does not autonomously Ping");
  const before = (db.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  assert.equal(hub.probeReverseAll(), 1);
  await wait(60);
  assert.equal(pingCount, 1, "only the requested Ping is sent");
  assert.equal(hub.isOnline(agentId), true);
  const after = (db.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  assert.equal(after, before, "Pong must never persist a heartbeat in SQLite");
  client.close();
  await wait(25);
  assert.equal(hub.isOnline(agentId), false);
});
