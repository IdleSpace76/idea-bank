import { translate as t } from "./i18n";

export const LOCAL_DATABASE = "idea-bank.local";
export const stores = ["sections", "ideas", "blocks", "media", "outbox", "meta"] as const;
let connection:Promise<IDBDatabase>|undefined;
let currentDatabase:IDBDatabase|undefined;
export function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
export function openLocalDatabase(): Promise<IDBDatabase> {
  if(connection)return connection;
  const pending=new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(LOCAL_DATABASE, 1);
    opening.onupgradeneeded = () => { for (const name of stores) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name); };
    opening.onsuccess = () => {
      const db = opening.result;
      if (blocked) { db.close(); return; }
      currentDatabase=db;
      const forget=()=>{if(currentDatabase===db){connection=undefined;currentDatabase=undefined;}};
      db.onversionchange=()=>{forget();db.close();};
      db.onclose=forget;
      resolve(db);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error(t("Закрой другие вкладки приложения и повтори сохранение."))); };
  });
  connection=pending;
  void pending.catch(()=>{if(connection===pending)connection=undefined;});
  return pending;
}
/** Resolves only after commit; every thrown error aborts the entire transaction. */
export async function transaction<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  let db = await openLocalDatabase(),tx:IDBTransaction;
  try {tx=db.transaction(names,mode);}
  catch(error) {
    // A forced/explicitly closed connection may not deliver a close event. Retry before work only.
    if(!(error instanceof DOMException) || error.name!=="InvalidStateError")throw error;
    if(currentDatabase===db){connection=undefined;currentDatabase=undefined;}
    db=await openLocalDatabase();tx=db.transaction(names,mode);
  }
  const finished = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error("Local transaction aborted")); });
  // Attach a rejection handler before awaiting requests to avoid an unhandled abort.
  void finished.catch(() => {});
  try { const result = await work(tx); await finished; return result; }
  catch (error) { try { tx.abort(); } catch {} await finished.catch(() => {}); throw error; }
}
