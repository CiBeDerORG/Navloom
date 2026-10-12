ALTER TABLE `agent_tasks` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_idempotency_key_uq` ON `agent_tasks`(`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `agent_task_logs` (
  `task_id` text NOT NULL REFERENCES `agent_tasks`(`id`) ON DELETE CASCADE,
  `sequence` integer NOT NULL,
  `line` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`task_id`, `sequence`)
);
