import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise lifecycle/auth failures without a real account, waiting minutes or exposing SDK errors.
const original = new Map(["window", "document", "navigator", "fetch", "setTimeout", "clearTimeout", "loadFixture"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const realTimeout = globalThis.setTimeout;
const timers = new Map(), instances = [];
let nextTimer = 0, requests = 0, credentialMode = "enabled", lastRequest;
const channelName = "idea-bank:sync:" + "a".repeat(64);
class Emitter {
  state = "initialized";
  listeners = [];
  on(listener) { this.listeners.push(listener); }
  emit(state) { this.state = state; for (const listener of this.listeners) listener({ current: state }); }
}
class FakeRealtime {
  connection = new Emitter();
  channel = Object.assign(new Emitter(), { subscribe: async (_name, listener) => { this.receive = listener; } });
  channels = { get: name => { assert.equal(name, channelName); return this.channel; } };
  constructor(options) { this.options = options; instances.push(this); }
  connect() { this.options.authCallback({}, (error, token) => { assert.equal(error, null); assert.equal(token, "fixture-token"); this.connection.emit("connected"); this.channel.emit("attached"); }); }
  close() { this.closed = true; this.connection.emit("closed"); }
  refresh() { return new Promise(resolve => this.options.authCallback({}, (error, token) => resolve({ error, token }))); }
}
const flush = () => new Promise(resolve => realTimeout(resolve, 0));
let client;
try {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible" }), nav = { onLine: true };
  const fixtures = {
    window: win, document: doc, navigator: nav,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), loadFixture: async () => ({ Realtime: FakeRealtime }),
    fetch: async (_url, init) => {
      requests++; lastRequest = init;
      if (credentialMode === "pending") return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      if (credentialMode === "unauthorized") return new Response(null, { status: 401 });
      return Response.json(credentialMode === "disabled" ? { enabled: false } : { enabled: true, channel: credentialMode === "other-channel" ? "idea-bank:sync:" + "b".repeat(64) : channelName, token: "fixture-token", expiresAt: Date.now() + 900000 });
    },
  };
  for (const [key, value] of Object.entries(fixtures)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const source = await readFile(new URL("../lib/sync-events-client.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import("ably")', "globalThis.loadFixture()");
  const { SyncEventsClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const ready = [], revisions = [];
  client = new SyncEventsClient({ onConnection: value => ready.push(value), onRevision: value => revisions.push(value) });
  client.start(); client.start(); await flush();
  assert.equal(instances.length, 1); assert.deepEqual(ready, [true]);
  assert.equal(lastRequest.method, "POST"); assert.equal(lastRequest.credentials, "same-origin");
  const connection = instances[0], revision = randomUUID();
  connection.receive({ data: { version: 1, revision } });
  for (const data of [null, {}, { version: 2, revision }, { version: 1, revision: "invalid" }]) connection.receive({ data });
  assert.deepEqual(revisions, [revision]);
    const incremental=randomUUID();connection.receive({data:{version:2,revision:incremental,keys:['idea:["example"]']}});
    assert.equal(revisions.at(-1),incremental,"Version-two change hints are accepted alongside legacy events");
  connection.channel.emit("suspended"); assert.equal(ready.at(-1), false);
  connection.channel.emit("attached"); assert.equal(ready.at(-1), true);
  assert.deepEqual(await connection.refresh(), { error: null, token: "fixture-token" });
  credentialMode = "other-channel";
  assert.equal((await connection.refresh()).token, null, "Cannot renew a subscription into a different library");
  credentialMode = "enabled";
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
  assert.ok(connection.closed); assert.equal(ready.at(-1), false); assert.equal(timers.size, 0);
  const received = revisions.length; connection.receive({ data: { version: 1, revision: randomUUID() } });
  assert.equal(revisions.length, received, "Late messages from a closed connection are ignored");
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); await flush();
  assert.equal(instances.length, 2); assert.equal(ready.at(-1), true);
  nav.onLine = false; win.dispatchEvent(new Event("offline"));
  assert.ok(instances.at(-1).closed); assert.equal(ready.at(-1), false); assert.equal(timers.size, 0);
  nav.onLine = true; win.dispatchEvent(new Event("online")); await flush();
  assert.equal(instances.length, 3); assert.equal(ready.at(-1), true);
  instances.at(-1).connection.emit("failed");
  assert.equal(ready.at(-1), false); assert.ok([...timers.values()].some(timer => timer.delay === 60000));
  client.stop(); assert.equal(timers.size, 0);

  credentialMode = "disabled";
  const before = instances.length;
  client = new SyncEventsClient({ onConnection: () => {}, onRevision: () => {} });
  client.start(); await flush();
  assert.equal(instances.length, before); assert.ok([...timers.values()].some(timer => timer.delay === 300000));
  const disabledRequests = requests;
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); await flush();
  assert.equal(requests, disabledRequests, "An unconfigured provider is not requested repeatedly on focus");
  client.stop();

  credentialMode = "unauthorized";
  client = new SyncEventsClient({ onConnection: () => {}, onRevision: () => {} }); client.start(); await flush();
  assert.equal(instances.length, before); assert.ok([...timers.values()].some(timer => timer.delay === 60000)); client.stop();
  credentialMode = "pending";
  client = new SyncEventsClient({ onConnection: () => {}, onRevision: () => {} }); client.start(); await flush(); client.stop(); await flush();
  assert.ok(lastRequest.signal.aborted); assert.equal(timers.size, 0);
  const stoppedRequests = requests; win.dispatchEvent(new Event("online")); doc.dispatchEvent(new Event("visibilitychange")); await flush();
  assert.equal(requests, stoppedRequests, "Stopped clients remove all event listeners");
  console.log("Sync event client checks passed: subscription readiness, token renewal, scoped auth, hidden/offline lifecycle, provider failure and cleanup.");
} finally {
  client?.stop();
  for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
}
