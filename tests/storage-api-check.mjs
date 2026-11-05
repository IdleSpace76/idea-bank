import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/storage-api.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
class StorageError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
let destroyed = 0;
const logs = [], exports = {};
const modules = {
  "@/auth": { getOwnerSession: async () => ({ owner: true }) },
  "./auth-settings": { readAuthSettings: () => ({ mode: "github" }) },
  "./b2-storage": { B2Storage: class { client = { destroy() { destroyed++; } }; }, readB2Settings: () => ({}), noStore: { "Cache-Control": "private, no-store" } },
  "./cloud-library": { StorageError, MAX_CLOUD_JSON_BYTES: 3 * 1024 * 1024 },
};
vm.runInNewContext(compiled, { exports, require: name => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; }, Response, Buffer, console: { error: (...args) => logs.push(args) } });
const request = new Request("https://fixture.invalid/api/catalog");
const secret = "fixture-secret-do-not-log";
const failure = Object.assign(new Error(secret), {
  name: "AccessDenied", $metadata: { httpStatusCode: 403, requestId: secret },
  $response: { headers: { authorization: secret } }, stack: secret,
});
let response = await exports.storageEndpoint(request, false, async () => { throw failure; });
assert.equal(response.status, 503);
assert.equal(response.headers.get("Retry-After"), "300");
assert.equal((await response.json()).error.code, "STORAGE_ACCESS_DENIED");
assert.deepEqual(JSON.parse(JSON.stringify(logs[0][1])), { code: "STORAGE_ACCESS_DENIED", status: 503, errorType: "AccessDenied", upstreamStatus: 403 });

await exports.storageEndpoint(request, false, async () => { throw Object.assign(new Error(secret), { name: secret, code: secret, $metadata: { httpStatusCode: secret } }); });
assert.equal(logs[1][1].errorType, "OtherError");
assert.equal(JSON.stringify(logs).includes(secret), false);
await exports.storageEndpoint(request, false, async () => { throw Object.assign(new Error(secret), { cause: { code: "ECONNRESET" } }); });
assert.equal(logs[2][1].networkCode, "ECONNRESET");

response = await exports.storageEndpoint(request, false, async () => { throw new StorageError(409, "CONFLICT", secret); });
assert.equal(response.status, 409);
assert.equal(logs.length, 3, "Expected client conflicts do not generate server error logs");
response = await exports.storageEndpoint(request, false, async () => ({ ok: true }));
assert.equal(response.status, 200);
assert.equal(logs.length, 3);
assert.equal(destroyed, 5, "Every storage client is closed, including failed requests");
console.log("Storage API diagnostics: status, redaction, network errors and cleanup passed.");
