import { createHash, createHmac } from "node:crypto";

type Environment = Record<string, string | undefined>;
type EventSettings = { key: string; keyName: string; keySecret: string; channel: string };
const tokenLifetimeSeconds = 15 * 60;
const publishTimeoutMs = 1500;

/** Derive one opaque channel per owner and storage, without exposing bucket/account names. */
function readSettings(env: Environment): EventSettings | null {
  const key = env.ABLY_API_KEY?.trim();
  if (!key || !/^[\w-]+\.[\w-]+:[A-Za-z0-9+/=_-]+$/.test(key)) return null;
  const scope = [env.B2_S3_ENDPOINT, env.B2_BUCKET_NAME, env.IDEA_BANK_OWNER_ID];
  if (scope.some(value => !value?.trim())) return null;
  const [keyName, keySecret] = key.split(":");
  const channel = `idea-bank:sync:${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
  return { key, keyName, keySecret, channel };
}

/** Issue a short-lived subscribe-only JWT. Call only after owner/session and Origin checks. */
export function createSyncEventToken(env: Environment = process.env, now = Date.now()) {
  const settings = readSettings(env);
  if (!settings) return { enabled: false as const };
  const issued = Math.floor(now / 1000), expires = issued + tokenLifetimeSeconds;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "HS256", kid: settings.keyName })}.${encode({
    iat: issued, exp: expires, "x-ably-capability": JSON.stringify({ [settings.channel]: ["subscribe"] }),
  })}`;
  const signature = createHmac("sha256", settings.keySecret).update(unsigned).digest("base64url");
  return { enabled: true as const, channel: settings.channel, token: `${unsigned}.${signature}`, expiresAt: expires * 1000 };
}

/** A notification is only a hint. Bound its latency and never expose provider errors or credentials. */
export async function publishSyncEvent(revision: string, env: Environment = process.env, send: typeof fetch = fetch,keys?:string[]): Promise<boolean> {
  const settings = readSettings(env);
  if (!settings || !/^[a-f0-9-]{36}$/.test(revision)) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, publishTimeoutMs); });
    const publish = send(`https://rest.ably.io/channels/${encodeURIComponent(settings.channel)}/messages`, {
      method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Basic ${Buffer.from(settings.key).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "library-changed", data: keys && keys.length<=128 ? {version:2,revision,keys} : { version: 1, revision } }),
    }).then(response => {
      void response.body?.cancel().catch(() => {});
      return response.ok;
    }).catch(() => false);
    return await Promise.race([publish, timeout]);
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Publish only after the storage manifest commits, including an idempotent save retry. */
export async function saveAndNotify<T extends { revision: string }>(save: () => Promise<T>, env: Environment = process.env, send: typeof fetch = fetch,changes?:unknown): Promise<T> {
  const result = await save();
  const keys=Array.isArray(changes)?changes.map(change=>change?.key).filter((key):key is string=>typeof key==="string" && key.length<=500):undefined;
  await publishSyncEvent(result.revision, env, send,keys);
  return result;
}
