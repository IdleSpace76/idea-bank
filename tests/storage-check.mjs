import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import { chromium } from "@playwright/test";

// Compile the actual server modules for Node without adding production test bypasses.
const directory = new URL("../.cache/storage-check/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const name of ["example-media", "rich-text", "ideas", "cloud-library", "b2-storage"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(new URL(`${name}.js`, directory), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
}
const require = createRequire(import.meta.url);
const { B2Storage, readB2Settings } = require(new URL("b2-storage.js", directory).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { StorageError, parseCloudSave, parseCloudMedia } = require(new URL("cloud-library.js", directory).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { demoLibrary } = require(new URL("ideas.js", directory).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// Storage fixtures supply their own attachment bytes.
for (const idea of demoLibrary.projects) for (const block of idea.blocks) delete block.media;
const { ListObjectVersionsCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
const { loadEnvConfig } = require("@next/env");

const settings = { endpoint: "https://s3.eu-central-003.backblazeb2.com", region: "eu-central-003", bucket: "example-test-bucket", keyId: "fixture-key", applicationKey: "fixture-secret" };
const body = Buffer.from("Idea Bank storage check\n");
const media = { id: randomUUID(), sha256: createHash("sha256").update(body).digest("hex"), md5: createHash("md5").update(body).digest("hex"), size: body.length, mime: "image/png" };
const library = structuredClone(demoLibrary);
library.projects[0].blocks[0].media = [{ id: media.id, name: "fixture.png", kind: "image", mime: media.mime, size: media.size }];
library.projects[0].coverImage = { ...library.projects[0].blocks[0].media[0] };
const emptySave = { baseRevisions: [], library: demoLibrary, media: [] };
const mediaSave = { baseRevisions: [], library, media: [media] };
async function rejects(operation, code) { await assert.rejects(operation, error => error instanceof StorageError && error.code === code); }

function memoryStorage() {
  const storage = new B2Storage(settings), objects = new Map();
  storage.client.send = async command => {
    const input = command.input, name = command.constructor.name;
    if (name === "ListObjectsV2Command") return { Contents: [...objects.keys()].filter(key => key.startsWith(input.Prefix)).map(Key => ({ Key })) };
    if (name === "PutObjectCommand") { assert.ok(!objects.has(input.Key), "Existing objects are never overwritten"); objects.set(input.Key, { body: input.Body, type: input.ContentType, metadata: input.Metadata, md5: createHash("md5").update(input.Body).digest("hex") }); return {}; }
    const object = objects.get(input.Key);
    if (!object) { const error = new Error("fixture missing"); error.name = "NotFound"; throw error; }
    if (name === "HeadObjectCommand") return { ContentLength: Buffer.byteLength(object.body), ContentType: object.type, Metadata: object.metadata, ETag: `"${object.md5}"` };
    if (name === "GetObjectCommand") return { ContentLength: Buffer.byteLength(object.body), Body: { transformToString: async () => String(object.body) } };
    throw new Error("Unexpected fixture command");
  };
  return { storage, objects };
}

async function unitChecks() {
  assert.throws(() => readB2Settings({}), error => error.code === "STORAGE_NOT_CONFIGURED");
  assert.throws(() => readB2Settings({ B2_S3_ENDPOINT: "https://example.org", B2_REGION: settings.region, B2_BUCKET_NAME: settings.bucket, B2_KEY_ID: "fixture", B2_APPLICATION_KEY: "fixture" }), error => error.code === "STORAGE_NOT_CONFIGURED");
  for (const value of [{ ...media, mime: "image/svg+xml" }, { ...media, size: 2 ** 31 }, { ...media, sha256: "../bad" }, { ...media, md5: "bad" }]) assert.throws(() => parseCloudMedia(value), error => error.code === "INVALID_DATA");
  assert.throws(() => parseCloudSave({ ...mediaSave, media: [] }), error => error.code === "INVALID_DATA");
  assert.throws(() => parseCloudSave({ ...mediaSave, media: [media, media] }), error => error.code === "INVALID_DATA");
  const { storage, objects } = memoryStorage();
  try {
    assert.deepEqual(await storage.readLibrary(), { snapshot: null, heads: [] });
    await rejects(() => storage.saveLibrary(mediaSave), "MEDIA_MISSING");
    assert.equal(objects.size, 0);
    const first = await storage.saveLibrary(emptySave);
    assert.equal((await storage.readLibrary()).snapshot.revision, first.snapshot.revision);
    await rejects(() => storage.saveLibrary(emptySave), "CONFLICT");
    const originalCount = objects.size;
    await rejects(() => storage.saveLibrary({ ...mediaSave, baseRevisions: [first.snapshot.revision] }), "MEDIA_MISSING");
    assert.equal(objects.size, originalCount);
    const upload = await storage.createUpload(media);
    assert.equal(upload.expiresIn, 300);
    const url = new URL(upload.url);
    assert.ok(url.searchParams.get("X-Amz-SignedHeaders").includes("content-md5"));
    assert.ok(url.searchParams.get("X-Amz-SignedHeaders").includes("content-length"));
    assert.ok(!upload.url.includes(settings.applicationKey));
    objects.set(`${storage.prefix}/media/${media.sha256}-${media.md5}`, { body, type: media.mime, metadata: { sha256: media.sha256 }, md5: media.md5 });
    assert.equal((await storage.createUpload(media)).alreadyUploaded, true);
    const second = await storage.saveLibrary({ ...mediaSave, baseRevisions: [first.snapshot.revision] });
    assert.deepEqual(second.snapshot.parents, [first.snapshot.revision]);
    assert.equal((await storage.createDownload(second.snapshot.revision, media.id)).media.id, media.id);
    await rejects(() => storage.createDownload(first.snapshot.revision, media.id), "NOT_FOUND");
    // Two writers both read the same parent before either publishes. Their snapshots survive.
    const send = storage.client.send.bind(storage.client);
    let puts = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    storage.client.send = async command => {
      const result = await send(command);
      if (command.constructor.name === "PutObjectCommand") { if (++puts === 2) release(); await barrier; }
      return result;
    };
    const results = await Promise.allSettled([storage.saveLibrary({ ...mediaSave, baseRevisions: [second.snapshot.revision] }), storage.saveLibrary({ ...mediaSave, baseRevisions: [second.snapshot.revision] })]);
    assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "CONFLICT"));
    const { heads } = await storage.listRevisions();
    assert.equal(heads.length, 2);
    await rejects(() => storage.readLibrary(), "CONFLICT");
    for (const id of heads) assert.deepEqual((await storage.readLibrary(id)).snapshot.parents, [second.snapshot.revision]);
    storage.client.send = send;
    const merged = await storage.saveLibrary({ ...mediaSave, baseRevisions: heads });
    assert.deepEqual(merged.snapshot.parents, heads);
    assert.deepEqual((await storage.readLibrary()).heads, [merged.snapshot.revision]);
    for (const id of heads) assert.equal((await storage.readLibrary(id)).snapshot.revision, id);
  } finally { storage.client.destroy(); }
  const damaged = memoryStorage();
  try {
    const a = randomUUID(), b = randomUUID();
    const key = (parents, id) => `${damaged.storage.prefix}/revisions/${parents}_${id}.json`;
    damaged.objects.set(key(b, a), {});
    await rejects(() => damaged.storage.listRevisions(), "INVALID_HISTORY");
    damaged.objects.set(key(a, b), {});
    await rejects(() => damaged.storage.listRevisions(), "INVALID_HISTORY");
  } finally { damaged.storage.client.destroy(); }
  const paged = memoryStorage();
  try {
    const a = randomUUID(), b = randomUUID();
    paged.storage.client.send = async command => command.input.ContinuationToken
      ? { Contents: [{ Key: `${paged.storage.prefix}/revisions/${a}_${b}.json` }] }
      : { Contents: [{ Key: `${paged.storage.prefix}/revisions/root_${a}.json` }], IsTruncated: true, NextContinuationToken: "page-two" };
    assert.deepEqual((await paged.storage.listRevisions()).heads, [b]);
  } finally { paged.storage.client.destroy(); }
  console.log("Storage checks passed: validation, missing media, signed URLs, stale writes and concurrent branches.");
}

async function liveChecks() {
  loadEnvConfig(process.cwd());
  // Only this unique prefix is written/deleted, never the actual library prefix.
  const prefix = `idea-bank-check/${randomUUID()}`;
  const storage = new B2Storage(readB2Settings(), prefix);
  try {
    assert.equal((await storage.readLibrary()).snapshot, null);
    const upload = await storage.createUpload(media);
    const response = await fetch(upload.url, { method: "PUT", headers: upload.headers, body, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, "B2 accepts signed upload with MD5 and metadata");
    const altered = Buffer.from(body); altered[0] ^= 1;
    const badUpload = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: altered, signal: AbortSignal.timeout(30000) });
    assert.equal(badUpload.status, 400, "B2 rejects bytes that do not match the signed MD5");
    await badUpload.arrayBuffer();
    assert.equal((await storage.createUpload(media)).alreadyUploaded, true);
    const first = await storage.saveLibrary(mediaSave);
    const downloaded = await storage.readLibrary();
    assert.deepEqual(downloaded.snapshot.library, library);
    await rejects(() => storage.saveLibrary(mediaSave), "CONFLICT");
    const signed = await storage.createDownload(first.snapshot.revision, media.id);
    const download = await fetch(signed.url, { signal: AbortSignal.timeout(30000) });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
    // A real browser checks CORS; only a temporary intercepted HTML page is served at AUTH_URL.
    if (process.argv.includes("--browser")) {
      const browser = await chromium.launch({ channel: "msedge", headless: true });
      try {
        const page = await browser.newPage();
        const fixtureUrl = new URL("/__b2-cors-check", process.env.AUTH_URL).href;
        await page.route(fixtureUrl, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>B2 CORS check</title>" }));
        await page.goto(fixtureUrl);
        const result = await page.evaluate(async ({ upload, signed, bytes }) => {
          const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: new Blob([new Uint8Array(bytes)]), credentials: "omit" });
          const get = await fetch(signed.url, { credentials: "omit" });
          return { put: put.status, get: get.status, bytes: [...new Uint8Array(await get.arrayBuffer())] };
        }, { upload, signed, bytes: [...body] });
        assert.equal(result.put, 200); assert.equal(result.get, 200); assert.deepEqual(Buffer.from(result.bytes), body);
        console.log("Real browser B2 CORS upload/download check passed for AUTH_URL.");
      } finally { await browser.close(); }
    }
    console.log("Live B2 checks passed: signed upload/download, snapshot round-trip, duplicate detection and stale-write rejection.");
  } finally {
    try {
      const page = await storage.client.send(new ListObjectVersionsCommand({ Bucket: storage.settings.bucket, Prefix: `${prefix}/` }));
      assert.ok(!page.IsTruncated, "Test cleanup fits one page");
      for (const object of [...(page.Versions || []), ...(page.DeleteMarkers || [])]) {
        assert.ok(object.Key?.startsWith(`${prefix}/`) && object.VersionId, "Cleanup stays in this test's unique prefix");
        await storage.client.send(new DeleteObjectCommand({ Bucket: storage.settings.bucket, Key: object.Key, VersionId: object.VersionId }));
      }
      console.log("Live test objects removed, including their versions. Personal library untouched.");
    } finally { storage.client.destroy(); }
  }
}

try { await unitChecks(); if (process.argv.includes("--live")) await liveChecks(); }
catch (error) {
  // Never print raw SDK/fetch errors from real credentials or signed URLs.
  console.error(error instanceof assert.AssertionError ? `Storage assertion failed: ${error.message}` : `Storage check failed (${error instanceof StorageError ? error.code : error?.name || "Error"}). Credential values not displayed.`);
  process.exitCode = 1;
}
