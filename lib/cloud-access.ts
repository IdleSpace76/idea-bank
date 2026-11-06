/** One authenticated owner per page. Share failures across reader and queued sync requests. */
export class CloudAccessError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
let failure: { until: number; error: CloudAccessError; sequence: number } | undefined;
let failures = 0, sequence = 0;
const reads = new Map<string, Promise<Response>>();
export const cloudBackoffRemaining = () => Math.max(0, (failure?.until || 0) - Date.now());
export const cloudAccessProblem = () => cloudBackoffRemaining() ? failure?.error : undefined;
/** Only an explicit retry bypasses the pause, not focus, notifications or local edits. */
export function retryCloudAccess() { failure = undefined; failures = 0; }
function rememberFailure(error:CloudAccessError,wait:number,current:number) {
  const active=failure && failure.until>Date.now();
  if(active && failure!.error.code==="STORAGE_ACCESS_DENIED" && error.code!=="STORAGE_ACCESS_DENIED")return;
  if(!failure || current>=failure.sequence || error.code==="STORAGE_ACCESS_DENIED")failure={
    until:Math.max(active?failure!.until:0,Date.now()+wait),error,sequence:Math.max(current,failure?.sequence || 0),
  };
}

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
        rememberFailure(new CloudAccessError(denied ? "STORAGE_ACCESS_DENIED" : "STORAGE_UNAVAILABLE", data?.error?.message || "Облако недоступно. Повторим запрос позже.", response.status),wait,current);
      } else if ((response.ok || response.status === 304) && (!failure || current >= failure.sequence && failure.until<=Date.now())) {
        failure = undefined; failures = 0;
      }
      return response;
    } catch (error) {
      rememberFailure(new CloudAccessError("NETWORK", "Нет связи с облаком. Локальные изменения сохранены.", 0),[5000,15000,60000,300000][Math.min(failures++,3)],current);
      throw error;
    }
  })();
  if (method === "GET") reads.set(key, operation);
  try { return (await operation).clone(); }
  finally { if (reads.get(key) === operation) reads.delete(key); }
}
