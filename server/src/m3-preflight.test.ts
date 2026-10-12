import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase } from "./db/client.js";
import { ApiFailure } from "./security/access.js";
import { createNavigationDraft, preflightInstall } from "./install/preflight.js";
import { loadBuiltinCatalog } from "./catalog/registry.js";
import { buildApp } from "./app.js";
import { hashPassword } from "./security/password.js";

const templates = loadBuiltinCatalog();
const template = templates.get("postgres-adminer")!;
const inputParameters = { db_password: "redacted-test-password", web_port: 18081 };

test("T-069/T-072: preflight refuses offline/unsupported agents, stale capabilities and conflicting ports", (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  const agentId = randomUUID();
  const now = Date.now();
  db.sqlite.prepare("INSERT INTO agents (id, name, architecture) VALUES (?, 'test-nas', 'amd64')").run(agentId);
  db.sqlite.prepare("INSERT INTO agent_capabilities (agent_id, capabilities_json, checked_at) VALUES (?, ?, ?)")
    .run(agentId, JSON.stringify({
      platform: "linux", architecture: "amd64",
      docker: { available: true, api_version: "1.48", reason: null },
      compose: { available: true, version: "v2.34.0", reason: null },
    }), now);
  db.sqlite.prepare("INSERT INTO agent_inventory_snapshots (agent_id, updated_at, container_count, task_id) VALUES (?, ?, 0, ?)")
    .run(agentId, now, randomUUID());
  const group = randomUUID();
  db.sqlite.prepare("INSERT INTO navigation_groups (id, name) VALUES (?, 'Tools')").run(group);
  const draft = { ...createNavigationDraft(template), groupId: group };
  const payload = { agentId, template, parameters: inputParameters, navigation: draft };
  const check = (online: boolean, override: Partial<typeof payload> = {}) =>
    preflightInstall(db, () => online, { ...payload, ...override });

  assert.throws(() => check(false), (error: unknown) => error instanceof ApiFailure && error.code === "AGENT_OFFLINE");
  const preview = check(true);
  assert.equal(preview.ready, false, "missing URL cannot be treated as installation-ready");
  assert.ok(preview.warnings[0]?.includes("导航 URL"));
  assert.equal(JSON.stringify(preview).includes(inputParameters.db_password), false);
  const valid = check(true, { navigation: { ...draft, url: "https://nas.example.test/admin" } });
  assert.equal(valid.ready, true);
  assert.equal(valid.services.length, 2);
  assert.throws(() => check(true, { navigation: { ...draft, url: "javascript:alert(1)" } }), (error: unknown) =>
    error instanceof ApiFailure && error.code === "INVALID_NAVIGATION");
  assert.throws(() => check(true, { navigation: { ...draft, groupId: randomUUID() } }), (error: unknown) =>
    error instanceof ApiFailure && error.code === "INVALID_NAVIGATION_GROUP");
  assert.throws(() => check(true, { parameters: { ...inputParameters, dangerous: true } }), (error: unknown) =>
    error instanceof ApiFailure && error.code === "INVALID_PARAMS");

  db.sqlite.prepare("INSERT INTO container_inventory (id, agent_id, container_id, name, image, state, ports_json, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), agentId, "a".repeat(64), "occupied", "nginx:alpine", "running",
      JSON.stringify([{ private_port: 80, public_port: 18081, protocol: "tcp", ip: "0.0.0.0" }]), now);
  assert.throws(() => check(true), (error: unknown) =>
    error instanceof ApiFailure && error.code === "PORT_POSSIBLY_USED");
  db.sqlite.prepare("DELETE FROM container_inventory").run();

  db.sqlite.prepare("UPDATE agent_capabilities SET checked_at = 1").run();
  assert.throws(() => check(true), (error: unknown) =>
    error instanceof ApiFailure && error.code === "CAPABILITY_STALE");
  db.sqlite.prepare("UPDATE agent_capabilities SET checked_at = ?").run(now);
  db.sqlite.prepare("UPDATE agent_inventory_snapshots SET updated_at = 1").run();
  assert.throws(() => check(true), (error: unknown) =>
    error instanceof ApiFailure && error.code === "INVENTORY_STALE");
  db.sqlite.prepare("UPDATE agent_inventory_snapshots SET updated_at = ?").run(now);
  db.sqlite.prepare("UPDATE agents SET architecture = 'armv7'").run();
  assert.throws(() => check(true), (error: unknown) =>
    error instanceof ApiFailure && error.code === "ARCH_UNSUPPORTED");
});

test("T-072: admin-only preflight refuses unknown/unauthenticated requests and never creates tasks", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  t.after(() => db.close());
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("m3-preflight-admin-password"), Date.now());
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); });
  const url = "/api/v1/admin/install/preflight";
  const body = { agentId: randomUUID(), templateId: "nginx", templateVersion: "1.0.0",
    parameters: {}, navigation: createNavigationDraft(templates.get("nginx")!) };
  assert.equal((await app.inject({ method: "POST", url, headers: { "x-navloom-csrf": "1" },
    payload: body })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/admin/login",
    headers: { "x-navloom-csrf": "1" },
    payload: { username: "admin", password: "m3-preflight-admin-password" } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"] as string;
  const headers = { cookie, "x-navloom-csrf": "1" };
  assert.equal((await app.inject({ method: "POST", url,
    headers, payload: { ...body, templateVersion: "999.0.0" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: body })).statusCode, 404);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM install_tasks").get() as { n: number }).n, 0);
});
