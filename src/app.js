// Starts the local Farfield app: the watching loop plus the local web page for it.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { createAppServer } from "./server.js";
import { ensureSample } from "./sample.js";

function openBrowser(url) {
  try {
    const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* the link is printed anyway */ }
}

export async function startApp({ home, port = 4317, open = true, log = () => {}, fetch: fetchImpl, now } = {}) {
  const agent = createAgent({ home, fetch: fetchImpl, now, log: () => {} });
  await ensureSample(agent.storage);
  const token = crypto.randomBytes(24).toString("hex");
  const loop = { running: false, lastTickAt: 0 };
  const app = createAppServer({ agent, home, token, getLoop: () => loop });
  let info;
  try { info = await app.listen(port); }
  catch (e) { if (e && e.code === "EADDRINUSE" && port !== 0) info = await app.listen(0); else throw e; }

  let stopped = false;
  const done = (async () => {
    loop.running = true;
    while (!stopped) {
      try { await agent.tick(); } catch (e) { log("Problem: " + ((e && e.message) || e)); }
      loop.lastTickAt = Date.now();
      const wait = Math.max(1, loadConfig(home).pollSeconds) * 1000;
      for (let w = 0; w < wait && !stopped; w += 200) await new Promise((r) => setTimeout(r, 200));
    }
    loop.running = false;
  })();

  if (open) openBrowser(info.url);
  return {
    url: info.url, port: info.port, agent, loop,
    async stop() { stopped = true; await done; await app.close(); },
  };
}
