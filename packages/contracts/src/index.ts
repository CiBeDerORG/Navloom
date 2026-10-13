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
  z.object({ operation: z.literal("container_logs"), arguments: z.object({ container_id: containerId }).strict() }).strict(),
  z.object({ operation: z.literal("compose_status"), arguments: z.object({ install_task_id: z.string().uuid() }).strict() }).strict(),
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

export const AgentContainerSchema = z.object({
  container_id: z.string().regex(/^[a-f0-9]{12,64}$/),
  name: z.string().min(1).max(255),
  image: z.string().min(1).max(512),
  state: z.enum(["running", "exited", "paused", "restarting", "created", "dead", "unknown"]),
  ports: z.array(z.object({
    private_port: z.number().int().min(1).max(65535),
    public_port: z.number().int().min(1).max(65535).nullable(),
    protocol: z.enum(["tcp", "udp", "sctp"]),
    ip: z.string().max(64).nullable(),
  }).strict()).max(128),
  labels: z.record(z.string().max(256)).refine(v => Object.keys(v).length <= 16),
  compose_project: z.string().max(128).nullable(),
  compose_service: z.string().max(128).nullable(),
}).strict();
export type AgentContainer = z.infer<typeof AgentContainerSchema>;



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
    type: z.literal("inventory_changed"),
    payload: z.object({
      resource: z.literal("containers"),
      container_id: z.string().regex(/^[a-f0-9]{12,64}$/),
      action: z.enum(["create", "start", "stop", "die", "destroy", "rename", "pause", "unpause", "restart", "update"]),
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    type: z.literal("inventory_chunk"),
    task_id: z.string().uuid(),
    payload: z.object({
      sequence: z.number().int().min(0).max(99),
      containers: z.array(AgentContainerSchema).max(20),
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
      error: z.string().max(300).optional(),
      capabilities: AgentCapabilitiesSchema.optional(),
      inventory_count: z.number().int().min(0).max(2000).optional(),
      inventory_chunks: z.number().int().min(0).max(100).optional(),
      install_receipt: z.object({
        install_task_id: z.string().uuid(),
        status: z.enum(["not_found", "unknown", "succeeded", "failed"]),
        project: z.string().max(63),
        exit_code: z.number().int().min(0).nullable(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
