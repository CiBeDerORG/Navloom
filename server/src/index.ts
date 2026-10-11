import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";

const config = loadConfig();
const database = openDatabase(config.DATABASE_URL);
const app = buildApp({ logger: { level: "info" } }, {
  database,
  secureCookies: config.NODE_ENV === "production",
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down Navloom Server");
  try {
    await app.close();
  } finally {
    database.close();
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").catch((error: unknown) => {
    app.log.error({ err: error }, "shutdown failed");
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").catch((error: unknown) => {
    app.log.error({ err: error }, "shutdown failed");
    process.exitCode = 1;
  });
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "Navloom Server failed to start");
  database.close();
  process.exitCode = 1;
}
