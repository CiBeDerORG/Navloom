import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const temp = mkdtempSync(join(tmpdir(), "navloom-m2-e2e-"));
const children = [];
const password = "local-ci-admin-password-123";
const home = "local-ci-home-passphrase";
let base = "";

async function port() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("port unavailable")); return; }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Server or Agent is still starting.
    }
    await delay(100);
  }
  throw new Error("M2 end-to-end condition timed out");
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
  if (!response.ok) throw new Error("HTTP " + response.status + " on " + path);
  return { payload, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

function startAgent(binary, id, credential, name, endpoint) {
  const folder = join(temp, name);
  mkdirSync(folder, { mode: 0o700 });
  const identityFile = join(folder, "identity.json");
  writeFileSync(identityFile, JSON.stringify({ agent_id: id, credential }) + "\n", { mode: 0o600 });
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      NAVLOOM_SERVER_URL: endpoint,
      NAVLOOM_AGENT_TOKEN_FILE: identityFile,
      NAVLOOM_AGENT_NAME: name,
      NAVLOOM_ALLOW_INSECURE_DEV: "true",
    },
    stdio: "ignore",
  });
  children.push(child);
  return { child, identityFile };
}

function restartAgent(binary, name, identityFile, endpoint) {
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      NAVLOOM_SERVER_URL: endpoint,
      NAVLOOM_AGENT_TOKEN_FILE: identityFile,
      NAVLOOM_AGENT_NAME: name,
      NAVLOOM_ALLOW_INSECURE_DEV: "true",
    },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  const chosenPort = await port();
  base = "http://127.0.0.1:" + chosenPort;
  const env = {
    ...process.env, DATABASE_URL: join(temp, "navloom.db"), HOST: "127.0.0.1",
    PORT: String(chosenPort), NODE_ENV: "test",
    NAVLOOM_ADMIN_USERNAME: "admin", NAVLOOM_ADMIN_PASSWORD: password, NAVLOOM_HOME_PASSPHRASE: home,
  };
  execFileSync("npm", ["run", "db:migrate"], { env, stdio: "pipe" });
  execFileSync("npm", ["run", "admin:init", "-w", "@navloom/server"], { env, stdio: "pipe" });
  const server = spawn("node", ["server/dist/index.js"], { env, stdio: "ignore" });
  children.push(server);
  await waitFor(async () => {
    const result = await call("/api/v1/system/status");
    return result.payload.status === "ok";
  });
  const login = await call("/api/v1/auth/admin/login", "POST", { username: "admin", password });
  const cookie = login.cookie;
  assert.ok(cookie.startsWith("navloom_admin="));
  const paired = [];
  for (const name of ["nas-a", "nas-b"]) {
    const issued = await call("/api/v1/admin/agents/pair-tokens", "POST", {}, cookie);
    const result = await call("/api/v1/agent/pair", "POST", {
      token: issued.payload.token, name, version: "m2-e2e", platform: "linux", architecture: "amd64",
    });
    paired.push({ ...result.payload, name });
  }
  const binary = resolve(temp, "navloom-agent");
  execFileSync("go", ["build", "-o", binary, "./cmd/navloom-agent"], {
    cwd: resolve("agent"), stdio: "pipe",
  });
  const endpoint = "ws://127.0.0.1:" + chosenPort + "/agent";
  const first = startAgent(binary, paired[0].agentId, paired[0].credential, "nas-a", endpoint);
  const second = startAgent(binary, paired[1].agentId, paired[1].credential, "nas-b", endpoint);
  const statuses = async () => (await call("/api/v1/admin/agents", "GET", undefined, cookie)).payload.agents;
  await waitFor(async () => (await statuses()).filter((a) => a.status === "online").length === 2);
  assert.equal((await statuses()).length, 2);
  // The Server automatically dispatches a read-only capability probe to each
  // authenticated Go Agent. Docker may be unavailable on this CI runner.
  await waitFor(async () => (await statuses()).every((agent) => agent.capabilities !== null));
  for (const agent of await statuses()) {
    assert.equal(agent.capabilities.platform, "linux");
    assert.equal(typeof agent.capabilities.docker.available, "boolean");
    assert.equal(typeof agent.capabilities.compose.available, "boolean");
    assert.ok(agent.checkedAt > 0);
  }
  const probe = await call("/api/v1/admin/agents/" + paired[0].agentId + "/capability-probe", "POST", {}, cookie);
  assert.ok(probe.payload.taskId);
  await waitFor(async () => {
    const result = await call("/api/v1/admin/agent-tasks/" + probe.payload.taskId, "GET", undefined, cookie);
    return result.payload.task.status === "succeeded";
  });
  const detail = await call("/api/v1/admin/agents/" + paired[0].agentId, "GET", undefined, cookie);
  assert.equal(detail.payload.agent.status, "online");
  assert.ok(detail.payload.agent.lastSeenAt > 0);
  await stop(second.child);
  await waitFor(async () => (await statuses()).find((a) => a.id === paired[1].agentId)?.status === "offline");
  const restarted = restartAgent(binary, "nas-b", second.identityFile, endpoint);
  await waitFor(async () => (await statuses()).find((a) => a.id === paired[1].agentId)?.status === "online");
  assert.equal((await statuses()).length, 2);
  const revoked = await call("/api/v1/admin/agents/" + paired[0].agentId + "/revoke", "POST", {}, cookie);
  assert.equal(revoked.payload.ok, true);
  await waitFor(async () => {
    const agents = await statuses();
    return agents.find((a) => a.id === paired[0].agentId)?.status === "revoked" &&
      agents.find((a) => a.id === paired[1].agentId)?.status === "online";
  });
  await stop(first.child);
  await stop(restarted);
  console.log("M2 real Go↔Node WSS: two Agents, directed capability probes, persistent results, reconnect and revoke isolation PASS");
} finally {
  for (const child of children.reverse()) await stop(child);
  rmSync(temp, { recursive: true, force: true });
}
