import { getOwnerSession } from "@/auth";
import { readAuthSettings } from "./auth-settings";
import { B2Storage, noStore, readB2Settings } from "./b2-storage";
import { MAX_CLOUD_JSON_BYTES, StorageError } from "./cloud-library";

/** Bound bytes before JSON parsing, including requests without a Content-Length header. */
export async function readStorageBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) throw new StorageError(415, "JSON_REQUIRED", "Нужен JSON-запрос.");
  const reader = request.body?.getReader();
  if (!reader) throw new StorageError(400, "INVALID_DATA", "Пустой запрос.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CLOUD_JSON_BYTES) { await reader.cancel(); throw new StorageError(413, "LIBRARY_TOO_LARGE", "JSON-запрос превышает 3 МиБ."); }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(400, "INVALID_DATA", "Не удалось прочитать JSON.");
  } finally { reader.releaseLock(); }
}

/** All cloud endpoints require the configured owner; mutation also checks the exact Origin. */
export async function storageEndpoint(request: Request, mutation: boolean, run: (storage: B2Storage) => Promise<unknown>) {
  try {
    if (readAuthSettings().mode !== "github" || !await getOwnerSession()) throw new StorageError(401, "UNAUTHORIZED", "Войди через GitHub владельца.");
    if (mutation && (request.headers.get("origin") !== new URL(process.env.AUTH_URL!).origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new StorageError(403, "ORIGIN_DENIED", "Запрос с другого сайта запрещён.");
    const storage = new B2Storage(readB2Settings());
    try { return Response.json(await run(storage), { headers: { ...noStore, Vary: "Cookie" } }); }
    finally { storage.client.destroy(); }
  } catch (error) {
    const problem = error instanceof StorageError ? error : new StorageError(502, "STORAGE_UNAVAILABLE", "Не удалось обратиться к B2. Повтори запрос позже.");
    // Do not expose SDK errors: they can contain signed URLs, request headers and account details.
    return Response.json({ error: { code: problem.code, message: problem.message, ...(problem.revisions ? { revisions: problem.revisions } : {}) } }, { status: problem.status, headers: { ...noStore, Vary: "Cookie" } });
  }
}
