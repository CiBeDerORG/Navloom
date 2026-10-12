CREATE TABLE `agent_inventory_snapshots` (
  `agent_id` text PRIMARY KEY NOT NULL REFERENCES `agents`(`id`) ON DELETE CASCADE,
  `updated_at` integer NOT NULL,
  `container_count` integer NOT NULL CHECK (`container_count` BETWEEN 0 AND 2000),
  `task_id` text NOT NULL
);
