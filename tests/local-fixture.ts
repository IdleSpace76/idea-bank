import { readFile } from "node:fs/promises";
import ts from "typescript";
import type { Page } from "@playwright/test";
import type { Library } from "../lib/ideas";

/** Browser-side reader used by assertions without exposing a production debug API. */
export async function readStoredLibrary(): Promise<Library> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open("idea-bank.local", 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  try {
    const get = <T,>(store: string, id: IDBValidKey): Promise<T> => new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const layout = await get<{ sectionIds: string[]; ideaIds: string[] }>("meta", "layout");
    const sections = await Promise.all(layout.sectionIds.map(id => get<Library["sections"][number]>("sections", id)));
    const projects = await Promise.all(layout.ideaIds.map(async id => {
      const idea = await get<{ value: Library["projects"][number]; blockIds: string[] }>("ideas", id);
      const blocks = await Promise.all(idea.blockIds.map(block => get<Library["projects"][number]["blocks"][number]>("blocks", JSON.stringify([id, block]))));
      return { ...idea.value, blocks };
    }));
    return { version: 1, sections, projects };
  } finally { db.close(); }
}
export async function deleteLocalDatabase() {
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase("idea-bank.local"); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error("Database blocked")); });
}
/** Serve actual storage modules only in isolated Playwright routes. */
export async function exposeLibraryStore(page: Page) {
  const names = new Set(["library-store", "local-database", "ideas", "i18n", "translations", "rich-text", "example-media", "media-store","media-cache-store","entity-sync","cloud-library","reader-cache","library-reader","library-edit","scoped-store","scoped-types","scoped-overlay","sync-lock","block-drafts","cloud-access","reader-batch-types"]);
  await page.route("**/__local_fixture__/*.js", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!.replace(/\.js$/, "");
    if (!names.has(name)) return route.abort();
    const source = await readFile(`lib/${name}.ts`, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/from "\.\/([\w-]+)"/g, 'from "./$1.js"');
    await route.fulfill({ contentType: "text/javascript", body: code });
  });
}
export async function setStoredLibrary(page: Page, library: Library) {
  await exposeLibraryStore(page);
  await page.evaluate(async ({ library, modulePath }) => { const store = await import(modulePath); const old = await store.readLocalSnapshot(); await store.saveLocalLibrary(library, old?.library || null); }, { library, modulePath: "/__local_fixture__/library-store.js" });
}
