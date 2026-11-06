import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { memoryStorage, schema } from "./entity-fixture.mjs";

const source = await readFile(new URL("../lib/sync-events-server.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createSyncEventToken, publishSyncEvent, saveAndNotify } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const env = { ABLY_API_KEY: "fixture.test:synthetic-secret", B2_S3_ENDPOINT: "https://s3.test.example", B2_BUCKET_NAME: "fixture-bucket", IDEA_BANK_OWNER_ID: "12345" };
const now = 1793800000000;
assert.deepEqual(createSyncEventToken({}), { enabled: false });
for (const change of [{ ABLY_API_KEY: "invalid" }, { B2_BUCKET_NAME: "" }, { IDEA_BANK_OWNER_ID: "" }]) {
  assert.deepEqual(createSyncEventToken({ ...env, ...change }), { enabled: false });
}
const issued = createSyncEventToken(env, now);
const [header, payload, signature] = issued.token.split(".");
assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { typ: "JWT", alg: "HS256", kid: "fixture.test" });
const claims = JSON.parse(Buffer.from(payload, "base64url"));
assert.equal(signature, createHmac("sha256", "synthetic-secret").update(`${header}.${payload}`).digest("base64url"));
assert.equal(claims.iat, now / 1000);
assert.equal(claims.exp - claims.iat, 900);
assert.equal(issued.expiresAt, claims.exp * 1000);
assert.deepEqual(JSON.parse(claims["x-ably-capability"]), { [issued.channel]: ["subscribe"] });
assert.ok(!issued.token.includes(env.ABLY_API_KEY));
assert.ok(!issued.channel.includes(env.B2_BUCKET_NAME));
assert.equal(createSyncEventToken(env, now + 1000).channel, issued.channel);
for (const change of [{ B2_BUCKET_NAME: "other-bucket" }, { IDEA_BANK_OWNER_ID: "67890" }, { B2_S3_ENDPOINT: "https://other.example" }]) {
  assert.notEqual(createSyncEventToken({ ...env, ...change }, now).channel, issued.channel);
}

const revision = randomUUID(), result = { revision }, calls = [];
let saved = false;
const send = async (url, init) => {
  assert.ok(saved, "Notify only after a committed save");
  calls.push({ url, init });
  return new Response(null, { status: 201 });
};
assert.equal(await saveAndNotify(async () => { saved = true; return result; }, env, send), result);
assert.equal(calls.length, 1);
assert.equal(calls[0].url, `https://rest.ably.io/channels/${encodeURIComponent(issued.channel)}/messages`);
assert.equal(calls[0].init.redirect, "error");
assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(env.ABLY_API_KEY).toString("base64")}`);
assert.deepEqual(JSON.parse(calls[0].init.body), { name: "library-changed", data: { version: 1, revision } });
const hints=[];
await saveAndNotify(async()=>result,env,async(_url,init)=>{hints.push(JSON.parse(init.body));return new Response(null,{status:201});},[{key:'idea:["example"]',value:{name:"Private title"}}]);
assert.deepEqual(hints,[{name:"library-changed",data:{version:2,revision,keys:['idea:["example"]']}}]);
assert.ok(!JSON.stringify(hints).includes("Private title"));
await assert.rejects(() => saveAndNotify(async () => { throw new Error("Storage failed"); }, env, send), /Storage failed/);
assert.equal(calls.length, 1, "Failed save sends no event");
assert.equal(await saveAndNotify(async () => result, env, send), result);
assert.equal(calls.length, 2, "Retry can notify again if an earlier notification was lost");
const never = () => { throw new Error("Must not contact Ably"); };
assert.equal(await publishSyncEvent(revision, {}, never), false);
assert.equal(await publishSyncEvent("bad", env, never), false);
for (const failing of [async () => { throw new Error("Provider error with private headers"); }, async () => new Response(null, { status: 429 }), async () => new Response(null, { status: 500 })]) {
  assert.equal(await saveAndNotify(async () => result, env, failing), result, "Notification failure cannot undo a save");
}
let signal;
const started = Date.now();
assert.equal(await saveAndNotify(async () => result, env, async (_url, init) => { signal = init.signal; return new Promise(() => {}); }), result);
assert.ok(signal.aborted);
assert.ok(Date.now() - started < 4000, "Even a nonresponsive transport cannot hold a save indefinitely");

// Exercise the actual manifest commit boundary with synthetic B2 objects.
const fixture = memoryStorage();
try {
  const library = { version: 1, sections: [{ id: "s", name: "Fixture", description: "", icon: "folder" }], projects: [] };
  const input = { operationId: randomUUID(), heads: [], changes: Object.entries(schema.flattenLibrary(library)).map(([key, value]) => ({ key, value, base: [] })) };
  let notifications = 0;
  const readableAtPublish = [];
  const verifyCommit = async (_url, init) => {
    notifications++;
    const notification = JSON.parse(init.body);
    const read = await fixture.entities().read();
    readableAtPublish.push(read.heads.includes(notification.data.revision));
    return new Response(null, { status: 201 });
  };
  await saveAndNotify(() => fixture.entities().save(input), env, verifyCommit);
  await saveAndNotify(() => fixture.entities().save(input), env, verifyCommit);
  assert.equal(notifications, 2);
  assert.deepEqual(readableAtPublish, [true, true], "Events reference fully readable cloud manifests");
  const sendToStorage = fixture.storage.client.send.bind(fixture.storage.client);
  fixture.storage.client.send = async command => {
    if (command.constructor.name === "PutObjectCommand" && command.input.Key.includes("/indexes/")) throw new Error("Manifest commit failed");
    return sendToStorage(command);
  };
  const cloud = await fixture.entities().read();
  const changed = { operationId: randomUUID(), heads: cloud.heads, changes: [{ key: cloud.records[0].key, base: [cloud.records[0].revision], value: { ...cloud.records[0].value, name: "Changed" } }] };
  await assert.rejects(() => saveAndNotify(() => fixture.entities().save(changed), env, verifyCommit), /Manifest commit failed/);
  assert.equal(notifications, 2, "An interrupted manifest write must never notify readers");
} finally { fixture.storage.client.destroy(); }
console.log("Sync event checks passed: scoped signed tokens, metadata-only notifications, commit ordering, retries and bounded provider failures.");
