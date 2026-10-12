import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { buildApp } from "./app.js";
import { loadBuiltinCatalog, listTemplateSummaries } from "./catalog/registry.js";
import { TemplateSchema, renderTrustedCompose, validateTemplateParameters } from "./catalog/template.js";
import { openDatabase } from "./db/client.js";
import { hashPassword } from "./security/password.js";

test("T-060/T-061/T-064: only audited local YAML manifests enter the versioned catalog", (t) => {
  const catalog = loadBuiltinCatalog();
  assert.deepEqual([...catalog.keys()].sort(), ["nginx", "postgres-adminer"]);
  assert.equal(listTemplateSummaries(catalog, { search: "redis" }).length, 0);
  assert.deepEqual(listTemplateSummaries(catalog, { category: "网络服务" }).map((item) => item.id), ["nginx"]);
  assert.equal(catalog.get("nginx")?.version, "1.0.0");
  assert.equal(catalog.get("postgres-adminer")?.compose.services.length, 2);

  const dir = mkdtempSync(join(tmpdir(), "navloom-m3-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bad.yaml"), "apiVersion: navloom/v1\nid: malicious\ncompose:\n  privileged: true\n");
  assert.throws(() => loadBuiltinCatalog(dir), /Invalid trusted catalog entry/);
  rmSync(join(dir, "bad.yaml"));

  const valid = JSON.stringify(catalog.get("nginx"));
  writeFileSync(join(dir, "one.yaml"), valid);
  writeFileSync(join(dir, "two.yaml"), valid);
  assert.throws(() => loadBuiltinCatalog(dir), /Duplicate trusted template ID/);
  rmSync(join(dir, "two.yaml"));
  assert.equal(loadBuiltinCatalog(dir).size, 1);
  rmSync(join(dir, "one.yaml"));
  symlinkSync(resolve(process.cwd(), "package.json"), join(dir, "external.yaml"));
  assert.throws(() => loadBuiltinCatalog(dir), /Unsafe or oversized trusted catalog entry/);
});

test("T-061/T-062/T-063: invalid params and dangerous Compose overrides are rejected", () => {
  const catalog = loadBuiltinCatalog();
  const nginx = catalog.get("nginx")!;
  const postgres = catalog.get("postgres-adminer")!;

  assert.deepEqual({ ...validateTemplateParameters(nginx, {}) }, { http_port: 18080 });
  assert.throws(() => validateTemplateParameters(nginx, { http_port: "18080" }), /Invalid value/);
  assert.throws(() => validateTemplateParameters(nginx, { http_port: 65536 }), /Invalid value/);
  assert.throws(() => validateTemplateParameters(nginx, { http_port: 22 }), /Invalid value/);
  assert.throws(() => validateTemplateParameters(nginx, { http_port: 18080, privileged: true }), /Unknown/);
  assert.throws(() => validateTemplateParameters(nginx, { http_port: 18080, command: "sh" }), /Unknown/);
  assert.throws(() => validateTemplateParameters(postgres, { web_port: 18081 }), /Missing required/);
  assert.throws(() => validateTemplateParameters(postgres, { db_password: "short" }), /Invalid value/);
  assert.throws(() => validateTemplateParameters(postgres, {
    db_password: "long-enough-password", timezone: "Asia/Evil",
  }), /Invalid value/);

  const compose = renderTrustedCompose(postgres, {
    db_password: "a-tested-password", web_port: 18099,
  }, "abcd1234");
  assert.equal(compose.name, "navloom-postgres-adminer-abcd1234");
  const dbService = compose.services.database!;
  const adminerService = compose.services.adminer!;
  assert.equal(dbService.environment?.POSTGRES_PASSWORD, "a-tested-password");
  assert.deepEqual(adminerService.ports, ["127.0.0.1:18099:8080/tcp"]);
  assert.deepEqual(dbService.volumes, ["postgres-adminer_postgres_data:/var/lib/postgresql/data"]);
  assert.equal(Object.hasOwn(dbService, "command"), false);
  assert.equal(Object.hasOwn(dbService, "privileged"), false);
  assert.equal(Object.hasOwn(dbService, "network_mode"), false);
  assert.throws(() => renderTrustedCompose(nginx, {}, "../bad"), /Invalid installation instance suffix/);
  assert.throws(() => renderTrustedCompose(nginx, { http_port: 18080, image: "evil" }, "abcd1234"), /Unknown/);

  const invalid = structuredClone(nginx);
  invalid.compose.services[0]!.ports[0]!.hostParameter = "not_declared";
  assert.equal(TemplateSchema.safeParse(invalid).success, false);
  const extra = { ...nginx, dockerSocket: "/var/run/docker.sock" };
  assert.equal(TemplateSchema.safeParse(extra).success, false);
  const tampered = structuredClone(postgres);
  tampered.parameters.properties.db_password!.default = "dangerous-secret-in-template";
  assert.equal(TemplateSchema.safeParse(tampered).success, false, "secret defaults must never ship with templates");
});

test("T-065: catalog list and detail are admin-only, readonly and do not leak values", async (t) => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), "admin", await hashPassword("m3-admin-password-123"), Date.now());
  db.sqlite.prepare("INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at) VALUES ('global', ?, 1, ?)")
    .run(await hashPassword("m3-home-password"), Date.now());
  const app = buildApp({ logger: false }, { database: db });
  t.after(async () => { await app.close(); db.close(); });

  const base = "/api/v1/admin/catalog/templates";
  assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 401);
  const home = await app.inject({
    method: "POST", url: "/api/v1/auth/home/unlock",
    headers: { "x-navloom-csrf": "1" }, payload: { passphrase: "m3-home-password" },
  });
  assert.equal(home.statusCode, 200);
  assert.equal((await app.inject({
    method: "GET", url: base, headers: { cookie: home.headers["set-cookie"] as string },
  })).statusCode, 401);

  const login = await app.inject({
    method: "POST", url: "/api/v1/auth/admin/login",
    headers: { "x-navloom-csrf": "1" },
    payload: { username: "admin", password: "m3-admin-password-123" },
  });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: login.headers["set-cookie"] as string };
  const list = await app.inject({ method: "GET", url: base, headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().templates.map((item: { id: string }) => item.id), ["nginx", "postgres-adminer"]);
  assert.equal((await app.inject({ method: "GET", url: base + "?category=%E7%BD%91%E7%BB%9C%E6%9C%8D%E5%8A%A1", headers })).json().templates.length, 1);
  assert.equal((await app.inject({ method: "GET", url: base + "?evil=true", headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: base + "/unknown", headers })).statusCode, 404);
  const detail = await app.inject({ method: "GET", url: base + "/postgres-adminer", headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().template.parameters.properties.db_password.secret, true);
  assert.equal(detail.body.includes("a-tested-password"), false);
  assert.equal((await app.inject({ method: "GET", url: base + "/postgres-adminer" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: base, headers: {
    ...headers, "x-navloom-csrf": "1",
  }, payload: {} })).statusCode, 404, "catalog is read-only; no template-upload endpoint");
});
