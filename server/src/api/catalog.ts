import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../db/client.js";
import type { AgentHub } from "../realtime/agent-hub.js";
import { preflightInstall } from "../install/preflight.js";
import { z } from "zod";
import { ApiFailure, type Access } from "../security/access.js";
import { listTemplateSummaries, loadBuiltinCatalog } from "../catalog/registry.js";
import { renderTrustedCompose, validateTemplateParameters } from "../catalog/template.js";
import { InstallTaskStore, InstallStateError } from "../install/tasks.js";
import { parseInstallEncryptionKey } from "../install/secrets.js";

/**
 * v1 catalog is read-only and ships with Navloom. It never downloads or
 * executes third-party templates. Installing is a separate, future M3 flow.
 */
export function registerCatalog(app: FastifyInstance, access: Access, db: DatabaseConnection, hub: AgentHub): void {
  const catalog = loadBuiltinCatalog();
  app.post("/api/v1/admin/install/preflight", async (request) => {
    access.requireAdmin(request);
    const input = z.object({
      agentId: z.string().uuid(),
      templateId: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
      templateVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
      parameters: z.record(z.unknown()),
      navigation: z.unknown(),
    }).strict().safeParse(request.body);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "安装预检参数无效");
    const template = catalog.get(input.data.templateId);
    if (!template || template.version !== input.data.templateVersion) {
      throw new ApiFailure(409, "TEMPLATE_VERSION_MISMATCH", "安装模板不存在或版本已改变，请刷新目录");
    }
    return preflightInstall(db, (id) => hub.isOnline(id), {
      agentId: input.data.agentId, template,
      parameters: input.data.parameters,
      navigation: input.data.navigation,
    });
  });

  app.post("/api/v1/admin/install/prepared-tasks", async (request, reply) => {
    access.requireAdmin(request);
    const input = z.object({
      agentId: z.string().uuid(),
      templateId: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
      templateVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
      parameters: z.record(z.unknown()),
      navigation: z.unknown(),
      idempotencyKey: z.string().uuid(),
    }).strict().safeParse(request.body);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "安装草稿参数无效");
    const template = catalog.get(input.data.templateId);
    if (!template || template.version !== input.data.templateVersion) {
      throw new ApiFailure(409, "TEMPLATE_VERSION_MISMATCH", "模板版本已变更，请重新确认");
    }
    // Authentication, capabilities, inventory freshness and URL readiness
    // must all be revalidated server-side on this exact request.
    const checked = preflightInstall(db, (id) => hub.isOnline(id), {
      agentId: input.data.agentId, template,
      parameters: input.data.parameters, navigation: input.data.navigation,
    });
    if (!checked.ready) {
      throw new ApiFailure(409, "NAVIGATION_DRAFT_INCOMPLETE", "请先填写浏览器可访问的导航 URL");
    }
    let key: Buffer;
    try {
      key = parseInstallEncryptionKey(process.env.NAVLOOM_INSTALL_KEY);
    } catch {
      throw new ApiFailure(503, "INSTALL_VAULT_UNCONFIGURED",
        "安装草稿加密密钥尚未配置，不能保存敏感参数");
    }
    try {
      const values = validateTemplateParameters(template, input.data.parameters);
      const result = new InstallTaskStore(db).reservePrepared({
        agentId: input.data.agentId,
        templateId: template.id, templateVersion: template.version,
        idempotencyKey: input.data.idempotencyKey,
        parameters: values, navigation: checked.navigation,
      }, key);
      reply.code(result.created ? 201 : 200);
      return { taskId: result.id, status: result.status, created: result.created,
        dispatched: false, message: "安装草稿已安全保存；尚未执行 Docker Compose" };
    } catch (cause) {
      if (cause instanceof InstallStateError) {
        throw new ApiFailure(409, "INSTALL_KEY_CONFLICT", "安装任务幂等键冲突或目标设备已失效");
      }
      throw cause;
    } finally {
      key.fill(0);
    }
  });

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
  // Parameter validation/preview is deliberately non-executing: it creates no
  // install task, touches no Docker socket, and never reflects secret values.
  app.post("/api/v1/admin/catalog/templates/:id/preview", async (request) => {
    access.requireAdmin(request);
    const params = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/) })
      .strict().safeParse(request.params);
    if (!params.success) throw new ApiFailure(400, "INVALID_INPUT", "模板 ID 无效");
    const template = catalog.get(params.data.id);
    if (!template) throw new ApiFailure(404, "TEMPLATE_NOT_FOUND", "应用模板不存在");
    const body = z.object({ parameters: z.record(z.unknown()) }).strict().safeParse(request.body);
    if (!body.success) throw new ApiFailure(400, "INVALID_PARAMS", "安装参数格式无效");
    let compose;
    try {
      compose = renderTrustedCompose(template, body.data.parameters, "preview1234");
    } catch (cause) {
      // Validator errors only reference vetted parameter IDs, never values.
      throw new ApiFailure(400, "INVALID_PARAMS", cause instanceof Error ? cause.message : "安装参数无效");
    }
    return {
      valid: true,
      project: compose.name,
      // No env value is ever sent back, even if a template author forgot to
      // mark a field as secret. Only keys and non-secret port mappings appear.
      services: Object.entries(compose.services).map(([name, service]) => ({
        name, image: service.image, ports: service.ports ?? [],
        volumes: service.volumes ?? [], environmentKeys: Object.keys(service.environment ?? {}),
      })),
    };
  });

}
