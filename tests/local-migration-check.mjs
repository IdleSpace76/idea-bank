import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { unzipSync } from "fflate";
import { chromium, expect } from "@playwright/test";
import { localInstance } from "../scripts/local-launch.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), cache = path.join(root, ".cache");
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(path.join(cache, "local-migration-")), data = path.join(directory, "data with spaces");
const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`, logs = [], errors = [], cloud = [];
const env = { ...process.env, VERCEL: "", IDEA_BANK_AUTH_MODE: "github", IDEA_BANK_DATA_DIR: data, AUTH_URL: origin, AUTH_SECRET: "fixture-secret-at-least-thirty-two-characters", AUTH_GITHUB_ID: "fixture", AUTH_GITHUB_SECRET: "fixture", IDEA_BANK_OWNER_ID: "12345", B2_S3_ENDPOINT: "", B2_REGION: "", B2_BUCKET_NAME: "", B2_KEY_ID: "", B2_APPLICATION_KEY: "", ABLY_API_KEY: "" };
let server, serverPid, browser;
const png = await readFile(path.join(root, "public/examples/little-robot.png")), model = await readFile(path.join(root, "public/examples/little-robot.glb"));
const section = { id: "old-section", name: "Old browser", description: "Transfer fixture", icon: "book" };
const idea = { id: "old-idea", sectionId: section.id, name: "Old saved idea", description: "Browser original", cover: "water", updatedAt: "2026-11-08T12:00:00Z", blocks: [{ id: "old-block", heading: "Original heading", text: "Original saved body", media: [{ id: "old-image", name: "robot.png", kind: "image", mime: "image/png", size: png.length }, { id: "old-model", name: "robot.glb", kind: "model", mime: "model/gltf-binary", size: model.length }] }] };
const library = { version: 1, sections: [section], projects: [idea] };
const get = async url => { const response = await fetch(origin + url); assert.equal(response.status, 200); return response.json(); };
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server; server = null;
  if (serverPid) { try { process.kill(serverPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  else child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
}
async function savedBrowser(page) {
  return page.evaluate(async () => {
    const list = await (indexedDB.databases || IDBFactory.prototype.databases).call(indexedDB), result = { raw: localStorage.getItem("idea-bank.library.v1"), stores: {} };
    for (const entry of list) {
      if (!["idea-bank.local", "idea-bank.media.v1"].includes(entry.name)) continue;
      const db = await new Promise((resolve, reject) => { const open = indexedDB.open(entry.name); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      try {
        const rows = {};
        for (const store of db.objectStoreNames) rows[store] = await new Promise((resolve, reject) => { const read = db.transaction(store).objectStore(store).getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
        for (const name of Object.keys(rows)) rows[name] = await Promise.all(rows[name].map(async row => row instanceof Blob ? { type: row.type, bytes: [...new Uint8Array(await row.arrayBuffer())] } : row));
        result.stores[entry.name] = { version: db.version, rows };
      } finally { db.close(); }
    }
    return result;
  });
}
async function seed(page, mode) {
  await page.evaluate(async ({ library, png, model, mode }) => {
    localStorage.setItem("idea-bank.library.v1", JSON.stringify({ ...library, projects: [{ ...library.projects[0], name: "Stale localStorage copy" }] }));
    const open = (name, version, stores) => new Promise((resolve, reject) => { const request = indexedDB.open(name, version); request.onupgradeneeded = () => stores.forEach(store => request.result.createObjectStore(store)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const blobs = [new Blob([new Uint8Array(png)], { type: "image/png" }), new Blob([new Uint8Array(model)], { type: "model/gltf-binary" })];
    if (mode === "raw") {
      const db = await open("idea-bank.media.v1", 1, ["files"]), tx = db.transaction("files", "readwrite");
      library.projects[0].blocks[0].media.forEach((asset, index) => tx.objectStore("files").put(blobs[index], asset.id));
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; }); db.close(); return;
    }
    const names = ["meta", "sections", "ideas", "blocks", "media", "outbox"], db = await open("idea-bank.local", mode === "future" ? 2 : 1, names), tx = db.transaction(names, "readwrite");
    const empty = mode === "empty";
    tx.objectStore("meta").put({ revision: 8, sectionIds: empty ? [] : [library.sections[0].id], ideaIds: empty ? [] : [library.projects[0].id] }, "layout");
    tx.objectStore("meta").put({ untouched: true }, "old-draft-marker");
    if (!empty) {
      const idea = library.projects[0]; tx.objectStore("sections").put(library.sections[0], idea.sectionId);
      tx.objectStore("ideas").put({ value: { ...idea, blocks: [] }, blockIds: idea.blocks.map(block => block.id) }, idea.id);
      idea.blocks.forEach(block => tx.objectStore("blocks").put(block, JSON.stringify([idea.id, block.id])));
      if (mode !== "missing") idea.blocks[0].media.forEach((asset, index) => tx.objectStore("media").put(blobs[index], asset.id));
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
  }, { library, png: [...png], model: [...model], mode });
}
try {
  server = spawn(process.execPath, ["scripts/run-local.mjs", "start", "--port", String(port)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  server.on("message", message => { if (message.type === "idea-bank-local-server") serverPid = message.pid; });
  server.stdout.on("data", text => logs.push(String(text))); server.stderr.on("data", text => logs.push(String(text)));
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { status = await get("/api/local/status"); break; } catch { if (server.exitCode !== null) throw new Error("Local launcher stopped"); await delay(100); }
  }
  assert.equal(status?.instanceId, localInstance(root, env), "Launcher forces local mode even with GitHub configuration");
  await assert.rejects(stat(data), error => error.code === "ENOENT");
  const reuse = spawn(process.execPath, ["scripts/run-local.mjs", "start", "--port", String(port)], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  assert.equal(await new Promise(resolve => reuse.once("exit", resolve)), 0);
  const mismatch = spawn(process.execPath, ["scripts/run-local.mjs", "start", "--port", String(port)], { cwd: root, env: { ...env, IDEA_BANK_DATA_DIR: path.join(directory, "other") }, windowsHide: true, stdio: "ignore" });
  assert.equal(await new Promise(resolve => mismatch.once("exit", resolve)), 1);
  console.log("Local launch integration: forced mode, custom data path, status without database, matching reuse and mismatch rejection passed.");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const mode of ["absent", "absent-compat", "primary", "raw", "empty", "missing", "future"]) {
    const context = await browser.newContext({ viewport: { width: mode === "raw" ? 390 : 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem("idea-bank.language", "ru"));
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/local/")) cloud.push(url.pathname); });
    await page.goto(origin); await expect(page.locator(".section-card").first()).toBeVisible();
    if (!mode.startsWith("absent")) await seed(page, mode);
    if (mode === "absent-compat") await page.evaluate(()=>Object.defineProperty(indexedDB,"databases",{value:undefined,configurable:true}));
    const before = await savedBrowser(page), native = await get("/api/local/library?state=1");
    await page.getByRole("button", { name: "На этом устройстве", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Где хранятся идеи", exact: true }), button = dialog.getByRole("button", { name: "Экспорт прежней библиотеки браузера", exact: true });
    if (mode.startsWith("absent")) { await expect(button).toHaveCount(0); await page.waitForTimeout(150); assert.deepEqual(await savedBrowser(page), before); }
    else {
      await expect(button).toBeVisible();
      if (["missing", "future"].includes(mode)) { await button.click(); await expect(dialog.locator(".backup-error")).toBeVisible(); }
      else {
        const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
        const bytes = await readFile(await download.path()), zip = unzipSync(bytes), saved = JSON.parse(Buffer.from(zip["library.json"]).toString("utf8"));
        if (mode === "empty") assert.deepEqual(saved, { version: 1, sections: [], projects: [] });
        else {
          assert.equal(saved.projects[0].name, mode === "primary" ? idea.name : "Stale localStorage copy");
          assert.deepEqual(saved.projects[0].blocks, idea.blocks);
          const manifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString("utf8"));
          assert.equal(manifest.media.length, 2);
          for (const [index, asset] of idea.blocks[0].media.entries()) assert.deepEqual(Buffer.from(zip[manifest.media.find(row => row.id === asset.id).path]), index ? model : png);
          if (mode === "primary") {
            assert.deepEqual(await get("/api/local/library?state=1"), native, "Export does not write native library");
            await dialog.getByLabel("Выбрать архив библиотеки", { exact: true }).setInputFiles({ name: "transfer.zip", mimeType: "application/zip", buffer: bytes });
            await dialog.getByRole("button", { name: "Импортировать идеи", exact: true }).click(); await expect(dialog).toHaveCount(0);
            const restored=(await get(`/api/local/ideas/${idea.id}`)).idea;
            const normalize=value=>({...value,blocks:value.blocks.map(block=>({...block,media:block.media.map(({id,...asset})=>asset)}))});
            assert.deepEqual(normalize(restored), normalize(idea));
            for (const [index, asset] of restored.blocks[0].media.entries()) assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/local/media/${asset.id}`)).arrayBuffer()), index ? model : png);
          }
        }
      }
      assert.deepEqual(await savedBrowser(page), before, `${mode}: source library and attachments are untouched`);
    }
    await context.close(); console.log(`Browser migration: ${mode} passed.`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(cloud, []);
  console.log("Migration uses no cloud API and preserves both sources on export failures.");
} catch (error) { console.error(logs.join("").slice(-2500)); throw error; }
finally {
  await browser?.close(); await stop();
  const relative = path.relative(cache, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe fixture cleanup");
  await rm(directory, { recursive: true, force: true });
}
