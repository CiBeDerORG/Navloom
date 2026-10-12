import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection } from "../db/client.js";
import { ApiFailure, type Access } from "../security/access.js";
import type { AgentHub } from "../realtime/agent-hub.js";

const agentFilter = z.object({
  agentId: z.string().uuid().optional(),
  state: z.enum(["running", "exited", "paused", "restarting", "created", "dead", "unknown"]).optional(),
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
const deviceId = z.object({ id: z.string().uuid() }).strict();

type InventoryRow = {
  id: string; agentId: string; containerId: string; name: string; image: string; state: string;
  portsJson: string; labelsJson: string; composeProject: string | null; composeService: string | null;
  lastSeenAt: number; agentName: string; revokedAt: number | null; snapshotAt: number | null;
  instanceId: string | null;
};
const inventorySelect = `SELECT ci.id, ci.agent_id AS agentId, ci.container_id AS containerId,
 ci.name, ci.image, ci.state, ci.ports_json AS portsJson, ci.labels_json AS labelsJson,
 ci.compose_project AS composeProject, ci.compose_service AS composeService,
 ci.last_seen_at AS lastSeenAt, a.name AS agentName, a.revoked_at AS revokedAt,
 s.updated_at AS snapshotAt, ai.id AS instanceId
 FROM container_inventory ci
 JOIN agents a ON a.id = ci.agent_id
 LEFT JOIN agent_inventory_snapshots s ON s.agent_id = ci.agent_id
 LEFT JOIN app_instances ai ON ai.agent_id = ci.agent_id AND ai.compose_project = ci.compose_project`;

function view(row: InventoryRow, hub: AgentHub) {
  return {
    id: row.id, agentId: row.agentId, containerId: row.containerId,
    agentName: row.agentName, name: row.name, image: row.image, state: row.state,
    ports: JSON.parse(row.portsJson) as unknown, labels: JSON.parse(row.labelsJson) as unknown,
    composeProject: row.composeProject, composeService: row.composeService,
    instanceId: row.instanceId, lastSeenAt: row.lastSeenAt, snapshotAt: row.snapshotAt,
    historical: Boolean(row.revokedAt) || !hub.isOnline(row.agentId),
    stale: !row.snapshotAt || Date.now() - row.snapshotAt > 5 * 60_000,
  };
}

export function registerContainerPool(app: FastifyInstance, db: DatabaseConnection, access: Access, hub: AgentHub): void {
  app.post("/api/v1/admin/agents/:id/inventory-refresh", async (request, reply) => {
    access.requireAdmin(request);
    const id = deviceId.safeParse(request.params);
    if (!id.success || !z.object({}).strict().safeParse(request.body).success) {
      throw new ApiFailure(400, "INVALID_INPUT", "设备或请求参数无效");
    }
    const taskId = hub.requestInventoryRefresh(id.data.id);
    reply.status(202);
    return { taskId };
  });

  app.get("/api/v1/admin/containers", async (request) => {
    access.requireAdmin(request);
    const input = agentFilter.safeParse(request.query);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "容器筛选参数无效");
    const { agentId, state, search, limit, offset } = input.data;
    const conditions = ["1 = 1"];
    const args: Array<string | number> = [];
    if (agentId) { conditions.push("ci.agent_id = ?"); args.push(agentId); }
    if (state) { conditions.push("ci.state = ?"); args.push(state); }
    if (search) {
      conditions.push("(ci.name LIKE ? ESCAPE '\\' OR ci.image LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')");
      const escaped = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
      args.push(escaped, escaped, escaped);
    }
    const where = " WHERE " + conditions.join(" AND ");
    const count = db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM container_inventory ci JOIN agents a ON a.id = ci.agent_id" + where,
    ).get(...args) as { count: number };
    const records = db.sqlite.prepare(inventorySelect + where + " ORDER BY a.name COLLATE NOCASE, ci.name COLLATE NOCASE, ci.id LIMIT ? OFFSET ?")
      .all(...args, limit, offset) as InventoryRow[];
    return { total: count.count, containers: records.map(row => view(row, hub)) };
  });

  app.get("/api/v1/admin/containers/:id", async (request) => {
    access.requireAdmin(request);
    const input = deviceId.safeParse(request.params);
    if (!input.success) throw new ApiFailure(400, "INVALID_INPUT", "容器 ID 无效");
    const record = db.sqlite.prepare(inventorySelect + " WHERE ci.id = ?").get(input.data.id) as InventoryRow | undefined;
    if (!record) throw new ApiFailure(404, "CONTAINER_NOT_FOUND", "容器不存在");
    return { container: view(record, hub) };
  });

  app.get("/api/v1/admin/agent-inventory", async (request) => {
    access.requireAdmin(request);
    const records = db.sqlite.prepare(`SELECT a.id AS agentId, a.name, a.revoked_at AS revokedAt,
      s.updated_at AS updatedAt, s.container_count AS containerCount, s.task_id AS taskId
      FROM agents a LEFT JOIN agent_inventory_snapshots s ON s.agent_id = a.id
      ORDER BY a.name COLLATE NOCASE, a.id`).all() as Array<{
      agentId: string; name: string; revokedAt: number | null; updatedAt: number | null;
      containerCount: number | null; taskId: string | null;
    }>;
    return { agents: records.map(row => ({
      ...row, online: hub.isOnline(row.agentId),
      historical: row.revokedAt !== null || !hub.isOnline(row.agentId),
      stale: row.updatedAt === null || Date.now() - row.updatedAt > 5 * 60_000,
    })) };
  });

  app.get("/api/v1/admin/app-instances", async (request) => {
    access.requireAdmin(request);
    const records = db.sqlite.prepare(`SELECT ai.id, ai.agent_id AS agentId, a.name AS agentName,
      ai.template_id AS templateId, ai.template_version AS templateVersion,
      ai.compose_project AS composeProject, ai.created_at AS createdAt,
      (SELECT COUNT(*) FROM container_inventory ci WHERE ci.agent_id = ai.agent_id
       AND ci.compose_project = ai.compose_project) AS containerCount
      FROM app_instances ai JOIN agents a ON a.id = ai.agent_id
      ORDER BY ai.created_at DESC, ai.id`).all() as Array<{
      id: string; agentId: string; agentName: string; templateId: string;
      templateVersion: string; composeProject: string; createdAt: number; containerCount: number;
    }>;
    return { instances: records };
  });
}
