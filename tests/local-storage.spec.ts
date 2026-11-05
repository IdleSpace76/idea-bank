import { test, expect } from "@playwright/test";
import { demoLibrary, type IdeaSummary, type Library } from "../lib/ideas";
import { deleteLocalDatabase, exposeLibraryStore, readStoredLibrary, setStoredLibrary } from "./local-fixture";
const modulePath = "/__local_fixture__/library-store.js";
const fixture = (): Library => ({ version: 1, sections: [{ id: "s", name: "Personal", description: "", icon: "folder" }], projects: [{ ...demoLibrary.projects[0], id: "personal", sectionId: "s", name: "Personal idea", blocks: [{ id: "b", heading: "Heading", text: "Keep me" }] }] });

test("catalog pages read only requested metadata; opening an idea reads only its blocks", async ({ page }) => {
  await page.goto("/"); await expect(page.locator("main h1")).toBeVisible(); await exposeLibraryStore(page);
  const library = fixture();
  library.projects = Array.from({ length: 61 }, (_, index) => ({ ...library.projects[0], id: `idea-${index}`, name: `Idea ${index}`,
    blocks: [{ id: "b", heading: "Heading", text: `Body ${index}` }, { id: "second", heading: "", text: "Second body" }] }));
  await setStoredLibrary(page, library);
  // Measure the storage API independently of the application's background sidebar reads.
  await page.goto("/__storage_probe__");
  const result = await page.evaluate(async path => {
    const store = await import(path);
    const reads: { store: string; key: unknown }[] = [];
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) { reads.push({ store: this.name, key }); return original.call(this, key); };
    try {
      const sections = await store.readLocalSections(); const sectionReads = reads.splice(0);
      const first = await store.readLocalCatalogPage(); const firstReads = reads.splice(0);
      const second = await store.readLocalCatalogPage({ cursor: first.nextCursor });
      const third = await store.readLocalCatalogPage({ cursor: second.nextCursor }); reads.splice(0);
      const detail = await store.readLocalIdea("idea-29"); const detailReads = reads.splice(0);
      const missing = await store.readLocalIdea("missing");
      return { sections, sectionReads, first, second, third, firstReads, detail, detailReads, missing };
    } finally { IDBObjectStore.prototype.get = original; }
  }, modulePath);
  expect(result.sections.sections).toEqual(library.sections);
  expect(result.sectionReads.map(r => r.store)).toEqual(["meta", "sections"]);
  expect([result.first.ideas.length, result.second.ideas.length, result.third.ideas.length]).toEqual([24, 24, 13]);
  expect([...result.first.ideas, ...result.second.ideas, ...result.third.ideas].map(idea => idea.id)).toEqual(library.projects.map(idea => idea.id));
  expect(result.first.ideas.every((idea: IdeaSummary) => !Object.hasOwn(idea, "blocks"))).toBe(true);
  expect(result.firstReads.filter(r => r.store === "ideas")).toHaveLength(24);
  expect(result.firstReads.some(r => r.store === "blocks" || r.store === "media")).toBe(false);
  expect(result.third.nextCursor).toBeNull();
  expect(result.detail.idea).toEqual(library.projects[29]);
  expect(result.detailReads.filter(r => r.store === "ideas").map(r => r.key)).toEqual(["idea-29"]);
  expect(result.detailReads.filter(r => r.store === "blocks").map(r => r.key)).toEqual(['["idea-29","b"]', '["idea-29","second"]']);
  expect(result.detailReads.some(r => r.store === "media")).toBe(false);
  expect(result.missing).toBeNull();
  expect(await page.evaluate(readStoredLibrary)).toEqual(library);
});

test("catalog pagination rejects stale cursors and invalid bounds without changing data", async ({ page }) => {
  await page.goto("/"); await expect(page.locator("main h1")).toBeVisible(); await exposeLibraryStore(page);
  const result = await page.evaluate(async path => {
    const store = await import(path), initial = await store.readLocalSnapshot();
    const failed = async (work: () => Promise<unknown>) => { try { await work(); return false; } catch { return true; } };
    const invalid = await Promise.all([0, -1, 101, 1.5, NaN].map(limit => failed(() => store.readLocalCatalogPage({ limit }))));
    const badCursor = await failed(() => store.readLocalCatalogPage({ cursor: { offset: -1, revision: initial.revision } }));
    const empty = await store.readLocalCatalogPage({ cursor: { offset: 100, revision: initial.revision } });
    const next = structuredClone(initial.library); next.projects[0].description = "Changed during pagination";
    await store.saveLocalLibrary(next, initial.library);
    const stale = await failed(() => store.readLocalCatalogPage({ cursor: { offset: 0, revision: initial.revision } }));
    return { invalid, badCursor, empty, stale, fresh: await store.readLocalCatalogPage(), full: await store.readLocalLibrary() };
  }, modulePath);
  expect(result.invalid).toEqual([true, true, true, true, true]); expect(result.badCursor).toBe(true); expect(result.stale).toBe(true);
  expect(result.empty.ideas).toEqual([]); expect(result.empty.nextCursor).toBeNull();
  expect(result.fresh.ideas[0].description).toBe("Changed during pagination");
  expect(result.full.projects[0].blocks).toEqual(demoLibrary.projects[0].blocks);
});

test("starter provenance survives reload but not user saves, even when the content is unchanged", async ({ page }) => {
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);
  const pristine=()=>page.evaluate(async path=>{const store=await import(path);return store.isPristineStarter(await store.readLocalLibrary());},modulePath);
  expect(await pristine()).toBe(true);await page.reload();await expect(page.locator(".project-card > strong")).toHaveText("Example");expect(await pristine()).toBe(true);
  // Old clients stored provenance in migration metadata, without the explicit starter marker.
  await page.evaluate(async()=>{const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open("idea-bank.local",1);r.onsuccess=()=>resolve(r.result);});await new Promise<void>(resolve=>{const tx=db.transaction("meta","readwrite");tx.objectStore("meta").delete("starter");tx.oncomplete=()=>resolve();});db.close();});
  expect(await pristine()).toBe(true);
  const library=await page.evaluate(readStoredLibrary);await setStoredLibrary(page,library);expect(await pristine()).toBe(false);
});

test("an imported library is personal data even if it exactly matches Example", async ({ page }) => {
  await page.addInitScript(library=>localStorage.setItem("idea-bank.library.v1",JSON.stringify(library)),demoLibrary);
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);
  expect(await page.evaluate(async path=>{const store=await import(path);return store.isPristineStarter(await store.readLocalLibrary());},modulePath)).toBe(false);
});

test("legacy library and media migrate once; the legacy backup is not rewritten", async ({ page }) => {
  const library = fixture();
  library.projects[0].blocks[0].media = [{ id: "asset", name: "test.wav", kind: "audio", mime: "audio/wav", size: 3 }];
  await page.addInitScript(library => { if (!localStorage.getItem("idea-bank.library.v1")) localStorage.setItem("idea-bank.library.v1", JSON.stringify(library)); }, library);
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  // Add a legacy blob, then retry migration from the preserved source.
  await page.evaluate(deleteLocalDatabase);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("idea-bank.media.v1", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(new Blob([new Uint8Array([1,2,3])], { type: "audio/wav" }), "asset"); tx.oncomplete = () => resolve(); }); db.close();
  });
  await page.reload(); await expect(page.locator(".project-card > strong")).toHaveText("Personal idea");
  expect(await page.evaluate(readStoredLibrary)).toEqual(library);
  await exposeLibraryStore(page);
  const next = structuredClone(library); next.projects[0].name = "Changed after migration";
  await setStoredLibrary(page, next); await page.reload();
  expect(await page.evaluate(readStoredLibrary)).toEqual(next);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("idea-bank.library.v1")!))).toEqual(library);
  const bytes = await page.evaluate(async () => { const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("idea-bank.local"); r.onsuccess = () => resolve(r.result); }); const blob = await new Promise<Blob>(resolve => { const r = db.transaction("media").objectStore("media").get("asset"); r.onsuccess = () => resolve(r.result); }); db.close(); return [...new Uint8Array(await blob.arrayBuffer())]; });
  expect(bytes).toEqual([1,2,3]);
});

test("outbox coalesces changes, records deletion and survives reload", async ({ page }) => {
  await page.goto("/"); await expect(page.locator("main h1")).toBeVisible(); await exposeLibraryStore(page);
  const result = await page.evaluate(async ({ modulePath, library }) => {
    const store = await import(modulePath);
    await store.saveLocalLibrary(library, await store.readLocalLibrary());
    const initial = await store.readLocalSnapshot(); await store.acknowledgeUpload(null, initial.revision);
    const a = structuredClone(library); a.projects[0].blocks[0].text = "First";
    await store.saveLocalLibrary(a, library);
    const b = structuredClone(a); b.projects[0].blocks[0].text = "Second";
    await store.saveLocalLibrary(b, a);
    const queue = await store.readOutbox();
    await store.saveLocalLibrary(library, b);
    const reverted = await store.readOutbox();
    await store.saveLocalLibrary({ ...library, projects: [] }, library);
    return { queue, reverted, deleted: await store.readOutbox() };
  }, { modulePath, library: fixture() });
  expect(result.queue).toHaveLength(1); expect(result.queue[0].value.text).toBe("Second"); expect(result.queue[0].base.text).toBe("Keep me"); expect(result.reverted).toEqual([]);
  expect(result.deleted.filter((entry: { operation: string }) => entry.operation === "delete")).toHaveLength(2);
  await page.reload(); await exposeLibraryStore(page);
  expect(await page.evaluate(async modulePath => (await import(modulePath)).readOutbox(), modulePath)).toEqual(result.deleted);
});

test("aborted metadata or outbox writes leave records and queue unchanged", async ({ page }) => {
  await page.goto("/"); await expect(page.locator("main h1")).toBeVisible(); await exposeLibraryStore(page);
  for (const failingStore of ["ideas", "outbox", "meta"]) {
    const result = await page.evaluate(async ({ modulePath, failingStore }) => {
      const store = await import(modulePath), before = await store.readLocalSnapshot(), queue = await store.readOutbox();
      const next = structuredClone(before.library); next.projects[0].name = "Must not commit";
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) { if (this.name === failingStore) throw new DOMException("Disk full", "QuotaExceededError"); return original.apply(this, args); };
      let failed = false;
      try { await store.saveLocalLibrary(next, before.library); } catch { failed = true; } finally { IDBObjectStore.prototype.put = original; }
      return { failed, before, after: await store.readLocalSnapshot(), queue, afterQueue: await store.readOutbox() };
    }, { modulePath, failingStore });
    expect(result.failed).toBe(true); expect(result.after).toEqual(result.before); expect(result.afterQueue).toEqual(result.queue);
  }
});

test("two tabs cannot overwrite a stale snapshot; upload acknowledgment keeps newer changes", async ({ page, context }) => {
  await page.goto("/"); await expect(page.locator("main h1")).toBeVisible(); await exposeLibraryStore(page);
  const old = await page.evaluate(readStoredLibrary), other = await context.newPage(); await other.goto("/"); await expect(other.locator("main h1")).toBeVisible(); await exposeLibraryStore(other);
  const next = structuredClone(old); next.projects[0].name = "Other tab"; await setStoredLibrary(other, next);
  const conflict = await page.evaluate(async ({ modulePath, old }) => { const store = await import(modulePath); try { await store.saveLocalLibrary(old, old); return false; } catch { return true; } }, { modulePath, old });
  expect(conflict).toBe(true); expect(await page.evaluate(readStoredLibrary)).toEqual(next);
  const queued = await other.evaluate(async modulePath => {
    const store = await import(modulePath), before = await store.readLocalSnapshot();
    const next = structuredClone(before.library); next.projects[0].name = "Edit during upload";
    await store.saveLocalLibrary(next, before.library); await store.acknowledgeUpload({ marker: true }, before.revision);
    return store.readOutbox();
  }, modulePath);
  expect(queued).toHaveLength(1); expect(queued[0].value.name).toBe("Edit during upload");
});

test("interrupted migration retries without replacing the legacy library", async ({ page }) => {
  const library = fixture();
  await page.addInitScript(library => {
    localStorage.setItem("idea-bank.library.v1", JSON.stringify(library));
    if (!sessionStorage.getItem("failed-once")) {
      sessionStorage.setItem("failed-once", "true");
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) { if (this.name === "blocks") throw new DOMException("Interrupted", "QuotaExceededError"); return put.apply(this, args); };
    }
  }, library);
  await page.goto("/"); await expect(page.getByRole("alert").filter({ hasText: "Исходные данные" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("idea-bank.library.v1")!))).toEqual(library);
  await page.reload(); await expect(page.locator(".project-card > strong")).toHaveText("Personal idea"); expect(await page.evaluate(readStoredLibrary)).toEqual(library);
});

test("legacy sync journal migrates its committed checkpoint without changing the backup", async ({ page }) => {
  const library = fixture();
  await page.addInitScript(library => {
    const raw = JSON.stringify(library);
    localStorage.setItem("idea-bank.library.v1", raw);
    localStorage.setItem("idea-bank.cloud.v1", JSON.stringify({ journal: true, targetRaw: raw, previous: { revision: "previous" }, next: { revision: "committed" } }));
  }, library);
  await page.goto("/"); await expect(page.locator(".project-card > strong")).toHaveText("Personal idea"); await exposeLibraryStore(page);
  expect(await page.evaluate(async modulePath => (await import(modulePath)).readMeta("cloud"), modulePath)).toEqual({ revision: "committed" });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("idea-bank.cloud.v1")!).journal)).toBe(true);
});

test("an open details form cannot overwrite a newer block from another tab", async ({ page }) => {
  await page.goto("/#/project/example"); await expect(page.locator("main h1")).toBeVisible();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Название", { exact: true }).fill("Stale title");
  const changed = await page.evaluate(readStoredLibrary); changed.projects[0].blocks[0].text = "Newer block";
  await setStoredLibrary(page, changed);
  await page.getByRole("dialog").getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".storage-warning")).toContainText("другой вкладке");
  await expect(page.getByRole("dialog").getByLabel("Название", { exact: true })).toHaveValue("Stale title");
  expect(await page.evaluate(readStoredLibrary)).toEqual(changed);
});
