import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/client.js";
import { hashPassword } from "./security/password.js";

const csrf = { "x-navloom-csrf": "1", "content-type": "application/json" };
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function connect(url: string, cookie: string, origin: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, origin } });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error("HTTP " + response.statusCode));
    });
    socket.once("error", reject);
  });
}

async function setup(t: import("node:test").TestContext) {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("test-admin-password-123"), Date.now());
  db.sqlite.prepare("INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at) VALUES ('global', ?, 1, ?)")
    .run(await hashPassword("home-pass-1234"), Date.now());
  const app = buildApp({ logger: false }, { database: db });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); db.close(); });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login", headers: csrf,
    payload: { username: "admin", password: "test-admin-password-123" } });
  const unlock = await app.inject({ method: "POST", url: "/api/v1/auth/home/unlock", headers: csrf,
    payload: { passphrase: "home-pass-1234" } });
  assert.equal(login.statusCode, 200);
  assert.equal(unlock.statusCode, 200);
  const admin = login.headers["set-cookie"] as string;
  const home = unlock.headers["set-cookie"] as string;
  const getSettings = () => app.inject({ method: "GET", url: "/api/v1/admin/agents/probe-settings", headers: { cookie: admin } });
  return { db, app, admin, home, getSettings, url: address.replace(/^http/, "ws") + "/api/v1/presence", origin: address };
}

test("T-040: presence requires valid home/admin cookie and same-origin browser handshake", async (t) => {
  const { app, admin, home, getSettings, url, origin } = await setup(t);
  await assert.rejects(connect(url, "", origin), /HTTP 401/);
  await assert.rejects(connect(url, home, "https://evil.example"), /HTTP 403/);
  await assert.rejects(connect(url, admin, ""), /HTTP 403/);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/agents/probe-settings", headers: { cookie: home } })).statusCode, 401);
  assert.equal((await getSettings()).json().activePages, 0);
  const first = await connect(url, home, origin);
  t.after(() => first.terminate());
  const second = await connect(url, admin, origin);
  t.after(() => second.terminate());
  assert.equal((await getSettings()).json().activePages, 2);
  const noAdminChange = await app.inject({ method: "PATCH", url: "/api/v1/admin/agents/probe-settings",
    headers: { ...csrf, cookie: home }, payload: { mode: "auto", intervalMs: 5000 } });
  assert.equal(noAdminChange.statusCode, 401);
  const missingCsrf = await app.inject({ method: "PATCH", url: "/api/v1/admin/agents/probe-settings",
    headers: { cookie: admin, "content-type": "application/json" }, payload: { mode: "auto", intervalMs: 5000 } });
  assert.equal(missingCsrf.statusCode, 403);
  first.close();
  await new Promise<void>((done) => first.once("close", () => done()));
  assert.equal((await getSettings()).json().activePages, 1);
  second.close();
  await new Promise<void>((done) => second.once("close", () => done()));
  await wait(15);
  assert.equal((await getSettings()).json().activePages, 0);
});

test("T-039/T-040: manual default, persistent config, global broadcast, no page no Ping", async (t) => {
  const { app, db, admin, home, getSettings, url, origin } = await setup(t);
  assert.equal((await getSettings()).json().mode, "manual");
  const emptyProbe = await app.inject({ method: "POST", url: "/api/v1/admin/agents/probe",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(emptyProbe.statusCode, 409);
  const page = await connect(url, home, origin);
  t.after(() => page.terminate());
  const received: Array<{ type: string; settings: { mode: string; intervalMs: number } }> = [];
  page.on("message", (data) => received.push(JSON.parse(data.toString())));
  const invalid = await app.inject({ method: "PATCH", url: "/api/v1/admin/agents/probe-settings",
    headers: { ...csrf, cookie: admin }, payload: { mode: "auto", intervalMs: 100 } });
  assert.equal(invalid.statusCode, 400);
  const changed = await app.inject({ method: "PATCH", url: "/api/v1/admin/agents/probe-settings",
    headers: { ...csrf, cookie: admin }, payload: { mode: "auto", intervalMs: 5000 } });
  assert.equal(changed.statusCode, 200);
  await wait(20);
  assert.ok(received.some((event) => event.type === "probe_settings" && event.settings.mode === "auto"));
  const stored = db.sqlite.prepare("SELECT mode, interval_ms AS intervalMs FROM agent_probe_settings WHERE id = 'global'").get() as { mode: string; intervalMs: number };
  assert.deepEqual(stored, { mode: "auto", intervalMs: 5000 });
  const ping = await app.inject({ method: "POST", url: "/api/v1/admin/agents/probe",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(ping.statusCode, 202);
  assert.equal(ping.json().sent, 0, "no connected reverse Agents, no traffic");
  page.close();
  await new Promise<void>((done) => page.once("close", () => done()));
  assert.equal((await getSettings()).json().activePages, 0);
  assert.equal((await getSettings()).json().mode, "auto");
});
