import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/client.js";
import { hashPassword } from "./security/password.js";

const csrf = { "x-navloom-csrf": "1" };
const json = { ...csrf, "content-type": "application/json" };
const route = "/api/v1";

test("M1: homepage and admin cookies are isolated, persisted and revocable", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const adminId = randomUUID();
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(adminId, "admin", await hashPassword("admin-password-123"), Date.now());
  db.sqlite.prepare("INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at) VALUES ('global', ?, 1, ?)").run(await hashPassword("1234"), Date.now());
  const app = buildApp({ logger: false }, { database: db, secureCookies: true });
  t.after(async () => { await app.close(); db.close(); });

  const guest = await app.inject({ method: "GET", url: route + "/home/navigation" });
  assert.equal(guest.statusCode, 401);
  const unlock = await app.inject({ method: "POST", url: route + "/auth/home/unlock", headers: json, payload: { passphrase: "1234" } });
  assert.equal(unlock.statusCode, 200);
  const homeCookie = unlock.headers["set-cookie"] as string;
  assert.match(homeCookie, /HttpOnly/);
  assert.match(homeCookie, /Secure/);
  assert.match(homeCookie, /Max-Age=315360000/);
  assert.equal(await (async () => (await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: homeCookie } })).statusCode)(), 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie: homeCookie } })).statusCode, 401);

  const login = await app.inject({ method: "POST", url: route + "/auth/admin/login", headers: json, payload: { username: "admin", password: "admin-password-123" } });
  assert.equal(login.statusCode, 200);
  const adminCookie = login.headers["set-cookie"] as string;
  assert.match(adminCookie, /navloom_admin=/);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie: adminCookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: adminCookie } })).statusCode, 200);

  const revoke = await app.inject({ method: "POST", url: route + "/admin/settings/home/revoke", headers: { ...json, cookie: adminCookie }, payload: {} });
  assert.equal(revoke.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: homeCookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: adminCookie } })).statusCode, 200);

  const logout = await app.inject({ method: "POST", url: route + "/auth/admin/logout", headers: { ...json, cookie: adminCookie }, payload: {} });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie: adminCookie } })).statusCode, 401);
});

test("M1: CSRF and credential brute force protection", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });
  assert.equal((await app.inject({ method: "POST", url: route + "/auth/admin/login", payload: { username: "a", password: "b" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: route + "/auth/admin/login", headers: { ...json, origin: "https://evil.example", host: "localhost:3000" }, payload: { username: "a", password: "b" } })).statusCode, 403);
  for (let i = 0; i < 8; i++) {
    const response = await app.inject({ method: "POST", url: route + "/auth/home/unlock", headers: json, payload: { passphrase: "bad" } });
    assert.equal(response.statusCode, 401);
  }
  assert.equal((await app.inject({ method: "POST", url: route + "/auth/home/unlock", headers: json, payload: { passphrase: "bad" } })).statusCode, 429);
});

test("M1: navigation is independent, ordered and rejects unsafe URLs", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const adminId = randomUUID();
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(adminId, "admin", await hashPassword("admin-password-123"), Date.now());
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });
  const login = await app.inject({ method: "POST", url: route + "/auth/admin/login", headers: json, payload: { username: "admin", password: "admin-password-123" } });
  const cookie = login.headers["set-cookie"] as string;
  const headers = { ...json, cookie };
  const group = await app.inject({ method: "POST", url: route + "/admin/navigation/groups", headers, payload: { name: "工具" } });
  assert.equal(group.statusCode, 201);
  const groupId = group.json().id as string;
  const unsafe = await app.inject({ method: "POST", url: route + "/admin/navigation/cards", headers, payload: { title: "X", url: "javascript:alert(1)" } });
  assert.equal(unsafe.statusCode, 400);
  const first = await app.inject({ method: "POST", url: route + "/admin/navigation/cards", headers, payload: { title: "GitHub", url: "https://github.com", groupId } });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({ method: "POST", url: route + "/admin/navigation/cards", headers, payload: { title: "Local", url: "http://192.168.1.1:8080/" } });
  assert.equal(second.statusCode, 201);
  const firstId = first.json().id as string, secondId = second.json().id as string;
  assert.equal((await app.inject({ method: "PUT", url: route + "/admin/navigation/order", headers, payload: { groups: [groupId], cards: [{ id: secondId, groupId }, { id: firstId, groupId }] } })).statusCode, 200);
  const read = (await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie } })).json();
  assert.deepEqual(read.cards.map((card: { id: string }) => card.id), [secondId, firstId]);
  const deletedGroup = await app.inject({ method: "DELETE", url: route + "/admin/navigation/groups/" + groupId, headers });
  assert.equal(deletedGroup.statusCode, 200);
  assert.equal(deletedGroup.json().movedCards, 2);
  const after = (await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie } })).json();
  assert.equal(after.cards.length, 2);
  assert.equal(after.cards.every((card: { groupId: string | null }) => card.groupId === null), true);
  assert.equal((await app.inject({ method: "DELETE", url: route + "/admin/navigation/cards/" + firstId, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie } })).json().cards.length, 1);
});
