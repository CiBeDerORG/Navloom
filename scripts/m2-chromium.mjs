import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

/** Real headless Chrome UI acceptance with ephemeral credentials, not simulated WebSocket clients. */
export async function verifyChromiumPages({ temp, base, children, settings, ports, password, homePassphrase, establishedAgentTcp, until, stop }) {
  const binary = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .find((name) => spawnSync("which", [name], { stdio: "ignore" }).status === 0);
  if (!binary) throw new Error("Chromium acceptance requires Chrome installed on this GitHub runner");
  const vite = spawn("npm", ["run", "dev", "-w", "@navloom/web", "--", "--host", "127.0.0.1"], {
    env: { ...process.env, NAVLOOM_API_PROXY_TARGET: base },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true, // npm spawns Vite/esbuild; terminate the entire process group.
  });
  children.push(vite);
  let viteErrors = "";
  vite.stderr.on("data", (buf) => { viteErrors += String(buf).slice(-1500); });
  const url = "http://127.0.0.1:5173";
  try { await until(async () => (await fetch(url)).ok, 30_000); }
  catch (error) { throw new Error("Vite failed: " + viteErrors, { cause: error }); }

  const profile = join(temp, "chromium-profile");
  mkdirSync(profile);
  const chrome = spawn(binary, [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--disable-extensions", "--disable-background-networking", "--no-first-run",
    "--no-default-browser-check", "--remote-allow-origins=*",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank",
  ], { stdio: "ignore" });
  children.push(chrome);
  await until(async () => {
    try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n").length >= 2; }
    catch { return false; }
  }, 30_000);
  const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
  const cdp = new WebSocket("ws://127.0.0.1:" + port + path);
  await new Promise((resolve, reject) => { cdp.once("open", resolve); cdp.once("error", reject); });
  const pending = new Map();
  let nextId = 0;
  cdp.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    clearTimeout(request.timer);
    if (msg.error) request.reject(new Error("CDP " + JSON.stringify(msg.error)));
    else request.resolve(msg.result ?? {});
  });
  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Chrome CDP request timed out: " + method));
      }, 12000);
      pending.set(id, { resolve, reject, timer });
      cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
  }
  async function tab(route) {
    const { targetId } = await send("Target.createTarget", { url: url + route });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    return { targetId, sessionId };
  }
  async function evaluate(t, expression) {
    const reply = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, t.sessionId);
    if (reply.exceptionDetails) throw new Error("Chromium script: " + JSON.stringify(reply.exceptionDetails));
    return reply.result?.value;
  }
  async function closeTab(t) { await send("Target.closeTarget", { targetId: t.targetId }); }
  const pages = async () => (await settings()).payload.activePages;
  try {
    const home = await tab("/");
    await until(async () => await evaluate(home, 'Boolean(document.querySelector("#home-passphrase"))'));
    assert.equal(await pages(), 0, "anonymous browser navigation must not activate Agent WSS");
    await evaluate(home, '(async () => {' +
      'const input=document.querySelector("#home-passphrase");' +
      'const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;' +
      'setter.call(input,' + JSON.stringify(homePassphrase) + ');' +
      'input.dispatchEvent(new Event("input",{bubbles:true}));' +
      'await new Promise(done=>setTimeout(done,50));' +
      'document.querySelector("form button").click();' +
      '})()');
    await until(async () => await evaluate(home, 'document.body.innerText.includes("你的应用")'));
    await until(async () => await pages() === 1);
    await until(async () => establishedAgentTcp(ports.a) > 0 && establishedAgentTcp(ports.b) > 0);
    const countA = establishedAgentTcp(ports.a);
    const countB = establishedAgentTcp(ports.b);

    const second = await tab("/");
    await until(async () => await evaluate(second, 'document.body.innerText.includes("你的应用")'));
    await until(async () => await pages() === 2);
    assert.equal(establishedAgentTcp(ports.a), countA, "multiple real tabs must share Agent A session");
    assert.equal(establishedAgentTcp(ports.b), countB, "multiple real tabs must share Agent B session");

    const admin = await tab("/admin/login");
    await until(async () => await evaluate(admin, 'Boolean(document.querySelector("#admin-user"))'));
    assert.equal(await pages(), 2, "unlogged admin login tab cannot activate an Agent");
    await evaluate(admin, '(async () => {' +
      'const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;' +
      'for(const [id,value] of [["admin-user","admin"],["admin-password",' + JSON.stringify(password) + ']]){' +
      'const input=document.getElementById(id);setter.call(input,value);' +
      'input.dispatchEvent(new Event("input",{bubbles:true}));}' +
      'await new Promise(done=>setTimeout(done,50));' +
      'document.querySelector("form button").click();' +
      '})()');
    await until(async () => await evaluate(admin,
      'location.pathname.startsWith("/admin/") && location.pathname!=="/admin/login"'));
    await until(async () => await pages() === 3);

    // M3 browser smoke: the actual management UI must fetch audited
    // templates and dynamically render its parameter form, without a deploy.
    const catalogTab = await tab("/admin/instances");
    await until(async () => await evaluate(catalogTab,
      'Boolean(document.querySelector("#catalog-heading"))'));
    await until(async () => await evaluate(catalogTab,
      'document.body.innerText.includes("Nginx 静态网页")'));
    await evaluate(catalogTab,
      'Array.from(document.querySelectorAll("button")).find(btn => btn.textContent.includes("Nginx 静态网页")).click()');
    await until(async () => await evaluate(catalogTab,
      'Boolean(document.querySelector("#catalog-field-http_port"))'));
    assert.equal(await evaluate(catalogTab,
      'document.querySelector("#catalog-field-http_port").value'), "18080");
    assert.equal(await evaluate(catalogTab,
      'document.querySelector("#catalog-nav-title").value'), "Nginx");
    assert.equal(await evaluate(catalogTab,
      'document.querySelector("#catalog-nav-url").value'), "",
      "browser must not invent an unverified EasyTier/Navloom URL");
    await evaluate(catalogTab, '(async () => {' +
      'const input=document.querySelector("#catalog-nav-url");' +
      'const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;' +
      'set.call(input,"https://nav.example.test/");' +
      'input.dispatchEvent(new Event("input",{bubbles:true}));' +
      'await new Promise(done=>setTimeout(done,70));' +
      '})()');
    assert.equal(await evaluate(catalogTab,
      'document.querySelector("#catalog-nav-url").value'), "https://nav.example.test/",
      "administrator can edit the generated navigation URL before any task is saved");
    await until(async () => await pages() === 4);
    await closeTab(catalogTab);
    await until(async () => await pages() === 3);
    console.log("M3 real Chromium catalog PASS: admin-only template, dynamic port field and editable navigation URL");

    await closeTab(second);
    await until(async () => await pages() === 2);
    await closeTab(home);
    await until(async () => await pages() === 1);
    assert.ok(establishedAgentTcp(ports.a) > 0 && establishedAgentTcp(ports.b) > 0,
      "admin-only browser tab maintains both Agent WSS connections");
    await closeTab(admin);
    await until(async () => await pages() === 0);
    await until(async () => establishedAgentTcp(ports.a) === 0 && establishedAgentTcp(ports.b) === 0);
    console.log("M2 real Chromium PASS: anonymous access, weak-password UI, two homepage tabs, admin UI login, global WSS page shutdown");
  } finally {
    cdp.close();
    await stop(chrome);
    if (vite.pid && process.platform !== "win32") {
      // Killing npm alone leaves its Vite/esbuild grandchildren holding the
      // stderr pipe open and hangs the whole CI job after all tests PASS.
      try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    await stop(vite);
  }
}
