import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const temp = mkdtempSync(join(tmpdir(), "navloom-reverse-e2e-"));
const children = [];
const password = "isolated-reverse-ci-admin-password-123";
const homePassphrase = "isolated-reverse-home-passphrase";
let base = "";

function privateIP() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family !== "IPv4" || item.internal) continue;
      const parts = item.address.split(".").map(Number);
      const [a, b] = parts;
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return item.address;
    }
  }
  throw new Error("No private IPv4 interface available for isolated reverse WSS test");
}

async function unusedPort(host) {
  return await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("no port")); return; }
      server.close(() => done(addr.port));
    });
  });
}

async function until(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; }
    catch { /* starting */ }
    await delay(120);
  }
  throw new Error("Reverse mTLS WSS integration condition timed out");
}

async function call(path, method = "GET", body, cookie = "") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(method !== "GET" ? { "x-navloom-csrf": "1", "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error("HTTP " + response.status + " on " + path + ": " + JSON.stringify(payload.error ?? {}));
  return { payload, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function page(cookie) {
  return await new Promise((done, reject) => {
    const socket = new WebSocket(base.replace(/^http/, "ws") + "/api/v1/presence", {
      headers: { cookie, origin: base },
    });
    socket.once("open", () => done(socket));
    socket.once("unexpected-response", (_req, response) => {
      response.resume();
      reject(new Error("presence HTTP " + response.statusCode));
    });
    socket.once("error", reject);
  });
}

async function closePage(socket) {
  const closed = new Promise((done) => socket.once("close", done));
  socket.close();
  await Promise.race([closed, delay(2000)]);
  socket.terminate();
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  const host = privateIP();
  const serverPort = await unusedPort("127.0.0.1");
  const agentPort = await unusedPort(host);
  base = "http://127.0.0.1:" + serverPort;
  const clientCert = join(temp, "server-client.pem");
  const clientKey = join(temp, "server-client.key");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "2",
    "-keyout", clientKey, "-out", clientCert,
    "-subj", "/CN=Navloom isolated CI Server",
    "-addext", "extendedKeyUsage=clientAuth",
  ], { stdio: "pipe" });
  chmodSync(clientKey, 0o600);
  const env = {
    ...process.env, DATABASE_URL: join(temp, "navloom.db"), HOST: "127.0.0.1",
    PORT: String(serverPort), NODE_ENV: "test",
    AGENT_CLIENT_CERT_FILE: clientCert, AGENT_CLIENT_KEY_FILE: clientKey,
    NAVLOOM_ADMIN_USERNAME: "admin", NAVLOOM_ADMIN_PASSWORD: password,
    NAVLOOM_HOME_PASSPHRASE: homePassphrase,
  };
  execFileSync("npm", ["run", "db:migrate"], { env, stdio: "pipe" });
  execFileSync("npm", ["run", "admin:init", "-w", "@navloom/server"], { env, stdio: "pipe" });
  const server = spawn("node", ["server/dist/index.js"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let serverErrors = "";
  server.stderr.on("data", (data) => { serverErrors += String(data).slice(-2000); });
  children.push(server);
  try {
    await until(async () => (await call("/api/v1/system/status")).payload.status === "ok");
  } catch (error) {
    throw new Error("Server startup failed: " + serverErrors.slice(-1500), { cause: error });
  }
  const login = await call("/api/v1/auth/admin/login", "POST", { username: "admin", password });
  const cookie = login.cookie;
  const home = await call("/api/v1/auth/home/unlock", "POST", { passphrase: homePassphrase });
  const homeCookie = home.cookie;
  assert.ok(cookie.startsWith("navloom_admin="));
  assert.ok(homeCookie.startsWith("navloom_home="));

  const binary = resolve(temp, "navloom-agent");
  execFileSync("go", ["build", "-o", binary, "./cmd/navloom-agent"], { cwd: resolve("agent"), stdio: "pipe" });
  const cfg = join(temp, "agent-config.json");
  const tokenFile = join(temp, "agent-identity.json");
  writeFileSync(cfg, JSON.stringify({
    server_url: "ws://127.0.0.1:" + serverPort + "/agent",
    allow_insecure_dev: true,
    agent_name: "isolated-reverse-nas",
    token_file: tokenFile,
    endpoint_host: host,
    endpoint_port: agentPort,
    tls_cert_file: join(temp, "agent.pem"),
    tls_key_file: join(temp, "agent.key"),
  }));
  execFileSync(binary, ["-config", cfg, "-init-tls"], { stdio: "pipe" });
  const issued = await call("/api/v1/admin/agents/pair-tokens", "POST", {}, cookie);
  const paired = spawnSync(binary, ["-config", cfg, "-pair"], {
    input: issued.payload.token + "\n", encoding: "utf8",
  });
  assert.equal(paired.status, 0, "Agent pairing failed: " + (paired.stderr ?? "").slice(-500));
  const identity = JSON.parse(readFileSync(tokenFile, "utf8"));
  assert.ok(identity.server_client_certificate_pem?.includes("BEGIN CERTIFICATE"));
  assert.equal(identity.agent_id.length, 36);

  const settings = () => call("/api/v1/admin/agents/probe-settings", "GET", undefined, cookie);
  const devices = async () => (await call("/api/v1/admin/agents", "GET", undefined, cookie)).payload.agents;
  assert.equal((await settings()).payload.activePages, 0);
  assert.equal((await devices())[0].status, "paused");
  // Start the passive Agent without any authenticated page: it must not dial Server.
  const agent = spawn(binary, ["-config", cfg], { stdio: "ignore" });
  children.push(agent);
  await delay(600);
  assert.equal((await settings()).payload.activePages, 0);
  assert.equal((await devices())[0].lastSeenAt, null);

  const adminPage = await page(cookie);
  await until(async () => (await devices())[0].status === "online");
  const firstSeen = (await devices())[0].lastSeenAt;
  assert.ok(firstSeen > 0);
  const checked = await call("/api/v1/admin/agents/probe", "POST", {}, cookie);
  assert.equal(checked.payload.sent, 1);
  await delay(200);
  assert.equal((await devices())[0].lastSeenAt, firstSeen, "Pong must not write SQLite last_seen_at");

  const task = await call("/api/v1/admin/agents/" + identity.agent_id + "/capability-probe", "POST", {}, cookie);
  await until(async () => (await call("/api/v1/admin/agent-tasks/" + task.payload.taskId, "GET", undefined, cookie)).payload.task.status === "succeeded");
  assert.ok((await devices())[0].capabilities);

  const homePage = await page(homeCookie);
  await until(async () => (await settings()).payload.activePages === 2);
  await closePage(adminPage);
  await until(async () => (await settings()).payload.activePages === 1);
  assert.equal((await devices())[0].status, "online", "other home page must keep shared Agent connection");
  await closePage(homePage);
  await until(async () => (await settings()).payload.activePages === 0);
  const pausedSeen = (await devices())[0].lastSeenAt;
  await delay(600);
  assert.equal((await devices())[0].lastSeenAt, pausedSeen, "no page must not write heartbeat");
  const reopened = await page(cookie);
  await until(async () => (await devices())[0].status === "online");
  await closePage(reopened);
  console.log("M2 reverse Go↔Node mTLS WSS PASS: private Agent, on-demand pages, Ping/Pong, tasks, shared tabs, zero-page idle");
} finally {
  for (const child of children.reverse()) await stop(child);
  rmSync(temp, { recursive: true, force: true });
}
