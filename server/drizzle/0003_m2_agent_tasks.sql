CREATE TABLE `agent_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `operation` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('sent','unknown','succeeded','failed')),
  `arguments_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `dispatched_at` integer NOT NULL,
  `deadline_at` integer NOT NULL,
  `finished_at` integer,
  `result_json` text,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_tasks_agent_idx` ON `agent_tasks` (`agent_id`);
--> statement-breakpoint
CREATE INDEX `agent_tasks_deadline_idx` ON `agent_tasks` (`status`, `deadline_at`);
--> statement-breakpoint
CREATE TABLE `agent_capabilities` (
  `agent_id` text PRIMARY KEY NOT NULL,
  `capabilities_json` text NOT NULL,
  `checked_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
