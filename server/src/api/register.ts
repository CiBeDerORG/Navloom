import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../db/client.js";
import { Access, ApiFailure } from "../security/access.js";
import { registerAuth } from "./auth.js";
import { registerNavigation } from "./navigation.js";

export function registerM1(app: FastifyInstance, db: DatabaseConnection, secureCookies: boolean): void {
  const access = new Access(db, secureCookies);
  // JSON requests require a non-simple header. Cross-site forms cannot send it;
  // cross-origin fetches require CORS preflight, which this server does not allow.
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/v1/") || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    if (request.headers["x-navloom-csrf"] !== "1") {
      throw new ApiFailure(403, "CSRF_REJECTED", "请求缺少安全校验");
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.host !== request.headers.host || !["http:", "https:"].includes(parsed.protocol)) {
          throw new ApiFailure(403, "CSRF_REJECTED", "跨站请求被拒绝");
        }
      } catch {
        throw new ApiFailure(403, "CSRF_REJECTED", "跨站请求被拒绝");
      }
    }
  });
  // Protect the entire admin namespace, including routes added in later milestones.
  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/v1/admin/")) access.requireAdmin(request);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (/^\\/api\\/v1\\/(auth|admin|home)\\//.test(request.url)) {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "no-referrer");
    }
    return payload;
  });
  registerAuth(app, db, access);
  registerNavigation(app, db, access);
}
