import { z } from "zod";

export const API_VERSION = "v1" as const;
export const AGENT_PROTOCOL_VERSION = 2 as const;

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

// The only executable command in this M2 batch is the read-only capability probe.
// Other typed operations are reserved and MUST stay disabled until their own
// authenticated, idempotent Docker/Compose implementations have been reviewed.
const containerId = z.string().regex(/^[a-f0-9]{12,64}$/);
export const AgentCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capability_probe"), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal("inventory_refresh"), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal("container_start"), arguments: z.object({ container_id: containerId }).strict() }).strict(),
  z.object({ operation: z.literal("container_stop"), arguments: z.object({ container_id: containerId }).strict() }).strict(),
  z.object({ operation: z.literal("container_restart"), arguments: z.object({ container_id: containerId }).strict() }).strict(),
  z.object({
    operation: z.literal("compose_deploy"),
    arguments: z.object({
      template_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      compose_project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    }).strict(),
  }).strict(),
]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const AgentCapabilitiesSchema = z.object({
  platform: z.string().min(1).max(40),
  architecture: z.string().min(1).max(40),
  docker: z.object({
    available: z.boolean(),
    api_version: z.string().max(40).nullable(),
    reason: z.enum(["socket_missing", "permission_denied", "daemon_unreachable", "unsupported_host", "version_unavailable"]).nullable(),
  }).strict(),
  compose: z.object({
    available: z.boolean(),
    version: z.string().max(80).nullable(),
    reason: z.enum(["cli_missing", "compose_unavailable", "timeout"]).nullable(),
  }).strict(),
}).strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;


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
    type: z.literal("inventory_snapshot"),
    payload: z.object({ containers: z.array(z.unknown()) }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("task_dispatch"),
    task_id: z.string().uuid(),
    payload: AgentCommandSchema,
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
      error: z.string().max(300).optional(),
      capabilities: AgentCapabilitiesSchema.optional(),
    }).strict(),
  }).strict(),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
