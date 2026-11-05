/** One authenticated owner per page. Share failures across reader and queued sync requests. */
export class CloudAccessError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
let failure: { until: number; error: CloudAccessError; sequence: number } | undefined;
let failures = 0, sequence = 0;
const reads = new Map<string, Promise<Response>>();
export const cloudBackoffRemaining = () => Math.max(0, (failure?.until || 0) - Date.now());
/** Only an explicit retry bypasses the pause, not focus, notifications or local edits. */
export function retryCloudAccess() { failure = undefined; failures = 0; }

export async function cloudFetch(path: string, init: RequestInit, scope = ""): Promise<Response> {
  if (cloudBackoffRemaining() && failure) throw failure.error;
  const method = init.method || "GET";
  const key = JSON.stringify([scope,path,[...new Headers(init.headers).entries()].sort()]);
  if (method === "GET") {
    const existing = reads.get(key);
    if (existing) return (await existing).clone();
  }
  const current = ++sequence;
  const operation = (async () => {
    try {
      const response = await fetch(path, init);
      if (response.status >= 500 || response.status === 429) {
        const data = await response.clone().json().catch(() => null);
        const denied = data?.error?.code === "STORAGE_ACCESS_DENIED";
        const wait = denied ? 300000 : [5000,15000,60000,300000][Math.min(failures++,3)];
        if (!failure || current >= failure.sequence) failure = {
          until: Date.now() + wait, sequence: current,
          error: new CloudAccessError(denied ? "STORAGE_ACCESS_DENIED" : "STORAGE_UNAVAILABLE", data?.error?.message || "Облако недоступно. Повторим запрос позже.", response.status),
        };
      } else if ((response.ok || response.status === 304) && (!failure || current >= failure.sequence)) {
        failure = undefined; failures = 0;
      }
      return response;
    } catch (error) {
      if (!failure || current >= failure.sequence) failure = {
        until: Date.now() + [5000,15000,60000,300000][Math.min(failures++,3)], sequence: current,
        error: new CloudAccessError("NETWORK", "Нет связи с облаком. Локальные изменения сохранены.", 0),
      };
      throw error;
    }
  })();
  if (method === "GET") reads.set(key, operation);
  try { return (await operation).clone(); }
  finally { if (reads.get(key) === operation) reads.delete(key); }
}
