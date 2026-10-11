import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { hashPassword } from "../security/password.js";

const username = (process.env.NAVLOOM_ADMIN_USERNAME ?? "").trim().toLowerCase();
const password = process.env.NAVLOOM_ADMIN_PASSWORD ?? "";
const homePassphrase = process.env.NAVLOOM_HOME_PASSPHRASE ?? "";

if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username) || password.length < 12 || password.length > 256 ||
    homePassphrase.length < 4 || homePassphrase.length > 128) {
  console.error("初始化失败：请提供 NAVLOOM_ADMIN_USERNAME（3～64 位）、NAVLOOM_ADMIN_PASSWORD（至少 12 位）和 NAVLOOM_HOME_PASSPHRASE（至少 4 位）。");
  process.exitCode = 1;
} else {
  const db = openDatabase(loadConfig().DATABASE_URL);
  try {
    const passwordHash = await hashPassword(password);
    const homeHash = await hashPassword(homePassphrase);
    db.sqlite.transaction(() => {
      const count = db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_users").get() as { count: number };
      if (count.count > 0) throw new Error("管理员已初始化；不会覆盖现有账号。");
      const now = Date.now();
      db.sqlite.prepare("INSERT INTO admin_users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), username, passwordHash, now);
      db.sqlite.prepare("INSERT INTO home_access_settings (id, password_hash, credential_version, updated_at) VALUES ('global', ?, 1, ?)").run(homeHash, now);
    })();
    console.info("Navloom 管理员与首页口令已初始化。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "初始化失败");
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
