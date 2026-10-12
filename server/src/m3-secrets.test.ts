import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseInstallEncryptionKey, sealInstallParameters, unsealInstallParameters } from "./install/secrets.js";

test("T-068: install parameters are authenticated, non-deterministic, and bound to exact task/agent/template", () => {
  const key = randomBytes(32);
  const id = randomUUID(), agentId = randomUUID();
  const input = { db_password: "super-private-test-value", web_port: 18081, enabled: true };
  const first = sealInstallParameters(input, key, id, agentId, "postgres-adminer", "1.0.0");
  const second = sealInstallParameters(input, key, id, agentId, "postgres-adminer", "1.0.0");
  assert.notEqual(first, second, "GCM nonce must be fresh");
  assert.ok(!first.includes(input.db_password));
  assert.deepEqual({ ...unsealInstallParameters(first, key, id, agentId, "postgres-adminer", "1.0.0") }, input);
  assert.throws(() => unsealInstallParameters(first, randomBytes(32), id, agentId, "postgres-adminer", "1.0.0"));
  assert.throws(() => unsealInstallParameters(first, key, randomUUID(), agentId, "postgres-adminer", "1.0.0"));
  assert.throws(() => unsealInstallParameters(first, key, id, randomUUID(), "postgres-adminer", "1.0.0"));
  assert.throws(() => unsealInstallParameters(first, key, id, agentId, "nginx", "1.0.0"));
  assert.throws(() => unsealInstallParameters(first, key, id, agentId, "postgres-adminer", "2.0.0"));
  const parts = first.split(":");
  parts[2] = Buffer.from("attacker-changed-payload").toString("base64url");
  assert.throws(() => unsealInstallParameters(parts.join(":") as typeof first, key, id, agentId, "postgres-adminer", "1.0.0"));
});

test("T-068: install encryption key must be supplied explicitly, never weak or silently generated", () => {
  const raw = randomBytes(32);
  assert.deepEqual(parseInstallEncryptionKey(raw.toString("base64url")), raw);
  for (const bad of [undefined, "", "test-key", "a".repeat(44), Buffer.alloc(16).toString("base64url")]) {
    assert.throws(() => parseInstallEncryptionKey(bad));
  }
  assert.throws(() => sealInstallParameters({}, Buffer.alloc(16), randomUUID(), randomUUID(), "nginx", "1.0.0"));
});
