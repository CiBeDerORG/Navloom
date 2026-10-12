import assert from "node:assert/strict";
import { X509Certificate, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { verifyChromiumPages } from "./m2-chromium.mjs";

const temp = mkdtempSync(join(tmpdir(), "navloom-reverse-e2e-"));
const children = [];
const password = "isolated-reverse-ci-admin-password-123";
const homePassphrase = "isolated-reverse-home-passphrase";
let base = "";


const dockerFixtureIDs = [];
let dockerFixtureImage = "";
let disposableCompose = null;

// Opt-in side-effect tests run ONLY on the disposable GitHub-hosted Docker daemon.
// Never operate on a user's NAS, externally supplied DOCKER_HOST, or production Docker.
function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function provisionDisposableDockerFixtures() {
  if (process.env.NAVLOOM_CI_DOCKER_FIXTURES !== "1") return null;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.DOCKER_HOST) {
    throw new Error("Docker mutation acceptance requires the isolated GitHub Actions Docker daemon");
  }
  const directory = join(temp, "docker-fixture");
  mkdirSync(directory);
  const source = join(directory, "main.go");
  writeFileSync(source, [
    "package main",
    'import ("fmt"; "time")',
    'func main() { fmt.Println("password=disposable-ci-canary"); time.Sleep(time.Hour) }',
    "",
  ].join("\n"));
  execFileSync("go", ["build", "-o", join(directory, "fixture"), source], {
    stdio: "pipe", env: { ...process.env, CGO_ENABLED: "0" },
  });
  writeFileSync(join(directory, "Dockerfile"), 'FROM scratch\nCOPY fixture /fixture\nENTRYPOINT ["/fixture"]\n');
  dockerFixtureImage = "navloom-m2-ci:" + process.pid + "-" + Date.now();
  docker(["build", "--quiet", "--tag", dockerFixtureImage, directory]);
  function create(name, labels = []) {
    const args = ["create", "--name", name, ...labels.flatMap(v => ["--label", v]), dockerFixtureImage];
    const id = docker(args);
    dockerFixtureIDs.push(id);
    return id;
  }
  const suffix = process.pid + "-" + Date.now();
  const labels = [
    "com.docker.compose.project=navloomacceptance",
    "com.docker.compose.service=app",
    "private-acceptance-label=must-not-leak",
  ];
  const running = create("navloom-ci-running-" + suffix, labels);
  const stopped = create("navloom-ci-exited-" + suffix);
  docker(["start", running]);
  docker(["start", stopped]);
  docker(["stop", "--time", "1", stopped]);
  assert.equal(docker(["inspect", "-f", "{{.State.Status}}", running]), "running");
  assert.equal(docker(["inspect", "-f", "{{.State.Status}}", stopped]), "exited");
  return { running, stopped };
}

function cleanupDisposableDockerFixtures() {
  if (disposableCompose) {
    spawnSync("docker", ["compose", "-p", disposableCompose.project, "-f", disposableCompose.file,
      "down", "--remove-orphans"], { stdio: "ignore" });
  }
  for (const id of dockerFixtureIDs.reverse()) {
    spawnSync("docker", ["rm", "--force", id], { stdio: "ignore" });
  }
  if (dockerFixtureImage) spawnSync("docker", ["image", "rm", "--force", dockerFixtureImage], { stdio: "ignore" });
}


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

async function assertZeroPagePacketCapture(ports, durationMs = 5500) {
  if (process.env.NAVLOOM_CI_PACKET_CAPTURE !== "1") {
    await delay(durationMs);
    return;
  }
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.DOCKER_HOST) {
    throw new Error("Packet capture acceptance is restricted to the isolated CI runner");
  }
  // Capture only the test Agent ports. Raw AF_PACKET does not depend on tcpdump
  // being installed on the GitHub runner, and the test PCAP is deleted at exit.
  const pcap = join(temp, "m2-zero-page.pcap");
  const result = spawnSync("sudo", ["-n", "python3", "scripts/m2-packet-capture.py",
    String(durationMs / 1000), pcap, ...ports.map(String)], {
    encoding: "utf8", timeout: durationMs + 6000, maxBuffer: 200_000,
  });
  assert.equal(result.status, 0, "isolated packet capture failed: " +
    String(result.stderr ?? "").slice(-1200));
  const report = JSON.parse(String(result.stdout).trim());
  copyFileSync(pcap, resolve("m2-zero-page.pcap"));
  writeFileSync(resolve("m2-zero-page.json"), JSON.stringify({
    environment: "ephemeral GitHub-hosted single-runner",
    measure: "Linux AF_PACKET Ethernet TCP Agent port filter",
    ...report,
  }, null, 2) + "\n");
  assert.equal(report.agent_tcp_packets, 0,
    "zero authenticated pages must produce zero Agent TCP packets");
  console.log("M2 isolated packet capture PASS: zero authenticated pages, zero Agent TCP packets for " +
    durationMs + " ms");
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

  const fixture = provisionDisposableDockerFixtures();

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

  if (process.env.NAVLOOM_CI_BROWSER === "1") {
    await verifyChromiumPages({
      temp, base, children, settings, ports: { a: first.port, b: second.port },
      password, homePassphrase, establishedAgentTcp, until, stop,
    });
    assert.equal((await settings()).payload.activePages, 0);
  }

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


  // Real Docker acceptance on GitHub's disposable runner, never the user's NAS.
  // The two independent Go Agents see the same daemon, but inventory, tasks,
  // and Compose instance association remain strictly Agent-scoped.
  if (fixture) {
    const containersFor = async (id) =>
      (await call("/api/v1/admin/containers?agentId=" + id, "GET", undefined, cookie)).payload.containers;
    const taskStatus = async (id) =>
      (await call("/api/v1/admin/agent-tasks/" + id, "GET", undefined, cookie)).payload.task.status;
    const execute = async (id, operation) => {
      const response = await call("/api/v1/admin/containers/" + id + "/action", "POST", {
        operation, idempotencyKey: randomUUID(),
      }, cookie);
      await until(async () => (await taskStatus(response.payload.taskId)) === "succeeded");
      return response.payload.taskId;
    };
    await until(async () => (await containersFor(first.id)).some(row => row.containerId === fixture.running) &&
      (await containersFor(first.id)).some(row => row.containerId === fixture.stopped));
    await until(async () => (await containersFor(second.id)).some(row => row.containerId === fixture.running));
    const firstInventory = await containersFor(first.id);
    const aRunning = firstInventory.find(row => row.containerId === fixture.running);
    const aStopped = firstInventory.find(row => row.containerId === fixture.stopped);
    assert.equal(aRunning.state, "running");
    assert.equal(aStopped.state, "exited");
    assert.equal(aRunning.composeProject, "navloomacceptance");
    assert.equal(aRunning.composeService, "app");
    assert.equal(aRunning.labels["private-acceptance-label"], undefined,
      "untrusted Docker labels must not be exposed to browsers");
    assert.equal(aRunning.source, "external");
    const bRunning = (await containersFor(second.id)).find(row => row.containerId === fixture.running);
    assert.notEqual(aRunning.id, bRunning.id, "different Agent inventory rows require different IDs");
    assert.equal(bRunning.agentId, second.id);

    // Create a catalog association on A only, without touching Docker.
    const claimed = await call("/api/v1/admin/app-instances", "POST", {
      agentId: first.id, composeProject: "navloomacceptance",
      templateId: "ci-example", templateVersion: "1",
    }, cookie);
    assert.ok(claimed.payload.id);
    const claimedA = (await containersFor(first.id)).find(row => row.containerId === fixture.running);
    const unclaimedB = (await containersFor(second.id)).find(row => row.containerId === fixture.running);
    assert.equal(claimedA.instanceId, claimed.payload.id);
    assert.equal(claimedA.source, "managed");
    assert.equal(unclaimedB.instanceId, null);
    assert.equal(unclaimedB.source, "external");

    // Reconciliation replaces snapshot row UUIDs; always resolve the latest
    // inventory ID rather than sending a command to a stale catalog row.
    const current = async (containerId) => {
      const row = (await containersFor(first.id)).find(entry => entry.containerId === containerId);
      assert.ok(row, "fixture must remain discoverable");
      return row.id;
    };
    // Stop/start/restart are allowed only via an explicit admin action.
    await execute(await current(fixture.running), "stop");
    await until(async () => docker(["inspect", "-f", "{{.State.Status}}", fixture.running]) === "exited");
    await execute(await current(fixture.stopped), "start");
    await until(async () => docker(["inspect", "-f", "{{.State.Status}}", fixture.stopped]) === "running");
    await execute(await current(fixture.stopped), "restart");
    await until(async () => docker(["inspect", "-f", "{{.State.Status}}", fixture.stopped]) === "running");

    // Docker logs are bounded and must redact canary credentials.
    const logsRequest = await call("/api/v1/admin/containers/" + await current(fixture.stopped) + "/logs", "POST", {}, cookie);
    await until(async () => (await taskStatus(logsRequest.payload.taskId)) === "succeeded");
    const logRows = (await call("/api/v1/admin/agent-tasks/" + logsRequest.payload.taskId + "/logs",
      "GET", undefined, cookie)).payload.lines;
    assert.ok(logRows.some(row => row.line.includes("password=[REDACTED]")),
      "real Docker log stream must redact password assignments");
    assert.ok(logRows.every(row => !row.line.includes("disposable-ci-canary") && row.line.length <= 512));

    // Destroying one fixture is reconciled without fabricating a deployment.
    docker(["rm", "--force", fixture.stopped]);
    await until(async () => !(await containersFor(first.id)).some(row => row.containerId === fixture.stopped),
      20_000);
    assert.equal((await containersFor(first.id)).find(row => row.containerId === fixture.running)?.instanceId,
      claimed.payload.id);

    // Real Docker replacement: the container ID changes but the Compose
    // project/service remain stable. A's explicit catalog association survives
    // while B (same daemon, separate Agent ID) stays an external discovery.
    docker(["rm", "--force", fixture.running]);
    const recreated = docker(["create", "--name", "navloom-ci-recreated-" + process.pid + "-" + Date.now(),
      "--label", "com.docker.compose.project=navloomacceptance",
      "--label", "com.docker.compose.service=app", dockerFixtureImage]);
    dockerFixtureIDs.push(recreated);
    docker(["start", recreated]);
    await until(async () => {
      const rows = await containersFor(first.id);
      return rows.some(row => row.containerId === recreated) &&
        !rows.some(row => row.containerId === fixture.running);
    }, 20_000);
    await until(async () => (await containersFor(second.id)).some(row => row.containerId === recreated), 20_000);
    assert.equal((await containersFor(first.id)).find(row => row.containerId === recreated)?.instanceId,
      claimed.payload.id, "real replacement must retain Agent A Compose project association");
    assert.equal((await containersFor(second.id)).find(row => row.containerId === recreated)?.instanceId,
      null, "Agent B must not inherit A's managed Compose instance");
    console.log("M2 disposable real-Docker acceptance PASS: preexisting running/exited, labels, Agent isolation, instance association, start/stop/restart, bounded redacted logs, destroy reconciliation and real container replacement");
    // Real Compose v2 recreate, not just a raw container with Compose labels.
    // Confined to an ephemeral project and the same disposable local image.
    const project = "navloomacceptance" + process.pid;
    const file = join(temp, "acceptance-compose.yml");
    writeFileSync(file, "services:\n  app:\n    image: " + dockerFixtureImage + "\n");
    disposableCompose = { file, project };
    const compose = (...args) => docker(["compose", "-p", project, "-f", file, ...args]);
    compose("up", "-d");
    const original = compose("ps", "-q", "app");
    assert.ok(original.length >= 12, "Compose must create the first application container");
    await until(async () => (await containersFor(first.id)).some(row => row.containerId === original), 20_000);
    const registered = await call("/api/v1/admin/app-instances", "POST", {
      agentId: first.id, composeProject: project,
      templateId: "ci-compose", templateVersion: "1",
    }, cookie);
    assert.ok(registered.payload.id);
    compose("up", "-d", "--force-recreate");
    const next = compose("ps", "-q", "app");
    assert.notEqual(next, original, "Compose force-recreate must change container ID");
    await until(async () => {
      const rows = await containersFor(first.id);
      return rows.some(row => row.containerId === next) && !rows.some(row => row.containerId === original);
    }, 20_000);
    await until(async () => (await containersFor(second.id)).some(row => row.containerId === next), 20_000);
    assert.equal((await containersFor(first.id)).find(row => row.containerId === next)?.instanceId,
      registered.payload.id, "real Compose up --force-recreate must preserve instance association");
    assert.equal((await containersFor(second.id)).find(row => row.containerId === next)?.instanceId,
      null, "Compose association must not leak to a different Agent");
    console.log("M2 disposable Compose v2 force-recreate PASS: new container ID, Agent A stable managed instance, Agent B external");
  }

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
  await delay(500); // let the final TCP close handshake settle before measuring idle traffic
  await assertZeroPagePacketCapture([first.port, second.port]); // covers a full persisted automatic Ping interval
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
  cleanupDisposableDockerFixtures();
  rmSync(temp, { recursive: true, force: true });
}
