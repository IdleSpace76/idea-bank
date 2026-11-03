import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { demoLibrary, STORAGE_KEY, type Library, type MediaAsset } from "../lib/ideas";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function smallLibrary(image = pixel): Library {
  return { version: 1, sections: [demoLibrary.sections[0]], projects: [{ ...demoLibrary.projects[0], name: "Моя сохранённая идея", blocks: [{ id: "saved-block", heading: "Сохранённый блок", text: "Не потерять", media: [{ id: "shared-image", name: "reference.png", kind: "image", mime: "image/png", size: image.length }] }] }] };
}
function archive(library: Library, media = new Map([["shared-image", pixel]])) {
  const json = Buffer.from(JSON.stringify(library)), entries: Record<string, Uint8Array> = { "library.json": json };
  const manifest = { format: "idea-bank-backup", version: 1, createdAt: "2026-11-02T12:00:00.000Z", librarySha256: sha(json), media: [...media].map(([id, bytes], i) => { const path = `media/${i}_file`; entries[path] = bytes; return { id, path, size: bytes.length, sha256: sha(bytes) }; }) };
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return { bytes: Buffer.from(zipSync(entries)), entries, manifest };
}
async function seed(page: Page, library: Library, media: { id: string; mime: string; base64: string }[]) {
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  await page.evaluate(async ({ library, media, key }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("idea-bank.media.v1", 1); request.onupgradeneeded = () => request.result.createObjectStore("files"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").clear(); for (const file of media) tx.objectStore("files").put(new Blob([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], { type: file.mime }), file.id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close(); localStorage.setItem(key, JSON.stringify(library));
  }, { library, media, key: STORAGE_KEY });
  await page.reload();
}
async function snapshot(page: Page) {
  return page.evaluate(async key => {
    const raw = localStorage.getItem(key);
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open("idea-bank.media.v1", 1); request.onupgradeneeded = () => request.result.createObjectStore("files"); request.onsuccess = () => resolve(request.result); });
    const rows = await new Promise<{ keys: IDBValidKey[]; files: Blob[] }>(resolve => { const tx = db.transaction("files", "readonly"), store = tx.objectStore("files"), keys = store.getAllKeys(), files = store.getAll(); tx.oncomplete = () => resolve({ keys: keys.result, files: files.result }); });
    db.close();
    const files = await Promise.all(rows.files.map(async (file, i) => ({ id: rows.keys[i], size: file.size, hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map(n => n.toString(16).padStart(2, "0")).join("") })));
    return { raw, files };
  }, STORAGE_KEY);
}
async function openBackups(page: Page) { await page.getByRole("button", { name: "Локальная версия", exact: true }).click(); await expect(page.getByRole("heading", { name: "Резервная копия", exact: true })).toBeVisible(); }
async function inspect(page: Page, bytes: Buffer) { await page.getByLabel("Выбрать архив библиотеки", { exact: true }).setInputFiles({ name: "library.zip", mimeType: "application/zip", buffer: bytes }); }

function triangle() {
  const binary = Buffer.alloc(36); [-1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((n, i) => binary.writeFloatLE(n, i * 4));
  const doc = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] }] };
  const text = JSON.stringify(doc), json = Buffer.from(text + " ".repeat((4 - Buffer.byteLength(text) % 4) % 4)), glb = Buffer.alloc(28 + json.length + binary.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20); glb.writeUInt32LE(binary.length, 20 + json.length); glb.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(glb, 28 + json.length); return glb;
}

test("a ZIP transfers covers, rich text, layout and every media kind to a clean device", async ({ page, browser }, info) => {
  await page.goto("/");
  const generated = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 100; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#4090c0"; ctx.fillRect(0, 0, 160, 100);
    const png = canvas.toDataURL("image/png").split(",")[1];
    const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: "video/webm" }), chunks: BlobPart[] = [];
    const done = new Promise<Blob>(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 250)); ctx.fillStyle = "#d09040"; ctx.fillRect(0, 0, 60, 100); await new Promise(resolve => setTimeout(resolve, 250)); recorder.stop();
    const video = Array.from(new Uint8Array(await (await done).arrayBuffer())); stream.getTracks().forEach(track => track.stop()); return { png, video };
  });
  const wav = Buffer.alloc(16044); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(16000, 40);
  const payloads = [Buffer.from(generated.png, "base64"), wav, Buffer.from(generated.video), triangle()];
  const kinds = ["image", "audio", "video", "model"] as const, mimes = ["image/png", "audio/wav", "video/webm", "model/gltf-binary"], names = ["reference.png", "sound.wav", "clip.webm", "triangle.glb"];
  const assets: MediaAsset[] = payloads.map((data, i) => ({ id: i ? `media-${i}` : "shared-image", kind: kinds[i], mime: mimes[i], name: names[i], size: data.length, displaySize: { width: 220, height: 180 + i * 10 } }));
  const library = smallLibrary(); library.projects[0].coverImage = { ...assets[0] };
  library.projects[0].blocks = [{ id: "saved-block", heading: "Форматированный блок", headingFontSize: 32, text: "Важная идея", richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Важная идея", marks: [{ type: "bold" }] }] }] }, width: "full", textPosition: "above", media: assets }];
  await seed(page, library, assets.map((asset, i) => ({ id: asset.id, mime: asset.mime, base64: payloads[i].toString("base64") })));
  await openBackups(page);
  const downloadEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Экспортировать ZIP", exact: true }).click(); const download = await downloadEvent;
  const bytes = await readFile((await download.path())!), exported = unzipSync(bytes), manifest = JSON.parse(strFromU8(exported["manifest.json"]));
  expect(JSON.parse(strFromU8(exported["library.json"]))).toEqual(library); expect(manifest.media).toHaveLength(4);
  manifest.media.forEach((entry: { path: string; sha256: string }, i: number) => { expect(sha(exported[entry.path])).toBe(entry.sha256); expect(entry.sha256).toBe(sha(payloads[i])); });
  const targetContext = await browser.newContext({ storageState: { cookies: [], origins: [{ origin: new URL(page.url()).origin, localStorage: [{ name: "idea-bank.language", value: "ru" }] }] }, viewport: page.viewportSize()!, isMobile: info.project.name === "mobile", hasTouch: info.project.name === "mobile" });
  try {
    const target = await targetContext.newPage(); await target.goto(new URL("/", page.url()).href); await openBackups(target); await inspect(target, bytes);
    await expect(target.getByText("Архив проверен. Текущая библиотека пока не изменена.", { exact: true })).toBeVisible();
    expect(await target.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    await target.getByRole("button", { name: "Отмена импорта", exact: true }).click();
    await expect(target.getByRole("button", { name: "Заменить библиотеку", exact: true })).toHaveCount(0);
    await inspect(target, bytes); await expect(target.locator(".backup-preview")).toBeVisible();
    await target.screenshot({ path: info.outputPath("backup-preview.png"), fullPage: true });
    await target.getByRole("button", { name: "Заменить библиотеку", exact: true }).click();
    await expect(target.getByRole("dialog")).toHaveCount(0); await target.reload();
    const state = await snapshot(target), restored = JSON.parse(state.raw!), idea = restored.projects[0];
    expect(idea.coverImage.id).toBe(idea.blocks[0].media[0].id); expect(idea.coverImage.id).not.toBe("shared-image");
    expect(idea.blocks[0].richText).toEqual(library.projects[0].blocks[0].richText); expect(idea.blocks[0].headingFontSize).toBe(32); expect(idea.blocks[0].textPosition).toBe("above");
    expect(state.files.map(file => file.hash).sort()).toEqual(payloads.map(sha).sort());
    expect(idea.blocks[0].media.map((asset: MediaAsset) => asset.displaySize)).toEqual(assets.map(asset => asset.displaySize));
    await target.goto(`${new URL("/", page.url()).href}#/project/example`);
    await expect(target.locator(".block-prose strong")).toHaveText("Важная идея");
    await expect.poll(() => target.locator(".media-image img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160);
    for (const tag of ["audio", "video"]) await expect.poll(() => target.locator(tag).evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(1);
    const model = target.locator(".model-preview"); await model.scrollIntoViewIfNeeded(); await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await targetContext.close(); }
});

test("invalid, incomplete, altered and oversized archives leave saved data untouched", async ({ page }) => {
  const library = smallLibrary(); await seed(page, library, [{ id: "shared-image", mime: "image/png", base64: pixel.toString("base64") }]);
  const before = await snapshot(page); await openBackups(page);
  const good = archive(library);
  const altered = { ...good.entries, [good.manifest.media[0].path]: Uint8Array.from(pixel, byte => byte ^ 1) };
  const missing = { ...good.entries }; delete missing[good.manifest.media[0].path];
  const future = { ...good.entries, "manifest.json": Buffer.from(JSON.stringify({ ...good.manifest, version: 99 })) };
  const oversized = Buffer.from(good.bytes); const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); oversized.writeUInt32LE(513 * 1024 * 1024, central + 24);
  for (const [bytes, text] of [[Buffer.from("not a ZIP"), "Не удалось открыть"], [Buffer.from(zipSync(altered)), "целостности файла"], [Buffer.from(zipSync(missing)), "отсутствует или повреждён"], [Buffer.from(zipSync(future)), "Неподдерживаемая версия"], [oversized, "превышает ограничение"]] as const) {
    await inspect(page, bytes); await expect(page.locator(".backup-error")).toContainText(text); await expect(page.locator(".backup-preview")).toHaveCount(0); expect(await snapshot(page)).toEqual(before);
  }
});

test("media and metadata write failures preserve old files even when imported IDs collide", async ({ page }) => {
  const library = smallLibrary(); await seed(page, library, [{ id: "shared-image", mime: "image/png", base64: pixel.toString("base64") }]);
  const before = await snapshot(page), incoming = smallLibrary(Buffer.from("new file")); incoming.projects[0].name = "Восстановленная идея";
  const bytes = archive(incoming, new Map([["shared-image", Buffer.from("new file")]])).bytes;
  await openBackups(page);
  for (const failure of ["media", "metadata"]) {
    await inspect(page, bytes); await expect(page.locator(".backup-preview")).toBeVisible();
    await page.evaluate(({ failure, key }) => {
      const state = window as unknown as { restorePatch?: () => void };
      if (failure === "media") { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException("Disk full", "QuotaExceededError"); }; state.restorePatch = () => { IDBObjectStore.prototype.put = put; }; }
      else { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException("Disk full", "QuotaExceededError"); return set.call(this, name, value); }; state.restorePatch = () => { Storage.prototype.setItem = set; }; }
    }, { failure, key: STORAGE_KEY });
    await page.getByRole("button", { name: "Заменить библиотеку", exact: true }).click();
    await expect(page.locator(".backup-error")).toContainText("Прежняя библиотека сохранена");
    expect(await snapshot(page)).toEqual(before);
    await page.evaluate(() => (window as unknown as { restorePatch: () => void }).restorePatch());
  }
});

test("missing media abort export and unsaved editing locks backup controls", async ({ page }) => {
  await seed(page, smallLibrary(), []); await openBackups(page);
  await page.getByRole("button", { name: "Экспортировать ZIP", exact: true }).click();
  await expect(page.locator(".backup-error")).toContainText("Не найден файл «reference.png»");
  await page.getByRole("button", { name: "Понятно", exact: true }).click();
  await page.goto("/#/project/example"); await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Заголовок блока", { exact: true }).first().fill("Черновик"); await openBackups(page);
  await expect(page.getByRole("button", { name: "Экспортировать ZIP", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Выбрать архив библиотеки", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Понятно", exact: true }).click(); await expect(page.getByLabel("Заголовок блока", { exact: true }).first()).toHaveValue("Черновик");
});

test("incompatible raw data can be downloaded before explicit recovery", async ({ page }) => {
  await page.goto("/"); await page.evaluate(key => localStorage.setItem(key, '{"version":99,"saved":"keep me"}'), STORAGE_KEY); await page.reload();
  await openBackups(page);
  await expect(page.getByRole("button", { name: "Экспортировать ZIP", exact: true })).toBeDisabled();
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "скачать исходные данные", exact: true }).click();
  expect(await readFile((await (await downloaded).path())!, "utf-8")).toBe('{"version":99,"saved":"keep me"}');
  await inspect(page, archive(smallLibrary()).bytes); await expect(page.locator(".backup-preview")).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{"version":99,"saved":"keep me"}');
  await page.getByRole("button", { name: "Заменить библиотеку", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload(); await expect(page.locator(".storage-warning")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Создать раздел", exact: true }).last()).toBeEnabled();
  expect(JSON.parse((await snapshot(page)).raw!).projects[0].name).toBe("Моя сохранённая идея");
});

test("a library changed during staging is preserved instead of overwritten", async ({ page }) => {
  const library = smallLibrary(); await seed(page, library, [{ id: "shared-image", mime: "image/png", base64: pixel.toString("base64") }]);
  const before = await snapshot(page), changed = structuredClone(library); changed.projects[0].name = "Изменения из другой вкладки";
  await openBackups(page); await inspect(page, archive(library).bytes); await expect(page.locator(".backup-preview")).toBeVisible();
  await page.evaluate(({ changed, key }) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) { localStorage.setItem(key, JSON.stringify(changed)); return put.apply(this, args); };
  }, { changed, key: STORAGE_KEY });
  await page.getByRole("button", { name: "Заменить библиотеку", exact: true }).click(); await expect(page.locator(".backup-error")).toContainText("другой вкладке");
  const after = await snapshot(page); expect(JSON.parse(after.raw!)).toEqual(changed); expect(after.files).toEqual(before.files);
});

test("Example is the only starter idea and reset requires explicit replacement", async ({ page }) => {
  expect(demoLibrary.projects).toHaveLength(1); expect(demoLibrary.projects[0].name).toBe("Example");
  await page.goto("/"); await expect(page.locator(".project-card")).toHaveCount(1);
  const personal = smallLibrary();
  await seed(page, personal, [{ id: "shared-image", mime: "image/png", base64: pixel.toString("base64") }]);
  const before = await snapshot(page); await openBackups(page);
  await page.getByRole("button", { name: "Загрузить Example", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Пример Example", exact: true })).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole("button", { name: "Отмена", exact: true }).click(); expect(await snapshot(page)).toEqual(before);
  await page.getByRole("button", { name: "Загрузить Example", exact: true }).click();
  await page.getByRole("button", { name: "Заменить библиотеку", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); await page.reload();
  await expect(page.locator(".project-card")).toHaveCount(1); await expect(page.locator(".project-card > strong")).toHaveText("Example");
  const restored = JSON.parse((await snapshot(page)).raw!);
  restored.projects[0].blocks[1].media.forEach((asset: MediaAsset, index: number) => {
    expect(asset.id).not.toBe(demoLibrary.projects[0].blocks[1].media![index].id);
    asset.id = demoLibrary.projects[0].blocks[1].media![index].id;
  });
  expect(restored).toEqual(demoLibrary);
  await expect.poll(async () => (await snapshot(page)).files.length).toBe(2);
});
