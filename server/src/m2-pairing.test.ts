import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/client.js";
import { verifyAgentCredential } from "./api/agent-pairing.js";
import { hashPassword } from "./security/password.js";

const api = "/api/v1";
const json = { "x-navloom-csrf": "1", "content-type": "application/json" };
const details = { name: "nas-1", version: "0.1.0-m2", platform: "linux", architecture: "amd64" };

async function setup(t: import("node:test").TestContext) {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("admin-password-123"), Date.now());
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });
  const login = await app.inject({ method: "POST", url: api + "/auth/admin/login", headers: json, payload: {
    username: "admin", password: "admin-password-123",
  } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"] as string;
  return { app, db, cookie };
}

test("M2: only admin can issue short-lived hashed single-use tokens; no secrets leak in lists", async (t) => {
  const { app, db, cookie } = await setup(t);
  assert.equal((await app.inject({ method: "POST", url: api + "/admin/agents/pair-tokens", headers: json, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: api + "/admin/agents/pair-tokens", headers: { ...json, cookie, origin: "https://evil.example", host: "localhost:3000" }, payload: {} })).statusCode, 403);
  const issued = await app.inject({ method: "POST", url: api + "/admin/agents/pair-tokens", headers: { ...json, cookie }, payload: {} });
  assert.equal(issued.statusCode, 201);
  assert.match(issued.headers["cache-control"] as string, /no-store/);
  const { token, expiresAt } = issued.json() as { token: string; expiresAt: string };
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  const row = db.sqlite.prepare("SELECT token_hash AS hash, used_at AS usedAt FROM agent_pair_tokens").get() as { hash: string; usedAt: number | null };
  assert.equal(row.usedAt, null);
  assert.equal(row.hash.includes(token), false);
  assert.equal((await app.inject({ method: "GET", url: api + "/admin/agents", headers: { cookie } })).json().agents.length, 0);
  const paired = await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token, ...details } });
  assert.equal(paired.statusCode, 201);
  const { agentId, credential } = paired.json() as { agentId: string; credential: string };
  assert.equal(verifyAgentCredential(db, agentId, credential), true);
  assert.equal(verifyAgentCredential(db, agentId, "A".repeat(43)), false);
  assert.equal(verifyAgentCredential(db, randomUUID(), credential), false);
  assert.equal((await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token, ...details } })).statusCode, 401);
  const devices = await app.inject({ method: "GET", url: api + "/admin/agents", headers: { cookie } });
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.json().agents[0].status, "offline");
  assert.equal(devices.body.includes(credential), false);
  assert.equal(devices.body.includes("credentialHash"), false);
  assert.equal(devices.body.includes(token), false);
  const stored = db.sqlite.prepare("SELECT credential_hash AS hash, registered_at AS registeredAt FROM agents WHERE id = ?").get(agentId) as { hash: string; registeredAt: number };
  assert.equal(stored.hash.includes(credential), false);
  assert.ok(stored.registeredAt > 0);
  assert.deepEqual(
    (db.sqlite.prepare("SELECT event FROM agent_audit_events ORDER BY rowid").all() as Array<{ event: string }>).map((x) => x.event),
    ["pair_token_issued", "paired", "pair_rejected"],
  );
});

test("M2: expired and malformed tokens are rejected and failed attempts are limited", async (t) => {
  const { app, db, cookie } = await setup(t);
  const issued = await app.inject({ method: "POST", url: api + "/admin/agents/pair-tokens", headers: { ...json, cookie }, payload: {} });
  const token = issued.json().token as string;
  db.sqlite.prepare("UPDATE agent_pair_tokens SET expires_at = 1").run();
  assert.equal((await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token, ...details } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token: "bad", ...details } })).statusCode, 401);
  for (let i = 0; i < 6; i++) {
    assert.equal((await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token: "bad", ...details } })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token: "bad", ...details } })).statusCode, 429);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number }).count, 0);
});

test("M2: admin rename/revoke persists; homepage credential cannot manage devices", async (t) => {
  const { app, db, cookie } = await setup(t);
  const issued = await app.inject({ method: "POST", url: api + "/admin/agents/pair-tokens", headers: { ...json, cookie }, payload: {} });
  const paired = await app.inject({ method: "POST", url: api + "/agent/pair", headers: json, payload: { token: issued.json().token, ...details } });
  const { agentId, credential } = paired.json() as { agentId: string; credential: string };
  assert.equal((await app.inject({ method: "GET", url: api + "/admin/agents" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PATCH", url: api + "/admin/agents/" + agentId, headers: json, payload: { name: "hijacked" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "PATCH", url: api + "/admin/agents/" + agentId, headers: { ...json, cookie }, payload: { name: "nas-renamed" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: api + "/admin/agents", headers: { cookie } })).json().agents[0].name, "nas-renamed");
  assert.equal((await app.inject({ method: "POST", url: api + "/admin/agents/" + agentId + "/revoke", headers: { ...json, cookie }, payload: {} })).statusCode, 200);
  assert.equal(verifyAgentCredential(db, agentId, credential), false);
  assert.equal((await app.inject({ method: "POST", url: api + "/admin/agents/" + agentId + "/revoke", headers: { ...json, cookie }, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: api + "/admin/agents", headers: { cookie } })).json().agents[0].status, "revoked");
  assert.throws(() => db.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run(agentId, "duplicate"));
});
