import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiFailure, type Access } from "../security/access.js";
import type { PagePresence } from "../realtime/page-presence.js";

const settingsSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  intervalMs: z.number().int().min(5_000).max(300_000),
}).strict();

export function registerProbeSettings(app: FastifyInstance, access: Access, presence: PagePresence): void {
  app.get("/api/v1/admin/agents/probe-settings", async (request) => {
    access.requireAdmin(request);
    return { ...presence.settings(), activePages: presence.activePages };
  });
  app.patch("/api/v1/admin/agents/probe-settings", async (request) => {
    access.requireAdmin(request);
    const input = settingsSchema.safeParse(request.body);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "检测模式或间隔无效");
    return presence.updateSettings(input.data.mode, input.data.intervalMs);
  });
  app.post("/api/v1/admin/agents/probe", async (request, reply) => {
    access.requireAdmin(request);
    const input = z.object({}).strict().safeParse(request.body);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "检测参数无效");
    if (!presence.activePages) throw new ApiFailure(409, "NO_ACTIVE_PAGE", "没有已登录的在线页面");
    reply.status(202);
    return { sent: presence.probeNow() };
  });
}
