import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocket } from "ws";
import { openDatabase } from "./db/client.js";
import { AgentHub } from "./realtime/agent-hub.js";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A protocol peer which sends a valid hello but never responds to Ping. */
class SilentAgent extends EventEmitter {
  readyState = WebSocket.OPEN;
  pings = 0;
  closedWith: number | undefined;
  ping(): void { this.pings++; }
  send(_raw: string, callback: (error?: Error) => void): void { callback(); }
  close(code: number): void {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  terminate(): void { this.close(1001); }
}

test("T-040/T-044/T-047: one outstanding Ping; no Pong closes only that Agent and marks tasks unknown", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const a = randomUUID();
  const b = randomUUID();
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(a, "silent-a");
  db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(b, "healthy-b");
  const hub = new AgentHub(db, { sweepIntervalMs: 5_000, helloTimeoutMs: 500, pongTimeoutMs: 35 });
  t.after(() => { hub.shutdown(); db.close(); });

  const dead = new SilentAgent();
  const healthy = new SilentAgent();
  hub.connect(a, dead as unknown as WebSocket);
  hub.connect(b, healthy as unknown as WebSocket);

  for (const [agentId, socket] of [[a, dead], [b, healthy]] as const) {
    socket.emit("message", Buffer.from(JSON.stringify({
      protocol_version: 2, message_id: randomUUID(), agent_id: agentId,
      sent_at: new Date().toISOString(), type: "hello", payload: { version: "v2-test" },
    })), false);
    assert.equal(hub.isOnline(agentId), true);
  }

  const taskA = hub.requestCapabilityProbe(a);
  const taskB = hub.requestCapabilityProbe(b);
  const lastSeen = (db.sqlite.prepare("SELECT last_seen_at AS seen FROM agents WHERE id = ?").get(a) as { seen: number }).seen;
  assert.equal(hub.probeReverseAll(), 2);
  assert.equal(hub.probeReverseAll(), 0, "no duplicate Ping when a probe is pending");
  assert.equal(dead.pings, 1);
  assert.equal(healthy.pings, 1);

  // Only Agent B responds; Agent A times out, but B remains authenticated.
  healthy.emit("pong");
  await wait(90);
  assert.equal(dead.closedWith, 4000);
  assert.equal(hub.isOnline(a), false);
  assert.equal(hub.isOnline(b), true);
  assert.equal(hub.tasks.getTask(taskA)?.status, "unknown", "timeout does not mean the command failed");
  assert.equal(hub.tasks.getTask(taskB)?.status, "sent", "A disconnect must not alter B's task");
  assert.equal(hub.connectionObservation(a).lastPongAt, null);
  assert.ok(hub.connectionObservation(b).lastPongAt);
  assert.equal((db.sqlite.prepare("SELECT last_seen_at AS seen FROM agents WHERE id = ?").get(a) as { seen: number }).seen,
    lastSeen, "Ping timeout must not write historical heartbeat information");

  dead.emit("pong");
  assert.equal(hub.isOnline(a), false, "stale Pong cannot resurrect a timed-out Agent");
  assert.equal(hub.probeReverseAll(), 1, "subsequent checks affect only the healthy Agent");
  healthy.emit("pong");
});
