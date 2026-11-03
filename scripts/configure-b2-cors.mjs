import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

/** Run explicitly with --apply; only the named private bucket and this app's rule are changed. */
async function configure() {
  for (const key of ["AUTH_URL", "B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_NAME"]) if (!process.env[key]) throw new Error("Missing settings");
  const origin = new URL(process.env.AUTH_URL).origin;
  async function fetchJson(url, init) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`B2 HTTP ${response.status}`);
    return response.json();
  }
  const auth = await fetchJson("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", { headers: { Authorization: `Basic ${Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APPLICATION_KEY}`).toString("base64")}` } });
  const storage = auth.apiInfo.storageApi;
  if (!/^https:\/\/api\d*\.backblazeb2\.com$/.test(storage.apiUrl)) throw new Error("Unexpected B2 endpoint");
  const post = (operation, value) => fetchJson(`${storage.apiUrl}/b2api/v3/${operation}`, { method: "POST", headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const { buckets } = await post("b2_list_buckets", { accountId: auth.accountId, bucketName: process.env.B2_BUCKET_NAME });
  const bucket = buckets.find(bucket => bucket.bucketName === process.env.B2_BUCKET_NAME);
  if (!bucket || bucket.bucketType !== "allPrivate") throw new Error("Expected a private bucket");
  const name = "idea-bank-browser-sync";
  const rules = [...(bucket.corsRules || [])], index = rules.findIndex(rule => rule.corsRuleName === name), old = rules[index];
  const rule = {
    corsRuleName: name,
    allowedOrigins: [...new Set([...(old?.allowedOrigins || []), origin])],
    allowedOperations: [...new Set([...(old?.allowedOperations || []), "s3_get", "s3_put", "s3_head"])],
    allowedHeaders: old?.allowedHeaders?.includes("*") ? ["*"] : [...new Set([...(old?.allowedHeaders || []).map(value => value.toLowerCase()), "content-type", "content-md5", "x-amz-meta-sha256"])],
    exposeHeaders: [...new Set([...(old?.exposeHeaders || []).map(value => value.toLowerCase()), "etag"])], maxAgeSeconds: 3600,
  };
  const sameRule = old && old.maxAgeSeconds === rule.maxAgeSeconds && ["allowedOrigins", "allowedOperations", "allowedHeaders", "exposeHeaders"].every(key => JSON.stringify([...(old[key] || [])].sort()) === JSON.stringify([...rule[key]].sort()));
  if (sameRule) { console.log("B2 CORS is already configured for the application origin."); return; }
  if (!process.argv.includes("--apply")) { console.log("B2 CORS needs an application rule. Run with --apply to add it; credentials will not be displayed."); return; }
  if (!storage.capabilities.includes("writeBuckets")) throw new Error("Key cannot configure CORS");
  if (index < 0) rules.push(rule); else rules[index] = rule;
  const result = await post("b2_update_bucket", { accountId: auth.accountId, bucketId: bucket.bucketId, ifRevisionIs: bucket.revision, corsRules: rules });
  if (result.bucketType !== "allPrivate" || !result.corsRules.some(item => item.corsRuleName === name && item.allowedOrigins.includes(origin))) throw new Error("CORS verification failed");
  console.log("B2 CORS configured for the application origin. Other rules preserved; bucket remains private.");
}
configure().catch(() => { console.error("Could not configure B2 CORS. Check settings, bucket permissions and connectivity. Secret values were not displayed."); process.exitCode = 1; });
