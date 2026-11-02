import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = "http://127.0.0.1:3000";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const shell = process.env.ComSpec || "cmd.exe";

function openBrowser() {
  const browser = spawn(shell, ["/d", "/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
  browser.on("error", () => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

async function probe() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const text = await response.text();
    return response.ok && /<title>Idea Bank/.test(text) ? "ready" : "occupied";
  } catch { return "offline"; }
}

const initial = await probe();
if (initial === "ready") {
  console.log(`Idea Bank is already running: ${url}`);
  openBrowser();
} else if (initial === "occupied") {
  console.error("Port 3000 is in use by another application. Close it and try again.");
  process.exitCode = 1;
} else {
  console.log(`Starting Idea Bank: ${url}`);
  console.log("Keep this window open. Press Ctrl+C to stop the application.\n");
  const server = spawn(shell, ["/d", "/c", "npm run dev -- --port 3000"], { cwd, stdio: "inherit", windowsHide: true });
  let exited = false;
  const stop = new AbortController();
  server.on("error", error => { console.error(error.message); exited = true; stop.abort(); process.exitCode = 1; });
  server.on("exit", code => { exited = true; stop.abort(); process.exitCode = code ?? 0; });
  // The child shares the console, so Ctrl+C also stops npm and its dev server.
  process.on("SIGINT", () => { stop.abort(); });
  process.on("SIGTERM", () => { stop.abort(); });
  const deadline = Date.now() + 90000;
  while (!exited && !stop.signal.aborted && Date.now() < deadline) {
    if (await probe() === "ready") { openBrowser(); break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!exited && !stop.signal.aborted && Date.now() >= deadline) console.log(`The server is taking longer than usual. Once it is ready, open ${url}.`);
}
