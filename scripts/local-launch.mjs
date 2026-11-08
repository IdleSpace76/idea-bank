import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function localArguments(args) {
  let port = 3000, open = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-open") { open = false; continue; }
    const value = arg.startsWith("--port=") ? arg.slice(7) : ["--port", "-p"].includes(arg) ? args[++index] : undefined;
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Use --port 3001 to select a port. Only --port and --no-open are accepted.");
    port = Number(value);
  }
  return { port, open };
}

export function localInstance(root, env) {
  return createHash("sha256").update(JSON.stringify([path.resolve(root), path.resolve(root, env.IDEA_BANK_DATA_DIR?.trim() || "data")])).digest("hex");
}

/** Reuse only the same checkout and data folder; a timeout is not a free port. */
export async function probeLocal(url, instanceId) {
  try {
    const response = await fetch(`${url}/api/local/status`, { signal: AbortSignal.timeout(2500), redirect: "error" });
    const status = response.ok ? await response.json().catch(() => null) : null;
    return status?.kind === "idea-bank-local" && status.version === 1 && status.instanceId === instanceId ? "ready" : "occupied";
  } catch (error) { return error.cause?.code === "ECONNREFUSED" ? "offline" : "occupied"; }
}

function openBrowser(url) {
  if (process.platform !== "win32") { console.log(`Open ${url} in your browser.`); return; }
  const browser = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
  browser.on("error", () => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

/** Local mode is process-only: existing GitHub/B2 settings in .env.local stay intact. */
export async function launchLocal(mode, args, options = {}) {
  try {
    if (!["dev", "start"].includes(mode)) throw new Error("Expected dev or start.");
    const { port, open } = localArguments(args);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const require = createRequire(path.join(root, "package.json"));
    process.env.IDEA_BANK_AUTH_MODE = "local";
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(root, mode === "dev");
    if (process.env.VERCEL) throw new Error("Local mode cannot run on Vercel. Use the standard build and start commands for cloud hosting.");
    const url = `http://127.0.0.1:${port}`, instanceId = localInstance(root, process.env);
    const initial = await probeLocal(url, instanceId);
    if (initial === "ready") { console.log(`Idea Bank is already running: ${url}`); if (options.openBrowser && open) openBrowser(url); return; }
    if (initial === "occupied") throw new Error(`Port ${port} is occupied by another app or Idea Bank instance. Choose another port with --port 3001.`);
    try {
      const Database = require("better-sqlite3"), db = new Database(":memory:");
      try { db.prepare("SELECT 1").get(); } finally { db.close(); }
    } catch { throw new Error("SQLite could not start. Run npm ci in the application folder to install dependencies for this Node.js version."); }
    console.log(`Starting local Idea Bank: ${url}\nKeep this window open. Press Ctrl+C to stop the application.`);
    const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, IDEA_BANK_AUTH_MODE: "local" }, stdio: "inherit", windowsHide: true });
    const stop = () => { if (server.exitCode === null && !server.killed) server.kill(); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    // An embedding process can stop the exact child without enumerating unrelated Node processes.
    if (process.send) { process.on("disconnect", stop); process.send({ type: "idea-bank-local-server", pid: server.pid }); }
    let done = false;
    const exited = new Promise(resolve => {
      server.once("error", () => { done = true; console.error("Could not start the local server."); resolve(1); });
      server.once("exit", code => { done = true; resolve(code ?? 0); });
    });
    if (options.openBrowser && open) {
      const deadline = Date.now() + 90000;
      while (!done && Date.now() < deadline) {
        if (await probeLocal(url, instanceId) === "ready") { openBrowser(url); break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!done && Date.now() >= deadline) console.log(`Once the server is ready, open ${url}.`);
    }
    const code = await exited;
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    process.off("disconnect", stop);
    process.exitCode = code;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
