ALTER TABLE `agents` ADD COLUMN `registered_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_credential_hash_uq` ON `agents` (`credential_hash`);
--> statement-breakpoint
CREATE TABLE `agent_pair_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL UNIQUE,
  `created_by_admin_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `agent_id` text,
  FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_pair_tokens_expiry_idx` ON `agent_pair_tokens` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `agent_audit_events` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text,
  `event` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
