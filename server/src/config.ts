import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1).default("./data/navloom.db"),
  AGENT_CLIENT_CERT_FILE: z.string().default(""),
  AGENT_CLIENT_KEY_FILE: z.string().default(""),
});

export type ServerConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message);
    throw new Error("Invalid Navloom Server configuration: " + reasons.join("; "));
  }
  return result.data;
}
