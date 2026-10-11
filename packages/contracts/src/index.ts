import { z } from "zod";

export const API_VERSION = "v1" as const;
export const AGENT_PROTOCOL_VERSION = 1 as const;

export const SystemStatusSchema = z
  .object({
    service: z.literal("navloom-server"),
    status: z.literal("ok"),
    api_version: z.literal(API_VERSION),
  })
  .strict();
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

// M0 protocol contract only. WSS authentication and dispatch are implemented in M2.
const envelope = {
  protocol_version: z.literal(AGENT_PROTOCOL_VERSION),
  message_id: z.string().uuid(),
  agent_id: z.string().min(1),
  sent_at: z.string().datetime({ offset: true }),
};

export const AgentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("hello"),
    payload: z.object({ version: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("heartbeat"),
    payload: z.object({ uptime_seconds: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("inventory_snapshot"),
    payload: z.object({ containers: z.array(z.unknown()) }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("task_dispatch"),
    task_id: z.string().uuid(),
    payload: z.object({
      operation: z.enum(["container_start", "container_stop", "container_restart", "compose_deploy"]),
      arguments: z.record(z.unknown()),
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("task_log"),
    task_id: z.string().uuid(),
    payload: z.object({ sequence: z.number().int().nonnegative(), line: z.string() }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("task_result"),
    task_id: z.string().uuid(),
    payload: z.object({
      success: z.boolean(),
      exit_code: z.number().int().nullable(),
      error: z.string().optional(),
    }).strict(),
  }).strict(),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
