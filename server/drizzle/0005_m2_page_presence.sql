CREATE TABLE `agent_probe_settings` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = 'global'),
  `mode` text NOT NULL CHECK (`mode` IN ('auto', 'manual')),
  `interval_ms` integer NOT NULL CHECK (`interval_ms` BETWEEN 5000 AND 300000),
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `agent_probe_settings` (`id`, `mode`, `interval_ms`, `updated_at`)
VALUES ('global', 'manual', 30000, 0);
