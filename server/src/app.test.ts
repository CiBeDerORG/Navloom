import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMessageSchema, ApiErrorSchema, SystemStatusSchema } from "@navloom/contracts";
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
  const heartbeat = {
    protocol_version: 1,
    message_id: "4b0182c1-9312-4a42-a816-24fdfda39b55",
    agent_id: "agent-1",
    sent_at: "2026-10-11T12:00:00Z",
    type: "heartbeat",
    payload: { uptime_seconds: 30 },
  };
  assert.equal(AgentMessageSchema.safeParse(heartbeat).success, true);
  assert.equal(AgentMessageSchema.safeParse({ ...heartbeat, protocol_version: 2 }).success, false);
  assert.equal(AgentMessageSchema.safeParse({ ...heartbeat, type: "shell" }).success, false);
  assert.equal(AgentMessageSchema.safeParse({ ...heartbeat, extra: "unexpected" }).success, false);
});
