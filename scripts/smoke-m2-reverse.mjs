import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
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

// Linux CI observes kernel TCP state rather than trusting the API's
// "paused" label. Both Agent and Server live in this isolated namespace.
function establishedAgentTcp(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  let established = 0;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let contents;
    try { contents = readFileSync(table, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const row of contents.trim().split("\n").slice(1)) {
      const fields = row.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== "01") continue; // 01 = ESTABLISHED
      const localPort = fields[1].split(":").at(-1);
      const remotePort = fields[2].split(":").at(-1);
      if (localPort === hexPort || remotePort === hexPort) established++;
    }
  }
  return established;
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
  base = "http://127.0.0.1:" + serverPort;
  const clientCert = join(temp, "server-client.pem");
  const clientKey = join(temp, "server-client.key");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "2",
    "-keyout", clientKey, "-out", clientCert,
    "-subj", "/CN=Navloom isolated CI Server",
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "extendedKeyUsage=clientAuth",
  ], { stdio: "pipe" });
  chmodSync(clientKey, 0o600);
  const publicClientCert = new X509Certificate(readFileSync(clientCert));
  console.log("Reverse CI client certificate metadata:", JSON.stringify({
    ca: publicClientCert.ca, keyUsage: publicClientCert.keyUsage,
    validFrom: publicClientCert.validFrom, validTo: publicClientCert.validTo,
  }));
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
  const devices = async () => (await call("/api/v1/admin/agents", "GET", undefined, cookie)).payload.agents;
  const settings = () => call("/api/v1/admin/agents/probe-settings", "GET", undefined, cookie);

  async function registerAgent(name) {
    const agentPort = await unusedPort(host);
    const cfg = join(temp, name + "-config.json");
    const identityFile = join(temp, name + "-identity.json");
    writeFileSync(cfg, JSON.stringify({
      server_url: "ws://127.0.0.1:" + serverPort + "/agent",
      allow_insecure_dev: true,
      agent_name: name,
      token_file: identityFile,
      endpoint_host: host,
      endpoint_port: agentPort,
      tls_cert_file: join(temp, name + "-agent.pem"),
      tls_key_file: join(temp, name + "-agent.key"),
    }));
    execFileSync(binary, ["-config", cfg, "-init-tls"], { stdio: "pipe" });
    const issued = await call("/api/v1/admin/agents/pair-tokens", "POST", {}, cookie);
    const paired = spawnSync(binary, ["-config", cfg, "-pair"], {
      input: issued.payload.token + "\n", encoding: "utf8",
    });
    assert.equal(paired.status, 0, name + " pairing failed: " + (paired.stderr ?? "").slice(-500));
    const identity = JSON.parse(readFileSync(identityFile, "utf8"));
    assert.ok(identity.server_client_certificate_pem?.includes("BEGIN CERTIFICATE"));
    return { name, cfg, id: identity.agent_id, port: agentPort };
  }

  function startAgent(agent) {
    const child = spawn(binary, ["-config", agent.cfg], { stdio: "ignore" });
    children.push(child);
    return child;
  }

  const first = await registerAgent("nas-a");
  const second = await registerAgent("nas-b");
  assert.notEqual(first.id, second.id);
  const noLegacyRoute = await fetch(base + "/agent");
  assert.equal(noLegacyRoute.status, 404, "Server must not expose legacy inbound Agent route");

  // Both real Go Agents listen passively, without ever initiating an outbound WSS.
  let processA = startAgent(first);
  let processB = startAgent(second);
  await delay(600);
  assert.equal((await settings()).payload.activePages, 0);
  assert.deepEqual((await devices()).map((device) => device.status), ["paused", "paused"]);
  assert.ok((await devices()).every((device) => device.lastSeenAt === null));
  assert.equal(establishedAgentTcp(first.port), 0, "zero pages: A has no Server TCP session");
  assert.equal(establishedAgentTcp(second.port), 0, "zero pages: B has no Server TCP session");

  // An ordinary homepage-cookie browser, with no admin page open, activates both Agents.
  const homePage = await page(homeCookie);
  await until(async () => (await devices()).filter((device) => device.status === "online").length === 2);
  await until(async () => establishedAgentTcp(first.port) > 0 && establishedAgentTcp(second.port) > 0);
  const firstConnectionCount = establishedAgentTcp(first.port);
  const secondConnectionCount = establishedAgentTcp(second.port);
  const adminPage = await page(cookie);
  await until(async () => (await settings()).payload.activePages === 2);
  assert.equal(establishedAgentTcp(first.port), firstConnectionCount, "second page must not duplicate Agent A WSS");
  assert.equal(establishedAgentTcp(second.port), secondConnectionCount, "second page must not duplicate Agent B WSS");
  const beforePing = new Map((await devices()).map((device) => [device.id, device.lastSeenAt]));
  for (const device of await devices()) {
    assert.equal(device.certificateConfigured, true, "Agent trust must be explicitly provisioned");
    assert.equal(device.endpointHost, host, "expose only the registered private endpoint");
    assert.ok(device.connectedAt > 0 && !device.handshakePending, "TLS WSS alone is not online until hello");
    assert.equal(device.lastPongAt, null, "manual mode must not probe automatically");
  }
  const ping = await call("/api/v1/admin/agents/probe", "POST", {}, cookie);
  assert.equal(ping.payload.sent, 2, "one global Ping per connected Agent");
  await until(async () => (await devices()).every((device) => device.lastPongAt > 0));
  for (const device of await devices()) {
    assert.equal(device.lastSeenAt, beforePing.get(device.id), "Pong never updates last_seen_at");
    assert.equal(device.capabilities, null, "no implicit Docker task on hello");
  }

  const probe = await call("/api/v1/admin/agents/" + first.id + "/capability-probe", "POST", {}, cookie);
  await until(async () =>
    (await call("/api/v1/admin/agent-tasks/" + probe.payload.taskId, "GET", undefined, cookie)).payload.task.status === "succeeded");
  const afterTask = await devices();
  assert.ok(afterTask.find((device) => device.id === first.id)?.capabilities);
  assert.equal(afterTask.find((device) => device.id === second.id)?.capabilities, null,
    "Agent A task must not leak to Agent B");

  // Stop and restart one passive Agent. The other one must remain connected.
  await stop(processB);
  await until(async () => (await devices()).find((device) => device.id === second.id)?.status === "offline");
  assert.equal((await devices()).find((device) => device.id === first.id)?.status, "online");
  processB = startAgent(second);
  await until(async () => (await devices()).find((device) => device.id === second.id)?.status === "online");

  // Revoke Agent A while the browser remains open: no automatic reconnect allowed.
  await call("/api/v1/admin/agents/" + first.id + "/revoke", "POST", {}, cookie);
  await until(async () => (await devices()).find((device) => device.id === first.id)?.status === "revoked");
  assert.equal((await devices()).find((device) => device.id === second.id)?.status, "online");
  await until(async () => establishedAgentTcp(first.port) === 0);
  assert.ok(establishedAgentTcp(second.port) > 0, "revoking A must not disconnect B's TCP socket");
  await stop(processA);

  // Automatic detection is a single persisted Server-wide setting. Both
  // browser roles receive one broadcast; no per-tab Agent schedulers exist.
  const homeEvents = [];
  const adminEvents = [];
  homePage.on("message", (raw) => homeEvents.push(JSON.parse(raw.toString())));
  adminPage.on("message", (raw) => adminEvents.push(JSON.parse(raw.toString())));
  const pongBeforeAuto = (await devices()).find((device) => device.id === second.id)?.lastPongAt ?? 0;
  const autoMode = await call("/api/v1/admin/agents/probe-settings", "PATCH",
    { mode: "auto", intervalMs: 5000 }, cookie);
  assert.equal(autoMode.payload.mode, "auto");
  await until(async () => homeEvents.some((event) => event.type === "probe_settings" && event.settings.mode === "auto") &&
    adminEvents.some((event) => event.type === "probe_settings" && event.settings.mode === "auto"));
  await until(async () => ((await devices()).find((device) => device.id === second.id)?.lastPongAt ?? 0) > pongBeforeAuto,
    9_000);
  assert.equal(establishedAgentTcp(second.port), secondConnectionCount,
    "automatic probing across two tabs must not duplicate Agent connections");

  // Close admin tab; the home-only tab must keep Agent B connected.
  await closePage(adminPage);
  await until(async () => (await settings()).payload.activePages === 1);
  assert.equal((await devices()).find((device) => device.id === second.id)?.status, "online");
  assert.ok(establishedAgentTcp(second.port) > 0, "home-only page keeps the Agent TCP socket");
  await closePage(homePage);
  await until(async () => (await settings()).payload.activePages === 0);
  const paused = await devices();
  assert.equal(paused.find((device) => device.id === second.id)?.status, "paused");
  await until(async () => establishedAgentTcp(second.port) === 0);
  assert.equal(establishedAgentTcp(first.port), 0, "revoked A remains disconnected");
  assert.equal(establishedAgentTcp(second.port), 0, "no page: no established Agent TCP session");
  const lastSeen = paused.find((device) => device.id === second.id)?.lastSeenAt;
  await delay(5500); // exceeds the persisted automatic Ping interval
  assert.equal((await settings()).payload.mode, "auto", "configuration persists when no page exists");
  assert.equal((await devices()).find((device) => device.id === second.id)?.lastSeenAt, lastSeen);
  assert.equal(establishedAgentTcp(second.port), 0, "no hidden Agent reconnection during idle");

  // A single ordinary navigation page reconnects only the still-authorized Agent.
  const reopened = await page(homeCookie);
  await until(async () => (await devices()).find((device) => device.id === second.id)?.status === "online");
  await until(async () => establishedAgentTcp(second.port) > 0);
  assert.equal((await devices()).find((device) => device.id === first.id)?.status, "revoked");
  await closePage(reopened);
  await until(async () => establishedAgentTcp(second.port) === 0);
  await stop(processB);
  console.log("M2 reverse WSS v2 PASS: 2 passive Go Agents, no legacy inbound route, home-only activation, mTLS, global Ping, isolated tasks, restart, revoke, kernel TCP zero-page idle, shared auto mode and timer shutdown");
} finally {
  for (const child of children.reverse()) await stop(child);
  rmSync(temp, { recursive: true, force: true });
}
