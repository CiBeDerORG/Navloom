import Fastify, { type FastifyServerOptions } from "fastify";
import { API_VERSION, SystemStatusSchema } from "@navloom/contracts";
import type { DatabaseConnection } from "./db/client.js";
import { ApiFailure } from "./security/access.js";
import { registerM1 } from "./api/register.js";
import { AgentHub, registerAgentTransport } from "./realtime/agent-hub.js";
import type { AgentClientIdentity } from "./realtime/agent-client-identity.js";
import { ReverseAgentDialer } from "./realtime/agent-dialer.js";
import { PagePresence } from "./realtime/page-presence.js";

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies?: { database: DatabaseConnection; secureCookies?: boolean; agentHeartbeatTimeoutMs?: number; agentSweepIntervalMs?: number; agentTaskTimeoutMs?: number; agentClientIdentity?: AgentClientIdentity | null },
) {
  const app = Fastify({ bodyLimit: 64 * 1024, ...options });

  app.get("/api/v1/system/status", async () =>
    SystemStatusSchema.parse({ service: "navloom-server", status: "ok", api_version: API_VERSION }),
  );

  if (dependencies) {
    const hub = new AgentHub(dependencies.database, {
      heartbeatTimeoutMs: dependencies.agentHeartbeatTimeoutMs ?? 45_000,
      sweepIntervalMs: dependencies.agentSweepIntervalMs ?? 5_000,
      taskTimeoutMs: dependencies.agentTaskTimeoutMs ?? 15_000,
    });
    const dialer = new ReverseAgentDialer(dependencies.database, dependencies.agentClientIdentity ?? null, hub);
    const presence = new PagePresence(dependencies.database, dialer, hub);
    registerM1(app, dependencies.database, dependencies.secureCookies ?? false, hub, dependencies.agentClientIdentity?.certificatePem, presence);
    registerAgentTransport(app, dependencies.database, hub, dependencies.secureCookies ?? false, presence);
    app.addHook("onClose", async () => { presence.shutdown(); hub.shutdown(); });
  }

  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    const isExpected = error instanceof ApiFailure;
    if (!isExpected) request.log.error({ err: error }, "request failed");
    const rawStatus = error !== null && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    const statusCode = typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    return reply.status(statusCode).send({
      error: {
        code: isExpected ? error.code : statusCode === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: isExpected ? error.message : statusCode === 500 ? "Internal server error" : "请求不正确",
      },
    });
  });

  return app;
}
