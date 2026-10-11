import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection } from "../db/client.js";
import { Access, ApiFailure } from "../security/access.js";

const idSchema = z.string().uuid();
const urlSchema = z.string().trim().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "仅支持 http:// 或 https:// 链接");
const cardSchema = z.object({
  title: z.string().trim().min(1).max(100),
  url: urlSchema,
  icon: z.string().trim().max(512).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  groupId: idSchema.nullable().optional(),
  openTarget: z.enum(["_blank", "_self"]).default("_blank"),
}).strict();
const groupSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const orderSchema = z.object({
  groups: z.array(idSchema),
  cards: z.array(z.object({ id: idSchema, groupId: idSchema.nullable() }).strict()),
}).strict();

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiFailure(400, "INVALID_INPUT", "字段无效：请检查名称、链接及排序数据");
  return result.data;
}

type GroupRow = { id: string; name: string; sortOrder: number };
type CardRow = {
  id: string; groupId: string | null; title: string; url: string; icon: string | null;
  description: string | null; sortOrder: number; openTarget: "_blank" | "_self";
};
const GROUPS = "SELECT id, name, sort_order AS sortOrder FROM navigation_groups ORDER BY sort_order ASC, id ASC";
const CARDS = `SELECT id, group_id AS groupId, title, url, icon, description,
  sort_order AS sortOrder, open_target AS openTarget FROM navigation_cards
  ORDER BY sort_order ASC, id ASC`;

function readAll(db: DatabaseConnection): { groups: GroupRow[]; cards: CardRow[] } {
  return {
    groups: db.sqlite.prepare(GROUPS).all() as GroupRow[],
    cards: db.sqlite.prepare(CARDS).all() as CardRow[],
  };
}

function exists(db: DatabaseConnection, table: "navigation_groups" | "navigation_cards", id: string): boolean {
  return Boolean(db.sqlite.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id));
}

function assertGroup(db: DatabaseConnection, groupId: string | null | undefined): void {
  if (groupId && !exists(db, "navigation_groups", groupId)) {
    throw new ApiFailure(400, "INVALID_GROUP", "导航分组不存在");
  }
}

function paramsId(params: unknown): string {
  const result = z.object({ id: idSchema }).safeParse(params);
  if (!result.success) throw new ApiFailure(400, "INVALID_ID", "ID 格式不正确");
  return result.data.id;
}

export function registerNavigation(app: FastifyInstance, db: DatabaseConnection, access: Access): void {
  app.get("/api/v1/home/navigation", async (request, reply) => {
    access.requireHome(request, reply);
    const data = readAll(db);
    const publicCard = (card: CardRow) => ({
      id: card.id, title: card.title, url: card.url, icon: card.icon,
      description: card.description, openTarget: card.openTarget,
    });
    return {
      groups: data.groups.map((group) => ({
        id: group.id, name: group.name,
        cards: data.cards.filter((card) => card.groupId === group.id).map(publicCard),
      })),
      ungrouped: data.cards.filter((card) => card.groupId === null).map(publicCard),
    };
  });

  app.get("/api/v1/admin/navigation", async (request) => {
    access.requireAdmin(request);
    return readAll(db);
  });

  app.post("/api/v1/admin/navigation/groups", async (request, reply) => {
    access.requireAdmin(request);
    const { name } = parse(groupSchema, request.body);
    const id = randomUUID();
    const max = db.sqlite.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM navigation_groups").get() as { next: number };
    db.sqlite.prepare("INSERT INTO navigation_groups (id, name, sort_order) VALUES (?, ?, ?)").run(id, name, max.next);
    reply.status(201);
    return { id };
  });

  app.patch("/api/v1/admin/navigation/groups/:id", async (request) => {
    access.requireAdmin(request);
    const id = paramsId(request.params);
    const { name } = parse(groupSchema, request.body);
    const result = db.sqlite.prepare("UPDATE navigation_groups SET name = ? WHERE id = ?").run(name, id);
    if (!result.changes) throw new ApiFailure(404, "NOT_FOUND", "分组不存在");
    return { ok: true };
  });

  app.delete("/api/v1/admin/navigation/groups/:id", async (request) => {
    access.requireAdmin(request);
    const id = paramsId(request.params);
    const moved = db.sqlite.transaction(() => {
      const row = db.sqlite.prepare("SELECT COUNT(*) AS count FROM navigation_cards WHERE group_id = ?").get(id) as { count: number };
      const result = db.sqlite.prepare("DELETE FROM navigation_groups WHERE id = ?").run(id);
      if (!result.changes) throw new ApiFailure(404, "NOT_FOUND", "分组不存在");
      // ON DELETE SET NULL preserves every navigation card.
      return row.count;
    })();
    return { ok: true, movedCards: moved };
  });

  app.post("/api/v1/admin/navigation/cards", async (request, reply) => {
    access.requireAdmin(request);
    const card = parse(cardSchema, request.body);
    assertGroup(db, card.groupId);
    const id = randomUUID();
    const max = db.sqlite.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM navigation_cards WHERE group_id IS ?").get(card.groupId ?? null) as { next: number };
    db.sqlite.prepare(
      "INSERT INTO navigation_cards (id, group_id, title, url, icon, description, sort_order, open_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, card.groupId ?? null, card.title, card.url, card.icon ?? null, card.description ?? null, max.next, card.openTarget);
    reply.status(201);
    return { id };
  });

  app.patch("/api/v1/admin/navigation/cards/:id", async (request) => {
    access.requireAdmin(request);
    const id = paramsId(request.params);
    const card = parse(cardSchema, request.body);
    assertGroup(db, card.groupId);
    const result = db.sqlite.prepare(
      "UPDATE navigation_cards SET group_id = ?, title = ?, url = ?, icon = ?, description = ?, open_target = ? WHERE id = ?",
    ).run(card.groupId ?? null, card.title, card.url, card.icon ?? null, card.description ?? null, card.openTarget, id);
    if (!result.changes) throw new ApiFailure(404, "NOT_FOUND", "卡片不存在");
    return { ok: true };
  });

  app.delete("/api/v1/admin/navigation/cards/:id", async (request) => {
    access.requireAdmin(request);
    const id = paramsId(request.params);
    const result = db.sqlite.prepare("DELETE FROM navigation_cards WHERE id = ?").run(id);
    if (!result.changes) throw new ApiFailure(404, "NOT_FOUND", "卡片不存在");
    return { ok: true };
  });

  app.put("/api/v1/admin/navigation/order", async (request) => {
    access.requireAdmin(request);
    const order = parse(orderSchema, request.body);
    db.sqlite.transaction(() => {
      const current = readAll(db);
      const groupIds = new Set(current.groups.map((group) => group.id));
      const cardIds = new Set(current.cards.map((card) => card.id));
      if (
        order.groups.length !== groupIds.size || new Set(order.groups).size !== groupIds.size ||
        order.groups.some((id) => !groupIds.has(id)) ||
        order.cards.length !== cardIds.size || new Set(order.cards.map((card) => card.id)).size !== cardIds.size ||
        order.cards.some((card) => !cardIds.has(card.id) || (card.groupId !== null && !groupIds.has(card.groupId)))
      ) throw new ApiFailure(409, "ORDER_CONFLICT", "导航数据已变化，请刷新后重试");
      const updateGroup = db.sqlite.prepare("UPDATE navigation_groups SET sort_order = ? WHERE id = ?");
      order.groups.forEach((id, index) => updateGroup.run(index, id));
      const updateCard = db.sqlite.prepare("UPDATE navigation_cards SET group_id = ?, sort_order = ? WHERE id = ?");
      const counters = new Map<string | null, number>();
      for (const card of order.cards) {
        const index = counters.get(card.groupId) ?? 0;
        updateCard.run(card.groupId, index, card.id);
        counters.set(card.groupId, index + 1);
      }
    })();
    return { ok: true };
  });
}
