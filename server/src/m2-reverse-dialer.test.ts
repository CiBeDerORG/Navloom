import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase } from "./db/client.js";
import { privateHost } from "./api/agent-pairing.js";
import { AgentHub } from "./realtime/agent-hub.js";
import { ReverseAgentDialer } from "./realtime/agent-dialer.js";

test("M2 reverse dialer: only private IP literals are eligible for outbound WSS", () => {
  for (const host of ["10.2.3.4", "172.16.0.1", "192.168.1.20", "100.100.10.1", "fd12::1"]) {
    assert.equal(privateHost(host), true, host);
  }
  for (const host of ["8.8.8.8", "127.0.0.1", "169.254.1.1", "nas.example.com", "localhost", "fe80::1", "::1"]) {
    assert.equal(privateHost(host), false, host);
  }
});

test("M2 reverse dialer: no page means no outbound connection; reject untrusted endpoints", () => {
  const db = openDatabase(":memory:");
  migrate(db.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const hub = new AgentHub(db, { heartbeatTimeoutMs: 45_000, sweepIntervalMs: 5000 });
  try {
    const agentId = randomUUID();
    db.sqlite.prepare(
      "INSERT INTO agents (id, name, endpoint_host, endpoint_port, tls_cert_pem, tls_cert_fingerprint) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(agentId, "untrusted", "8.8.8.8", 9443, "not-a-certificate", "f".repeat(64));
    const dialer = new ReverseAgentDialer(db, { certificatePem: "not-a-certificate", keyPem: "not-a-key" }, hub);
    assert.equal(dialer.connectAgent(agentId), false, "must never dial while inactive");
    dialer.setActive(true);
    assert.equal(dialer.connectAgent(agentId), false, "public endpoint must not be dialed");
    db.sqlite.prepare("UPDATE agents SET endpoint_host = '10.2.3.4' WHERE id = ?").run(agentId);
    assert.equal(dialer.connectAgent(agentId), false, "invalid certificate must not be dialed");
    dialer.setActive(false);
    assert.equal(dialer.connectAgent(agentId), false, "must never dial after last page leaves");
  } finally {
    hub.shutdown();
    db.close();
  }
});
