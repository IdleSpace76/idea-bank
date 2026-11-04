import { translate as t } from "./i18n";

export const LOCAL_DATABASE = "idea-bank.local";
export const stores = ["sections", "ideas", "blocks", "media", "outbox", "meta"] as const;
export function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
export function openLocalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(LOCAL_DATABASE, 1);
    opening.onupgradeneeded = () => { for (const name of stores) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name); };
    opening.onsuccess = () => { const db = opening.result; if (blocked) { db.close(); return; } db.onversionchange = () => db.close(); resolve(db); };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error(t("Закрой другие вкладки приложения и повтори сохранение."))); };
  });
}
/** Resolves only after commit; every thrown error aborts the entire transaction. */
export async function transaction<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openLocalDatabase();
  try {
    const tx = db.transaction(names, mode);
    const finished = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error("Local transaction aborted")); });
    // Attach a rejection handler before awaiting requests to avoid an unhandled abort.
    void finished.catch(() => {});
    try { const result = await work(tx); await finished; return result; }
    catch (error) { try { tx.abort(); } catch {} await finished.catch(() => {}); throw error; }
  } finally { db.close(); }
}
