CREATE TABLE `admin_users` (
  `id` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL UNIQUE,
  `password_hash` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `admin_user_id` text NOT NULL,
  `token_hash` text NOT NULL UNIQUE,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer,
  FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `home_access_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `password_hash` text NOT NULL,
  `credential_version` integer NOT NULL DEFAULT 1,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `home_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL UNIQUE,
  `credential_version` integer NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `navigation_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `sort_order` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `navigation_cards` (
  `id` text PRIMARY KEY NOT NULL,
  `group_id` text,
  `title` text NOT NULL,
  `url` text NOT NULL,
  `icon` text,
  `description` text,
  `sort_order` integer NOT NULL DEFAULT 0,
  `link_type` text,
  `link_target_id` text,
  `generated_by_task_id` text UNIQUE,
  FOREIGN KEY (`group_id`) REFERENCES `navigation_groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `agents` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `credential_hash` text,
  `version` text,
  `platform` text,
  `architecture` text,
  `last_seen_at` integer,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `container_inventory` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `container_id` text NOT NULL,
  `name` text NOT NULL,
  `image` text NOT NULL,
  `state` text NOT NULL,
  `ports_json` text NOT NULL DEFAULT '[]',
  `labels_json` text NOT NULL DEFAULT '{}',
  `compose_project` text,
  `compose_service` text,
  `last_seen_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `container_inventory_agent_container_uq` ON `container_inventory` (`agent_id`, `container_id`);
--> statement-breakpoint
CREATE INDEX `container_inventory_agent_idx` ON `container_inventory` (`agent_id`);
--> statement-breakpoint
CREATE TABLE `app_instances` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `template_id` text NOT NULL,
  `template_version` text NOT NULL,
  `compose_project` text NOT NULL,
  `deployment_path` text NOT NULL,
  `install_task_id` text NOT NULL UNIQUE,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_instances_agent_project_uq` ON `app_instances` (`agent_id`, `compose_project`);
--> statement-breakpoint
CREATE TABLE `install_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `template_id` text NOT NULL,
  `template_version` text NOT NULL,
  `idempotency_key` text NOT NULL UNIQUE,
  `status` text NOT NULL DEFAULT 'pending',
  `parameters_ref` text,
  `navigation_draft_json` text,
  `exit_code` integer,
  `error_message` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `task_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `level` text NOT NULL,
  `message` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `install_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_logs_task_sequence_uq` ON `task_logs` (`task_id`, `sequence`);
