import Fastify, { type FastifyServerOptions } from "fastify";
import { API_VERSION, SystemStatusSchema } from "@navloom/contracts";
import type { DatabaseConnection } from "./db/client.js";
import { ApiFailure } from "./security/access.js";
import { registerM1 } from "./api/register.js";

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies?: { database: DatabaseConnection; secureCookies?: boolean },
) {
  const app = Fastify({ bodyLimit: 64 * 1024, ...options });

  app.get("/api/v1/system/status", async () =>
    SystemStatusSchema.parse({ service: "navloom-server", status: "ok", api_version: API_VERSION }),
  );

  if (dependencies) registerM1(app, dependencies.database, dependencies.secureCookies ?? false);

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
