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
  assert.equal((await app.inject({ method: "PATCH", url: route + "/admin/navigation/groups/" + groupId, headers, payload: { name: "常用工具" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: route + "/admin/navigation/cards/" + firstId, headers, payload: {
    title: "GitHub Docs", url: "https://docs.github.com", groupId, icon: "📚",
    description: "开发文档", openTarget: "_self",
  } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: route + "/admin/navigation/order", headers, payload: { groups: [groupId], cards: [] } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PUT", url: route + "/admin/navigation/order", headers, payload: { groups: [groupId], cards: [{ id: secondId, groupId }, { id: firstId, groupId }] } })).statusCode, 200);
  const read = (await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie } })).json();
  assert.deepEqual(read.cards.map((card: { id: string }) => card.id), [secondId, firstId]);
  assert.equal(read.groups[0].name, "常用工具");
  assert.equal(read.cards[1].title, "GitHub Docs");
  const publicResponse = await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie } });
  assert.equal(publicResponse.statusCode, 200);
  const publicCard = publicResponse.json().groups[0].cards[1];
  assert.equal(publicCard.title, "GitHub Docs");
  assert.equal(publicCard.openTarget, "_self");
  assert.equal(Object.hasOwn(publicCard, "groupId"), false);
  assert.equal(Object.hasOwn(publicCard, "linkTargetId"), false);
  const deletedGroup = await app.inject({ method: "DELETE", url: route + "/admin/navigation/groups/" + groupId, headers: { ...csrf, cookie } });
  assert.equal(deletedGroup.statusCode, 200);
  assert.equal(deletedGroup.json().movedCards, 2);
  const after = (await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie } })).json();
  assert.equal(after.cards.length, 2);
  assert.equal(after.cards.every((card: { groupId: string | null }) => card.groupId === null), true);
  assert.equal((await app.inject({ method: "DELETE", url: route + "/admin/navigation/cards/" + firstId, headers: { ...csrf, cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie } })).json().cards.length, 1);
});

test("M1: changing both passwords revokes existing cookies and requires new credentials", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const adminId = randomUUID();
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(adminId, "admin", await hashPassword("initial-admin-password"), Date.now());
  db.sqlite.prepare("INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at) VALUES ('global', ?, 1, ?)").run(await hashPassword("initial-home"), Date.now());
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });

  const homeLogin = await app.inject({ method: "POST", url: route + "/auth/home/unlock", headers: json, payload: { passphrase: "initial-home" } });
  const homeCookie = homeLogin.headers["set-cookie"] as string;
  assert.equal(homeLogin.statusCode, 200);
  const adminLogin = await app.inject({ method: "POST", url: route + "/auth/admin/login", headers: json, payload: { username: "admin", password: "initial-admin-password" } });
  const adminCookie = adminLogin.headers["set-cookie"] as string;
  assert.equal(adminLogin.statusCode, 200);

  const updateHome = await app.inject({ method: "PATCH", url: route + "/admin/settings/home-passphrase", headers: { ...json, cookie: adminCookie }, payload: { passphrase: "new-home-passphrase" } });
  assert.equal(updateHome.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: homeCookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: route + "/auth/home/unlock", headers: json, payload: { passphrase: "initial-home" } })).statusCode, 401);
  const newHome = await app.inject({ method: "POST", url: route + "/auth/home/unlock", headers: json, payload: { passphrase: "new-home-passphrase" } });
  assert.equal(newHome.statusCode, 200);
  const newHomeCookie = newHome.headers["set-cookie"] as string;

  const changeAdmin = await app.inject({ method: "PATCH", url: route + "/admin/settings/password", headers: { ...json, cookie: adminCookie }, payload: { currentPassword: "initial-admin-password", newPassword: "new-admin-password-123" } });
  assert.equal(changeAdmin.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie: adminCookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: route + "/auth/admin/login", headers: json, payload: { username: "admin", password: "initial-admin-password" } })).statusCode, 401);
  const newAdmin = await app.inject({ method: "POST", url: route + "/auth/admin/login", headers: json, payload: { username: "admin", password: "new-admin-password-123" } });
  assert.equal(newAdmin.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: newHomeCookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: route + "/admin/navigation", headers: { cookie: newAdmin.headers["set-cookie"] as string } })).statusCode, 200);

  // Expired tokens are rejected even when the browser still sends the cookie.
  db.sqlite.prepare("UPDATE home_credentials SET expires_at = 0").run();
  assert.equal((await app.inject({ method: "GET", url: route + "/home/navigation", headers: { cookie: newHomeCookie } })).statusCode, 401);
  const hash = db.sqlite.prepare("SELECT password_hash AS hash FROM home_access_settings WHERE id = 'global'").get() as { hash: string };
  assert.equal(hash.hash.includes("new-home-passphrase"), false);
});
