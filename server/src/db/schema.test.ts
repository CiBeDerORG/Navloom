import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase } from "./client.js";

test("SQLite migrations are repeatable and enforce inventory uniqueness", () => {
  const directory = mkdtempSync(join(tmpdir(), "navloom-db-test-"));
  const database = openDatabase(join(directory, "test.db"));

  try {
    const migrationsFolder = resolve(process.cwd(), "drizzle");
    migrate(database.orm, { migrationsFolder });
    migrate(database.orm, { migrationsFolder });

    const tables = database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    for (const table of ["admin_users", "navigation_cards", "agents", "container_inventory", "app_instances", "install_tasks", "install_task_inputs", "task_logs"]) {
      assert.equal(names.has(table), true, "missing table " + table);
    }

    database.sqlite.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("a1", "Device 1");
    database.sqlite
      .prepare("INSERT INTO container_inventory (id, agent_id, container_id, name, image, state, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("c1", "a1", "docker-id-1", "demo", "nginx", "running", Date.now());
    assert.throws(() =>
      database.sqlite
        .prepare("INSERT INTO container_inventory (id, agent_id, container_id, name, image, state, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("c2", "a1", "docker-id-1", "duplicate", "nginx", "running", Date.now()),
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
