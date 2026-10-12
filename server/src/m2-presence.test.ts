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

async function setup(
  t: import("node:test").TestContext,
  options: { presenceSweepIntervalMs?: number; presencePongTimeoutMs?: number } = {},
) {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("test-admin-password-123"), Date.now());
  db.sqlite.prepare("INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at) VALUES ('global', ?, 1, ?)")
    .run(await hashPassword("home-pass-1234"), Date.now());
  const app = buildApp({ logger: false }, { database: db, ...options });
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


async function eventually(check: () => Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(20);
  }
  assert.fail("browser presence did not settle before deadline");
}

test("T-040: revoked homepage credentials and admin logout release only their own page sockets", async (t) => {
  const { app, admin, home, getSettings, url, origin } = await setup(t, { presenceSweepIntervalMs: 25 });
  // An admin session must count even on the homepage, without a separate home cookie.
  const homeStatus = await app.inject({ method: "GET", url: "/api/v1/auth/home/status", headers: { cookie: admin } });
  assert.equal(homeStatus.json().authenticated, true);

  const homePage = await connect(url, home, origin);
  const adminPage = await connect(url, admin, origin);
  t.after(() => { homePage.terminate(); adminPage.terminate(); });
  assert.equal((await getSettings()).json().activePages, 2);

  // Revoking a homepage passphrase invalidates the existing browser presence,
  // but must not disconnect an independently authenticated admin page.
  const revoke = await app.inject({ method: "POST", url: "/api/v1/admin/settings/home/revoke",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(revoke.statusCode, 200);
  await eventually(async () => (await getSettings()).json().activePages === 1);
  assert.equal(adminPage.readyState, WebSocket.OPEN);
  await assert.rejects(connect(url, home, origin), /HTTP 401/);

  const logout = await app.inject({ method: "POST", url: "/api/v1/auth/admin/logout",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(logout.statusCode, 200);
  await assert.rejects(connect(url, admin, origin), /HTTP 401/);
  // Logout revokes the original admin cookie. Use a fresh observer session to
  // read global presence, without opening another browser WebSocket.
  const relogin = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login",
    headers: csrf, payload: { username: "admin", password: "test-admin-password-123" } });
  assert.equal(relogin.statusCode, 200);
  const observer = relogin.headers["set-cookie"] as string;
  const observe = () => app.inject({ method: "GET", url: "/api/v1/admin/agents/probe-settings", headers: { cookie: observer } });
  await eventually(async () => (await observe()).json().activePages === 0);
  assert.equal((await observe()).json().mode, "manual", "credential invalidation must not erase global settings");
});

test("T-040: abrupt browser transport failure is removed without a close handshake", async (t) => {
  const { app, admin, getSettings, url, origin } = await setup(t, { presenceSweepIntervalMs: 25 });
  const page = await connect(url, admin, origin);
  t.after(() => page.terminate());
  assert.equal((await getSettings()).json().activePages, 1);
  // Simulate a tab/process crashing rather than orderly navigation.
  page.terminate();
  await eventually(async () => (await getSettings()).json().activePages === 0);
  const noPageProbe = await app.inject({ method: "POST", url: "/api/v1/admin/agents/probe",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(noPageProbe.statusCode, 409, "no logged-in browser means no Agent Ping dispatch");
});


test("T-040/T-047: silent half-open authenticated browser is swept without dropping a responsive tab", async (t) => {
  const { app, admin, home, getSettings, url, origin } = await setup(t, {
    presenceSweepIntervalMs: 20, presencePongTimeoutMs: 80,
  });
  const healthy = await connect(url, home, origin);
  const silent = await connect(url, admin, origin);
  t.after(() => { healthy.terminate(); silent.terminate(); });

  // Leave the TCP/WebSocket connection OPEN but suppress automatic Pong
  // entirely. This is not a normal browser .close() or .terminate().
  let incomingPings = 0;
  silent.on("ping", () => { incomingPings++; });
  silent.pong = (() => {}) as typeof silent.pong;

  assert.equal((await getSettings()).json().activePages, 2);
  await eventually(async () => (await getSettings()).json().activePages === 1);
  assert.ok(incomingPings > 0, "the unresponsive page must have received a server Ping");
  assert.equal(healthy.readyState, WebSocket.OPEN, "a responsive home-only page stays counted");

  const whileHomeOpen = await app.inject({ method: "POST", url: "/api/v1/admin/agents/probe",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(whileHomeOpen.statusCode, 202, "home-only browser may keep connection alive, but cannot edit it");
  healthy.close();
  await new Promise<void>((done) => healthy.once("close", done));
  await eventually(async () => (await getSettings()).json().activePages === 0);
  const withoutAnyPage = await app.inject({ method: "POST", url: "/api/v1/admin/agents/probe",
    headers: { ...csrf, cookie: admin }, payload: {} });
  assert.equal(withoutAnyPage.statusCode, 409, "after the last browser disappears no Agent probe is sent");
});

test("T-040/T-042: admin password rotation drops only admin browser presence while a home tab remains", async (t) => {
  const { app, admin, home, getSettings, url, origin } = await setup(t, {
    presenceSweepIntervalMs: 25,
  });
  const homePage = await connect(url, home, origin);
  const adminPage = await connect(url, admin, origin);
  t.after(() => { homePage.terminate(); adminPage.terminate(); });
  assert.equal((await getSettings()).json().activePages, 2);

  const changed = await app.inject({
    method: "PATCH",
    url: "/api/v1/admin/settings/password",
    headers: { ...csrf, cookie: admin },
    payload: { currentPassword: "test-admin-password-123", newPassword: "rotated-admin-password-456" },
  });
  assert.equal(changed.statusCode, 200);
  await eventually(async () => homePage.readyState === WebSocket.OPEN &&
    adminPage.readyState === WebSocket.CLOSED);

  // Old admin sessions cannot continue administering a live home-only page.
  const oldSettings = await app.inject({
    method: "PATCH", url: "/api/v1/admin/agents/probe-settings",
    headers: { ...csrf, cookie: admin }, payload: { mode: "auto", intervalMs: 5000 },
  });
  assert.equal(oldSettings.statusCode, 401);

  const reLogin = await app.inject({
    method: "POST", url: "/api/v1/auth/admin/login", headers: csrf,
    payload: { username: "admin", password: "rotated-admin-password-456" },
  });
  assert.equal(reLogin.statusCode, 200);
  const newAdmin = reLogin.headers["set-cookie"] as string;
  const observe = () => app.inject({
    method: "GET", url: "/api/v1/admin/agents/probe-settings", headers: { cookie: newAdmin },
  });
  assert.equal((await observe()).json().activePages, 1);
  const homeCannotEdit = await app.inject({
    method: "PATCH", url: "/api/v1/admin/agents/probe-settings",
    headers: { ...csrf, cookie: home }, payload: { mode: "auto", intervalMs: 5000 },
  });
  assert.equal(homeCannotEdit.statusCode, 401);
  homePage.close();
  await new Promise<void>((done) => homePage.once("close", () => done()));
  await eventually(async () => (await observe()).json().activePages === 0);
  assert.equal((await observe()).json().mode, "manual",
    "closing the final page must not rewrite the persisted probe mode");
});

test("T-040/T-041/T-054: zero pages preserves the last Agent result and labels it paused, not offline", async (t) => {
  const { app, db, admin, home, getSettings, url, origin } = await setup(t);
  const agentId = randomUUID();
  const lastSeen = Date.now() - 60_000;
  db.sqlite.prepare(
    "INSERT INTO agents (id, name, endpoint_host, endpoint_port, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(agentId, "historical-nas", "10.10.10.2", 9443, lastSeen);

  const details = async () => {
    const result = await app.inject({
      method: "GET", url: "/api/v1/admin/agents/" + agentId,
      headers: { cookie: admin },
    });
    assert.equal(result.statusCode, 200);
    return result.json().agent as { status: string; lastSeenAt: number; connectedAt: number | null };
  };
  assert.equal((await getSettings()).json().activePages, 0);
  assert.deepEqual(await details(), {
    ...(await details()),
    status: "paused", lastSeenAt: lastSeen, connectedAt: null,
  });

  // A home-only tab counts as a logged-in page. Without an mTLS Server
  // identity the dialer must fail closed rather than fabricate a connection.
  const homePage = await connect(url, home, origin);
  t.after(() => homePage.terminate());
  assert.equal((await getSettings()).json().activePages, 1);
  assert.equal((await details()).lastSeenAt, lastSeen);
  homePage.close();
  await new Promise<void>((done) => homePage.once("close", done));

  assert.equal((await getSettings()).json().activePages, 0);
  const frozen = await details();
  assert.equal(frozen.status, "paused", "absence of a page is not an Agent health failure");
  assert.equal(frozen.lastSeenAt, lastSeen, "closing the last page cannot refresh or erase history");
  assert.equal(frozen.connectedAt, null);
  const denied = await app.inject({
    method: "POST", url: "/api/v1/admin/agents/probe",
    headers: { ...csrf, cookie: admin }, payload: {},
  });
  assert.equal(denied.statusCode, 409, "no page may trigger a manual Agent Ping");
});
