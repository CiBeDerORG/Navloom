import Fastify, { type FastifyServerOptions } from "fastify";
import { API_VERSION, SystemStatusSchema } from "@navloom/contracts";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get("/api/v1/system/status", async () =>
    SystemStatusSchema.parse({
      service: "navloom-server",
      status: "ok",
      api_version: API_VERSION,
    }),
  );

  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Route not found" },
    }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const statusCode =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message: statusCode === 500 ? "Internal server error" : error.message,
      },
    });
  });

  return app;
}

// M0 intentionally has no admin, navigation, Agent, or Docker management routes.
