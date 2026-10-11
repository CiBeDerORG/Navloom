import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { AgentMessageSchema, AGENT_PROTOCOL_VERSION, ApiErrorSchema, SystemStatusSchema } from "@navloom/contracts";
import { buildApp } from "./app.js";

test("server status endpoint follows the shared API contract", async (t) => {
  const app = buildApp({ logger: false });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(response.statusCode, 200);
  assert.equal(SystemStatusSchema.safeParse(response.json()).success, true);
});

test("unknown API routes return a stable error envelope", async (t) => {
  const app = buildApp({ logger: false });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/unknown" });
  assert.equal(response.statusCode, 404);
  assert.equal(ApiErrorSchema.safeParse(response.json()).success, true);
});

test("Agent protocol rejects invalid versions, unknown commands and extra fields", () => {
  const hello = {
    protocol_version: AGENT_PROTOCOL_VERSION,
    message_id: "4b0182c1-9312-4a42-a816-24fdfda39b55",
    agent_id: "agent-1",
    sent_at: "2026-10-11T12:00:00Z",
    type: "hello",
    payload: { version: "m2" },
  };
  assert.equal(AgentMessageSchema.safeParse(hello).success, true);
  assert.equal(AgentMessageSchema.safeParse({ ...hello, protocol_version: 1 }).success, false);
  assert.equal(AgentMessageSchema.safeParse({ ...hello, type: "heartbeat", payload: { uptime_seconds: 30 } }).success, false);
  assert.equal(AgentMessageSchema.safeParse({ ...hello, type: "shell" }).success, false);
  assert.equal(AgentMessageSchema.safeParse({ ...hello, extra: "unexpected" }).success, false);
});

test("shared JSON fixtures agree with the Go Agent protocol", () => {
  const fixtures = resolve(process.cwd(), "../packages/contracts/fixtures");
  const valid = JSON.parse(readFileSync(resolve(fixtures, "hello.valid.json"), "utf8"));
  const invalid = JSON.parse(readFileSync(resolve(fixtures, "hello.invalid-version.json"), "utf8"));
  assert.equal(AgentMessageSchema.safeParse(valid).success, true);
  assert.equal(AgentMessageSchema.safeParse(invalid).success, false);
});
