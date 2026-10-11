import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadConfig } from "../config.js";
import { openDatabase } from "./client.js";

const config = loadConfig();
const database = openDatabase(config.DATABASE_URL);

try {
  migrate(database.orm, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  console.info("Navloom SQLite migrations applied successfully");
} finally {
  database.close();
}
