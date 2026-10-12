import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiFailure, type Access } from "../security/access.js";
import { listTemplateSummaries, loadBuiltinCatalog } from "../catalog/registry.js";

/**
 * v1 catalog is read-only and ships with Navloom. It never downloads or
 * executes third-party templates. Installing is a separate, future M3 flow.
 */
export function registerCatalog(app: FastifyInstance, access: Access): void {
  const catalog = loadBuiltinCatalog();
  app.get("/api/v1/admin/catalog/templates", async (request) => {
    access.requireAdmin(request);
    const input = z.object({
      search: z.string().max(120).optional(),
      category: z.string().max(120).optional(),
    }).strict().safeParse(request.query);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "应用目录查询无效");
    return { templates: listTemplateSummaries(catalog, input.data) };
  });

  app.get("/api/v1/admin/catalog/templates/:id", async (request) => {
    access.requireAdmin(request);
    const input = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/) })
      .strict().safeParse(request.params);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "模板 ID 无效");
    const template = catalog.get(input.data.id);
    if (!template) throw new ApiFailure(404, "TEMPLATE_NOT_FOUND", "应用模板不存在");
    // No submitted or stored user secrets are returned: only input *schemas*
    // and immutable, vetted Compose resources from the local built-in catalog.
    return { template };
  });
}
