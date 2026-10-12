import { z } from "zod";
import { AgentCapabilitiesSchema } from "@navloom/contracts";
import type { DatabaseConnection } from "../db/client.js";
import { ApiFailure } from "../security/access.js";
import type { CatalogTemplate } from "../catalog/template.js";
import { renderTrustedCompose } from "../catalog/template.js";

const httpURL = z.string().trim().max(2048).refine((value) => {
  if (value === "") return true; // editable draft, but cannot submit deployment yet
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}, "only http(s) URLs without embedded credentials are allowed");

export const NavigationDraftSchema = z.object({
  title: z.string().trim().min(1).max(100),
  url: httpURL,
  icon: z.string().trim().max(512).nullable(),
  description: z.string().trim().max(500).nullable(),
  groupId: z.string().uuid().nullable(),
  openTarget: z.enum(["_blank", "_self"]),
}).strict();

export type InstallNavigationDraft = z.infer<typeof NavigationDraftSchema>;

export function createNavigationDraft(template: CatalogTemplate): InstallNavigationDraft {
  return {
    title: template.navigation.title, url: template.navigation.url ?? "",
    icon: template.navigation.icon ?? template.icon ?? null,
    description: template.description.slice(0, 500) || null,
    groupId: null, openTarget: "_blank",
  };
}

export type PreflightInput = {
  agentId: string;
  template: CatalogTemplate;
  parameters: Record<string, unknown>;
  navigation: unknown;
};

/**
 * Read-only installation preflight, not permission to dispatch Compose.
 * Reports only safe, public resource metadata and never serializes params.
 */
export function preflightInstall(db: DatabaseConnection,
  isOnline: (id: string) => boolean, input: PreflightInput) {
  const { agentId, template } = input;
  if (!z.string().uuid().safeParse(agentId).success) throw new ApiFailure(400, "INVALID_AGENT", "设备 ID 无效");
  const agent = db.sqlite.prepare(
    "SELECT architecture, revoked_at AS revokedAt FROM agents WHERE id = ?",
  ).get(agentId) as { architecture: string | null; revokedAt: number | null } | undefined;
  if (!agent || agent.revokedAt !== null) throw new ApiFailure(404, "AGENT_NOT_FOUND", "设备不存在或已撤销");
  if (!isOnline(agentId)) throw new ApiFailure(409, "AGENT_OFFLINE", "设备尚未连接，无法准备安装");
  if (!agent.architecture || !template.architectures.includes(agent.architecture as "amd64" | "arm64")) {
    throw new ApiFailure(409, "ARCH_UNSUPPORTED", "设备架构不支持此模板");
  }
  const caps = db.sqlite.prepare(
    "SELECT capabilities_json AS data, checked_at AS checkedAt FROM agent_capabilities WHERE agent_id = ?",
  ).get(agentId) as { data: string; checkedAt: number } | undefined;
  if (!caps || Date.now() - caps.checkedAt > 5 * 60_000) {
    throw new ApiFailure(409, "CAPABILITY_STALE", "设备能力检测已过期，请先刷新");
  }
  const parsedCapabilities: unknown = JSON.parse(caps.data);
  const validated = AgentCapabilitiesSchema.safeParse(parsedCapabilities);
  if (!validated.success || !validated.data.docker.available || !validated.data.compose.available) {
    throw new ApiFailure(409, "COMPOSE_UNAVAILABLE", "目标设备未具备 Docker 与 Compose v2 能力");
  }
  const snapshot = db.sqlite.prepare(
    "SELECT updated_at AS updatedAt FROM agent_inventory_snapshots WHERE agent_id = ?",
  ).get(agentId) as { updatedAt: number } | undefined;
  if (!snapshot || Date.now() - snapshot.updatedAt > 5 * 60_000) {
    throw new ApiFailure(409, "INVENTORY_STALE", "容器清单未刷新，请先完成库存扫描");
  }
  const draftResult = NavigationDraftSchema.safeParse(input.navigation);
  if (!draftResult.success) throw new ApiFailure(400, "INVALID_NAVIGATION", "导航卡片名称或 URL 格式无效");
  const navigation = draftResult.data;
  if (navigation.groupId && !db.sqlite.prepare(
    "SELECT id FROM navigation_groups WHERE id = ?",
  ).get(navigation.groupId)) {
    throw new ApiFailure(400, "INVALID_NAVIGATION_GROUP", "导航分组不存在");
  }
  let compose;
  try {
    compose = renderTrustedCompose(template, input.parameters, "preview1234");
  } catch {
    throw new ApiFailure(400, "INVALID_PARAMS", "安装参数无效，请检查必填项、端口和输入格式");
  }
  const ports = Object.values(compose.services).flatMap((service) => service.ports ?? [])
    .map((line) => {
      const match = /^127\.0\.0\.1:(\d+):\d+\/(tcp|udp)$/.exec(line);
      if (!match) throw new ApiFailure(400, "INVALID_PARAMS", "端口映射不受支持");
      return { hostPort: Number(match[1]), protocol: match[2]! };
    });
  const existing = db.sqlite.prepare(
    "SELECT ports_json AS portsJson FROM container_inventory WHERE agent_id = ?",
  ).all(agentId) as Array<{ portsJson: string }>;
  for (const row of existing) {
    const entries: unknown = JSON.parse(row.portsJson);
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const object = entry as Record<string, unknown>;
      if (ports.some((port) => port.hostPort === object.public_port && port.protocol === object.protocol)) {
        throw new ApiFailure(409, "PORT_POSSIBLY_USED", "目标端口已在已发现容器中使用，请更换端口");
      }
    }
  }
  if (navigation.url === "") {
    // Preview can succeed without inventing a URL from an EasyTier address.
    return { ready: false, warnings: ["导航 URL 尚未设置。请先填写浏览器真正可访问的地址。"],
      templateId: template.id, templateVersion: template.version, agentId,
      navigation, services: Object.entries(compose.services).map(([name, item]) => ({
        name, image: item.image, ports: item.ports ?? [],
      })) };
  }
  return { ready: true, warnings: ["端口预检只能检测最近的 Docker 快照，不能保证实际部署时没有冲突。"],
    templateId: template.id, templateVersion: template.version, agentId,
    navigation, services: Object.entries(compose.services).map(([name, item]) => ({
      name, image: item.image, ports: item.ports ?? [],
    })) };
}
