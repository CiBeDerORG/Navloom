import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const adminUsers = sqliteTable("admin_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const adminSessions = sqliteTable("admin_sessions", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});
export const homeAccessSettings = sqliteTable("home_access_settings", {
  id: text("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  credentialVersion: integer("credential_version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const homeCredentials = sqliteTable("home_credentials", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  credentialVersion: integer("credential_version").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});
export const navigationGroups = sqliteTable("navigation_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});
export const navigationCards = sqliteTable("navigation_cards", {
  id: text("id").primaryKey(),
  groupId: text("group_id").references(() => navigationGroups.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  url: text("url").notNull(),
  icon: text("icon"),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  openTarget: text("open_target", { enum: ["_blank", "_self"] }).notNull().default("_blank"),
  linkType: text("link_type"),
  linkTargetId: text("link_target_id"),
  generatedByTaskId: text("generated_by_task_id").unique(),
});
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  credentialHash: text("credential_hash"),
  version: text("version"),
  platform: text("platform"),
  architecture: text("architecture"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  registeredAt: integer("registered_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  endpointHost: text("endpoint_host"),
  endpointPort: integer("endpoint_port"),
  tlsCertPem: text("tls_cert_pem"),
  tlsCertFingerprint: text("tls_cert_fingerprint"),
}, (table) => [uniqueIndex("agents_credential_hash_uq").on(table.credentialHash)]);
export const agentPairTokens = sqliteTable("agent_pair_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdByAdminId: text("created_by_admin_id").notNull().references(() => adminUsers.id, { onDelete: "restrict" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
}, (table) => [index("agent_pair_tokens_expiry_idx").on(table.expiresAt)]);
export const agentAuditEvents = sqliteTable("agent_audit_events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  event: text("event").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const containerInventory = sqliteTable("container_inventory", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  containerId: text("container_id").notNull(),
  name: text("name").notNull(),
  image: text("image").notNull(),
  state: text("state").notNull(),
  portsJson: text("ports_json").notNull().default("[]"),
  labelsJson: text("labels_json").notNull().default("{}"),
  composeProject: text("compose_project"),
  composeService: text("compose_service"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("container_inventory_agent_container_uq").on(table.agentId, table.containerId),
  index("container_inventory_agent_idx").on(table.agentId),
]);
export const appInstances = sqliteTable("app_instances", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  templateId: text("template_id").notNull(),
  templateVersion: text("template_version").notNull(),
  composeProject: text("compose_project").notNull(),
  deploymentPath: text("deployment_path").notNull(),
  installTaskId: text("install_task_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("app_instances_agent_project_uq").on(table.agentId, table.composeProject)]);
export const installTasks = sqliteTable("install_tasks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  templateId: text("template_id").notNull(),
  templateVersion: text("template_version").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("pending"),
  parametersRef: text("parameters_ref"),
  navigationDraftJson: text("navigation_draft_json"),
  exitCode: integer("exit_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const installTaskInputs = sqliteTable("install_task_inputs", {
  taskId: text("task_id").primaryKey().references(() => installTasks.id, { onDelete: "cascade" }),
  requestDigest: text("request_digest").notNull(),
  parametersCiphertext: text("parameters_ciphertext").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const taskLogs = sqliteTable("task_logs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => installTasks.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("task_logs_task_sequence_uq").on(table.taskId, table.sequence)]);

export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
  operation: text("operation").notNull(),
  status: text("status").notNull(),
  argumentsJson: text("arguments_json").notNull(),
  idempotencyKey: text("idempotency_key").unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }).notNull(),
  deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  resultJson: text("result_json"),
}, (table) => [index("agent_tasks_agent_idx").on(table.agentId), index("agent_tasks_deadline_idx").on(table.status, table.deadlineAt)]);
export const agentProbeSettings = sqliteTable("agent_probe_settings", {
  id: text("id").primaryKey(),
  mode: text("mode", { enum: ["auto", "manual"] }).notNull(),
  intervalMs: integer("interval_ms").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const agentCapabilities = sqliteTable("agent_capabilities", {
  agentId: text("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  capabilitiesJson: text("capabilities_json").notNull(),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
});

export const agentInventorySnapshots = sqliteTable("agent_inventory_snapshots", {
  agentId: text("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  containerCount: integer("container_count").notNull(),
  taskId: text("task_id").notNull(),
});

export const agentTaskLogs = sqliteTable("agent_task_logs", {
  taskId: text("task_id").notNull().references(() => agentTasks.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  line: text("line").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("agent_task_logs_task_sequence_uq").on(table.taskId, table.sequence)]);

export const agentInventorySettings = sqliteTable("agent_inventory_settings", {
  id: text("id").primaryKey(),
  intervalMs: integer("interval_ms").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
