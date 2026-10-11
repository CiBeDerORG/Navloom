ALTER TABLE `agents` ADD COLUMN `endpoint_host` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `endpoint_port` integer;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `tls_cert_pem` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `tls_cert_fingerprint` text;
