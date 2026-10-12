CREATE TABLE `install_task_inputs` (
  `task_id` text PRIMARY KEY NOT NULL REFERENCES `install_tasks`(`id`) ON DELETE CASCADE,
  `request_digest` text NOT NULL,
  `parameters_ciphertext` text NOT NULL,
  `created_at` integer NOT NULL
);
