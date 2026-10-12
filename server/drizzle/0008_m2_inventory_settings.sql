CREATE TABLE `agent_inventory_settings` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = 'global'),
  `interval_ms` integer NOT NULL CHECK (`interval_ms` BETWEEN 30000 AND 3600000),
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `agent_inventory_settings` (`id`, `interval_ms`, `updated_at`)
VALUES ('global', 120000, 0);
