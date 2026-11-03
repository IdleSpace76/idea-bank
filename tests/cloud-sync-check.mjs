import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { encode } from "next-auth/jwt";
import ts from "typescript";

const directory = new URL("../.cache/cloud-sync-check/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ["rich-text", "ideas"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(new URL(`${name}.js`, directory), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const require = createRequire(import.meta.url), { demoLibrary } = require(fileURLToPath(new URL("ideas.js", directory)));
const stateKey = "idea-bank.cloud.v1", libraryKey = "idea-bank.library.v1";
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
const glb = await readFile(new URL("../test-models/blue-cube.glb", import.meta.url));
const hash = (body, kind = "sha256") => createHash(kind).update(body).digest("hex");
const secret = "isolated-browser-sync-fixture-secret-at-least-32-chars";
const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, IDEA_BANK_AUTH_MODE: "github", AUTH_URL: origin, AUTH_SECRET: secret, AUTH_GITHUB_ID: "fixture", AUTH_GITHUB_SECRET: "fixture", IDEA_BANK_OWNER_ID: "12345", B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com", B2_REGION: "eu-central-003", B2_BUCKET_NAME: "example-test-bucket", B2_KEY_ID: "fixture", B2_APPLICATION_KEY: "fixture" } });
server.stdout.resume(); server.stderr.resume();
let browser;
try {
  for (let i = 0; ; i++) { try { await fetch(origin); break; } catch { if (i > 100 || server.exitCode !== null) throw new Error("Fixture server startup failed"); await delay(100); } }
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const cookieName = "authjs.session-token";
  const token = await encode({ secret, salt: cookieName, token: { sub: "12345", name: "Sync fixture" }, maxAge: 1200 });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const snapshots = new Map(), media = new Map(); let heads = [], offline = false, corrupt = false, conflictOnSave = false, concurrentEdit = null;
    const contexts = [];
    function publish(library, files = [], parents = heads) {
      const snapshot = { format: "idea-bank-cloud", version: 1, revision: randomUUID(), parents: [...parents], createdAt: new Date().toISOString(), library: structuredClone(library), media: structuredClone(files) };
      snapshots.set(snapshot.revision, snapshot); heads = [snapshot.revision]; return snapshot;
    }
    async function device() {
      const context = await browser.newContext({ viewport }); contexts.push(context);
      await context.addCookies([{ name: cookieName, value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
      await context.route("**/api/storage/**", async route => {
        if (offline) { await route.abort("failed"); return; }
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (path.endsWith("/library") && request.method() === "GET") {
          if (!url.searchParams.has("revision") && heads.length > 1) return reply({ error: { code: "CONFLICT", message: "Есть одновременные изменения.", revisions: heads } }, 409);
          return reply({ snapshot: snapshots.get(url.searchParams.get("revision") || heads[0]) || null, heads });
        }
        if (path.endsWith("/library") && request.method() === "PUT") {
          const value = request.postDataJSON();
          if (conflictOnSave) { conflictOnSave = false; publish({ ...value.library, projects: value.library.projects.map(idea => ({ ...idea, name: "Из другого устройства" })) }, value.media); }
          if (JSON.stringify([...value.baseRevisions].sort()) !== JSON.stringify([...heads].sort())) return reply({ error: { code: "CONFLICT", message: "Библиотека изменилась на другом устройстве.", revisions: heads } }, 409);
          return reply({ snapshot: publish(value.library, value.media), heads });
        }
        if (path.endsWith("/upload")) {
          const file = request.postDataJSON(), key = `${file.sha256}-${file.md5}`;
          if (media.has(key)) return reply({ alreadyUploaded: true, media: file });
          return reply({ alreadyUploaded: false, media: file, method: "PUT", url: `https://s3.eu-central-003.backblazeb2.com/sync-fixture/${key}`, headers: { "Content-Type": file.mime }, expiresIn: 300 });
        }
        if (path.endsWith("/download")) {
          const snapshot = snapshots.get(url.searchParams.get("revision")), file = snapshot.media.find(file => file.id === url.searchParams.get("id"));
          if (concurrentEdit) { await concurrentEdit(); concurrentEdit = null; }
          return reply({ media: file, url: `https://s3.eu-central-003.backblazeb2.com/sync-fixture/${file.sha256}-${file.md5}`, expiresIn: 300 });
        }
        return reply({ error: { message: "Unexpected fixture path" } }, 500);
      });
      await context.route("https://s3.eu-central-003.backblazeb2.com/sync-fixture/**", async route => {
        const request = route.request(), key = new URL(request.url()).pathname.split("/").pop();
        const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, PUT, OPTIONS", "Access-Control-Allow-Headers": "*" };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (request.method() === "PUT") { const bytes = request.postDataBuffer(); assert.equal(hash(bytes), key.split("-")[0]); media.set(key, bytes); return route.fulfill({ status: 200, headers }); }
        return route.fulfill({ status: 200, body: corrupt ? Buffer.from("corrupt") : media.get(key), headers });
      });
      const page = await context.newPage();
      await page.goto(origin); await expect(page.locator(".project-card")).toHaveCount(1);
      return page;
    }
    async function open(page) { await page.locator(".local-status").click(); await expect(page.getByRole("heading", { name: "Синхронизация с облаком" })).toBeVisible(); }
    const check = page => page.getByRole("button", { name: /^(Синхронизировать|Проверить ещё раз)$/ }).click();
    async function close(page) { await page.getByRole("button", { name: "Понятно", exact: true }).click(); }
    async function setLocal(page, library, files = []) {
      await page.evaluate(async ({ library, files, libraryKey }) => {
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open("idea-bank.media.v1", 1); request.onupgradeneeded = () => request.result.createObjectStore("files"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        if (files.length) await new Promise((resolve, reject) => { const tx = db.transaction("files", "readwrite"); for (const file of files) tx.objectStore("files").put(new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close(); localStorage.setItem(libraryKey, JSON.stringify(library));
      }, { library, files, libraryKey });
      await page.reload(); await expect(page.locator(".project-card")).toHaveCount(library.projects.length);
    }
    const a = await device();
    const own = structuredClone(demoLibrary); own.projects[0].name = "Моя идея";
    const files = [{ id: randomUUID(), name: "pixel.png", kind: "image", mime: "image/png", bytes: [...pixel] }, { id: randomUUID(), name: "cube.glb", kind: "model", mime: "model/gltf-binary", bytes: [...glb] }];
    own.projects[0].blocks[0].media = files.map(({ bytes, ...file }) => ({ ...file, size: bytes.length }));
    own.projects[0].coverImage = { ...own.projects[0].blocks[0].media[0] };
    await setLocal(a, own, files); await open(a); await check(a);
    await expect(a.getByRole("button", { name: "Сохранить локальную в облаке" })).toBeVisible();
    assert.equal(snapshots.size, 0, "First transfer waits for explicit review");
    await a.getByRole("button", { name: "Сохранить локальную в облаке" }).click();
    await expect(a.getByRole("status").filter({ hasText: "сохранены в облаке" })).toBeVisible();
    assert.equal(media.size, 2); assert.equal(snapshots.size, 1);
    const b = await device(); await open(b); await check(b);
    await b.getByRole("button", { name: "Загрузить облачную на устройство" }).click();
    await expect(b.getByRole("status").filter({ hasText: "все медиа сохранены" })).toBeVisible();
    const received = await b.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey);
    assert.equal(received.projects[0].name, "Моя идея");
    assert.notEqual(received.projects[0].coverImage.id, own.projects[0].coverImage.id, "Remote media staged under fresh IDs");
    assert.equal(received.projects[0].coverImage.id, received.projects[0].blocks[0].media[0].id);
    const stored = await b.evaluate(async library => {
      const db = await new Promise(resolve => { const req = indexedDB.open("idea-bank.media.v1"); req.onsuccess = () => resolve(req.result); });
      const result = [];
      for (const asset of library.projects[0].blocks[0].media) { const blob = await new Promise(resolve => { const req = db.transaction("files").objectStore("files").get(asset.id); req.onsuccess = () => resolve(req.result); }); result.push([...new Uint8Array(await blob.arrayBuffer())]); }
      db.close(); return result;
    }, received);
    assert.deepEqual(Buffer.from(stored[0]), pixel); assert.deepEqual(Buffer.from(stored[1]), glb);
    await b.screenshot({ path: fileURLToPath(new URL(`sync-${viewport.width}.png`, directory)) });
    assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await check(b); await expect(b.getByRole("status").filter({ hasText: "уже синхронизирована" })).toBeVisible();
    offline = true; await check(b); await expect(b.getByRole("alert").filter({ hasText: "Нет связи" })).toBeVisible(); offline = false;
    assert.equal((await b.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey)).projects[0].name, "Моя идея");
    // An external revision plus local edits requires review, never silent replacement.
    await close(b); const changed = structuredClone(received); changed.projects[0].name = "Моя новая правка";
    await setLocal(b, changed); publish({ ...own, projects: own.projects.map(idea => ({ ...idea, name: "Облачная правка" })) }, [...snapshots.values()][0].media);
    await open(b); await check(b); await expect(b.getByRole("button", { name: "Сохранить локальную в облаке" })).toBeVisible();
    assert.equal((await b.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey)).projects[0].name, "Моя новая правка");
    b.once("dialog", dialog => dialog.accept()); await b.getByRole("button", { name: "Сохранить локальную в облаке" }).click();
    await expect(b.getByRole("status").filter({ hasText: "сохранены в облаке" })).toBeVisible(); assert.equal(snapshots.get(heads[0]).library.projects[0].name, "Моя новая правка");
    // Failed downloads and concurrent local edits keep the original library and files.
    const c = await device(); await open(c); await check(c); corrupt = true;
    await c.getByRole("button", { name: "Загрузить облачную на устройство" }).click();
    await expect(c.getByRole("alert")).toBeVisible(); assert.equal(await c.evaluate(key => localStorage.getItem(key), libraryKey), null); corrupt = false;
    await check(c); concurrentEdit = async () => { await c.evaluate(({ key, library }) => localStorage.setItem(key, JSON.stringify(library)), { key: libraryKey, library: demoLibrary }); };
    await c.getByRole("button", { name: "Загрузить облачную на устройство" }).click();
    await expect(c.getByRole("alert").filter({ hasText: "другой вкладке" })).toBeVisible();
    assert.equal((await c.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey)).projects[0].name, "Example");
    const d = await device(); await setLocal(d, own, files); await open(d); await check(d);
    await d.evaluate(key => {
      const original = Storage.prototype.setItem;
      window.failLibraryWrite = true;
      Storage.prototype.setItem = function(name, value) { if (name === key && window.failLibraryWrite) throw new DOMException("fixture full", "QuotaExceededError"); return original.call(this, name, value); };
    }, libraryKey);
    d.once("dialog", dialog => dialog.accept()); await d.getByRole("button", { name: "Загрузить облачную на устройство" }).click();
    await expect(d.getByRole("alert").filter({ hasText: "Прежняя библиотека сохранена" })).toBeVisible();
    assert.equal((await d.evaluate(key => JSON.parse(localStorage.getItem(key)), libraryKey)).projects[0].name, "Моя идея");
    // Interrupt the final sync-state write: startup settles the journal without losing the download.
    await d.evaluate(key => {
      window.failLibraryWrite = false;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) { if (name === key && !JSON.parse(value).journal) throw new DOMException("fixture state full", "QuotaExceededError"); return original.call(this, name, value); };
    }, stateKey);
    await check(d); d.once("dialog", dialog => dialog.accept()); await d.getByRole("button", { name: "Загрузить облачную на устройство" }).click();
    await expect(d.getByRole("status").filter({ hasText: "все медиа сохранены" })).toBeVisible();
    assert.equal(await d.evaluate(key => JSON.parse(localStorage.getItem(key)).journal, stateKey), true);
    await d.reload(); await expect(d.locator(".project-card")).toHaveCount(1);
    assert.equal(await d.evaluate(key => JSON.parse(localStorage.getItem(key)).version, stateKey), 1);
    // A real cloud fork is resolved only by an explicit selection of one candidate.
    const base = heads[0], current = snapshots.get(base);
    const left = publish({ ...current.library, projects: current.library.projects.map(idea => ({ ...idea, name: "Ветка слева" })) }, current.media, [base]);
    const right = publish({ ...current.library, projects: current.library.projects.map(idea => ({ ...idea, name: "Ветка справа" })) }, current.media, [base]); heads = [left.revision, right.revision].sort();
    await check(b); await expect(b.getByRole("button", { name: "Загрузить облачную на устройство" })).toHaveCount(2);
    b.once("dialog", dialog => dialog.accept()); await b.getByRole("button", { name: "Загрузить облачную на устройство" }).first().click();
    await expect(b.getByRole("status").filter({ hasText: "все медиа сохранены" })).toBeVisible();
    assert.equal(heads.length, 1); assert.equal(snapshots.get(heads[0]).parents.length, 2); assert.ok(snapshots.has(left.revision) && snapshots.has(right.revision));
    if (viewport.width === 390) {
      await close(b); await b.setViewportSize({ width: 320, height: 844 });
      assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Signed-in header fits 320px");
      await b.getByRole("button", { name: "Тема оформления", exact: true }).click();
      const box = await b.getByRole("group", { name: "Выбрать тему" }).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 320, "Theme picker stays inside signed-in 320px viewport");
    }
    for (const context of contexts) await context.close();
    console.log(`Cloud sync browser checks passed at ${viewport.width}px: first upload, clean-device download, exact media/cover bytes, offline retention, conflict review and safe failed pull.`);
  }
} finally {
  if (browser) await browser.close(); server.kill();
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", resolve); });
}
