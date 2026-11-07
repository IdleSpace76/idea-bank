import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { EntityStorage, memoryStorage, schema, storageCache } from "./entity-fixture.mjs";
const { entityKey, flattenLibrary } = schema;
const fixture = memoryStorage();
const library = { version: 1, sections: [{ id: "s", name: "Section", description: "", icon: "folder" }], projects: Array.from({ length: 1000 }, (_, n) => ({
  id: `idea-${String(n).padStart(4,"0")}`, sectionId: "s", name: `Idea ${n}`, description: n === 900 ? "Find this distant idea" : "Description",
  cover: "forest", updatedAt: "2026-01-01T00:00:00Z", blocks: [{ id: "body", heading: "Heading", text: `Body ${n}`.repeat(200) }],
})) };
const send = fixture.storage.client.send.bind(fixture.storage.client), calls = [];
fixture.storage.client.send = async command => { calls.push({ name: command.constructor.name, key: command.input.Key || command.input.Prefix }); return send(command); };
const reset = () => { calls.length = 0; };
const ordinaryReads = () => {
  assert.ok(!calls.some(call => call.name === "ListObjectsV2Command" && !call.key.endsWith("/tips/")), "Warm reads must not list snapshot history");
  assert.ok(!calls.some(call => call.name === "PutObjectCommand"), "Warm reads must not rewrite the index");
};
const recordPath = key => `/records/${createHash("sha256").update(key).digest("hex")}/`;
try {
  await fixture.entities().save({ operationId: randomUUID(), heads: [], changes: Object.entries(flattenLibrary(library)).map(([key,value]) => ({ key, value, base: [] })) });
  reset();
  const first = await fixture.entities().catalog().readPage();
  assert.equal(first.total,1000); assert.equal(first.ideas.length,24);
  assert.ok(!JSON.stringify(first).includes("Body 0"), "Catalog contains no block bodies");
  const blockPaths = library.projects.map(idea => recordPath(entityKey("block",idea.id,"body")));
  assert.ok(!calls.some(call => blockPaths.some(path => call.key.includes(path))), "Building the catalog does not fetch any block body");
  reset();
  const second = await fixture.entities().catalog().readPage({ cursor: first.nextCursor });
  ordinaryReads();
  assert.equal(second.ideas[0].id,"idea-0024");
  assert.ok(calls.filter(call => call.name === "GetObjectCommand").length <= 3, "A page needs only root pointer, root, and one card page");
  storageCache.clearStorageReadCache();reset();
  const smallSection=await fixture.entities().catalog().readPage({sectionId:"s",limit:4});
  assert.equal(smallSection.total,1000);assert.equal(smallSection.ideas.length,4);assert.ok(smallSection.nextCursor);
  assert.equal(calls.filter(call=>call.name==="GetObjectCommand").length,3,"A four-card section reads one card page, not all 42 pages");
  storageCache.clearStorageReadCache();reset();
  assert.equal((await fixture.entities().catalog().readPage({sectionId:"absent",limit:4})).total,0);
  assert.equal(calls.filter(call=>call.name==="GetObjectCommand").length,2,"An empty section does not load any card pages");
  let page = first; const ids = [];
  do { ids.push(...page.ideas.map(idea => idea.id)); if (!page.nextCursor) break; page = await fixture.entities().catalog().readPage({ cursor: page.nextCursor }); } while (true);
  assert.equal(ids.length,1000); assert.equal(new Set(ids).size,1000);
  reset();
  const detail = await fixture.entities().catalog().readIdea("idea-0900");
  ordinaryReads(); assert.deepEqual(detail.idea,library.projects[900]);
  assert.deepEqual(calls.filter(call => call.key.includes("/records/") && blockPaths.some(path => call.key.includes(path))).map(call => call.key.includes(recordPath(entityKey("block","idea-0900","body")))),[true]);
  reset();
  const current = await fixture.entities().catalog().readIdea("idea-0900",detail.version);
  ordinaryReads(); assert.equal(current.notModified,true);
  assert.ok(!calls.some(call => call.key.includes("/records/")), "Current versions are checked without any entity body reads");
  const version = await fixture.entities().catalog().readIdea("idea-0900",undefined,true);
  assert.deepEqual(version,{ id:"idea-0900",version:detail.version });
  // Exercise actual route code; storage/auth guards are tested against Next in auth-check.mjs.
  const handler = async path => {
    const exports = {};
    const code = ts.transpileModule(await readFile(new URL(path,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    runInNewContext(code,{exports,Response,URL,require:name=>{
      if(name==="@/lib/entity-storage") return {EntityStorage};
      if(name==="@/lib/storage-api") return {storageEndpoint:async(request,mutation,work)=>{
        assert.equal(mutation,false);
        try { return Response.json(await work(fixture.storage),{headers:{"Cache-Control":"private, no-store",Vary:"Cookie"}}); }
        catch(error) { return Response.json({error:{code:error.code}},{status:error.status||502}); }
      }};
      throw new Error(`Unexpected route import: ${name}`);
    }});
    return exports.GET;
  };
  const ideaRoute = await handler("../app/api/ideas/[id]/route.ts"), catalogRoute = await handler("../app/api/catalog/route.ts");
  const routeRequest = headers => ideaRoute(new Request("https://fixture.example/api/ideas/idea-0900",{headers}),{params:Promise.resolve({id:"idea-0900"})});
  assert.equal((await routeRequest()).status,200);
  reset(); const cachedResponse = await routeRequest({"If-None-Match":`"${detail.version}"`});
  assert.equal(cachedResponse.status,304); assert.equal(await cachedResponse.text(),"");
  assert.equal(cachedResponse.headers.get("etag"),`"${detail.version}"`);
  assert.ok(cachedResponse.headers.get("cache-control").includes("no-store"));
  assert.equal(cachedResponse.headers.get("vary"),"Cookie");
  assert.ok(!calls.some(call=>call.key.includes("/records/")),"HTTP 304 also avoids body reads");
  const catalogResponse = await catalogRoute(new Request("https://fixture.example/api/catalog?limit=3&q=distant"));
  assert.equal(catalogResponse.status,200); assert.equal((await catalogResponse.json()).ideas[0].id,"idea-0900");
  assert.equal((await catalogRoute(new Request("https://fixture.example/api/catalog?limit=bad"))).status,400);
  const search = await fixture.entities().catalog().readPage({ query:"distant" });
  assert.equal(search.total,1); assert.equal(search.ideas[0].id,"idea-0900");
  assert.equal((await fixture.entities().catalog().readPage({ sectionId:"missing" })).total,0);
  await assert.rejects(()=>fixture.entities().catalog().readIdea("missing"),e=>e.code==="NOT_FOUND");
  for (const limit of [0,-1,101,1.5]) await assert.rejects(()=>fixture.entities().catalog().readPage({limit}),e=>e.code==="INVALID_DATA");
  await assert.rejects(()=>fixture.entities().catalog().readPage({cursor:"broken"}),e=>e.code==="INVALID_DATA");
  await assert.rejects(()=>fixture.entities().catalog().readPage({cursor:first.nextCursor,query:"different"}),e=>e.code==="INVALID_DATA");
  const state = await fixture.entities().catalogIndex(), key = entityKey("block","idea-0900","body");
  await fixture.entities().save({operationId:randomUUID(),heads:state.heads,changes:[{key,base:state.index[key],value:{...library.projects[900].blocks[0],text:"New body, same updatedAt"}}]});
  const changed = await fixture.entities().catalog().readIdea("idea-0900",detail.version);
  assert.equal(changed.notModified,false); assert.notEqual(changed.version,detail.version);
  assert.equal(changed.idea.blocks[0].text,"New body, same updatedAt");
  assert.equal(changed.idea.updatedAt,detail.idea.updatedAt,"Timestamps do not decide content freshness");
  await assert.rejects(()=>fixture.entities().catalog().readPage({cursor:first.nextCursor}),e=>e.code==="STALE_CATALOG");
  console.log("Catalog checks passed: 1000 ideas, bounded pages, metadata search, isolated idea reads, body-free version checks and stale pagination.");
} finally { fixture.storage.client.destroy(); }

// Two independent branches and real conflicts must remain visible, including after a delayed retry.
const concurrent = memoryStorage();
try {
  const sample = {...library,projects:[{...library.projects[0],blocks:[...library.projects[0].blocks,{id:"other",heading:"Other",text:"Original"}]}]};
  const root = {operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(sample)).map(([key,value])=>({key,value,base:[]}))};
  await concurrent.entities().save(root);
  let state = await concurrent.entities().read(); const key = entityKey("block",sample.projects[0].id,"body"), otherKey = entityKey("block",sample.projects[0].id,"other");
  const make = text => ({operationId:randomUUID(),heads:state.heads,changes:[{key,base:state.index[key],value:{...sample.projects[0].blocks[0],text}}]});
  await Promise.all([concurrent.entities().save(make("Independent first")),concurrent.entities().save({operationId:randomUUID(),heads:state.heads,changes:[{key:otherKey,base:state.index[otherKey],value:{id:"other",heading:"Other",text:"Independent second"}}]})]);
  assert.deepEqual((await concurrent.entities().catalog().readIdea(sample.projects[0].id)).idea.blocks.map(block=>block.text),["Independent first","Independent second"]);
  state = await concurrent.entities().read();
  await Promise.all([concurrent.entities().save(make("Left")),concurrent.entities().save(make("Right"))]);
  let page = await concurrent.entities().catalog().readPage();
  assert.equal(page.ideas[0].conflicted,true);
  await assert.rejects(()=>concurrent.entities().catalog().readIdea(sample.projects[0].id),e=>e.code==="IDEA_CONFLICT");
  const before = page.revision;
  await concurrent.entities().save(root);
  page = await concurrent.entities().catalog().readPage();
  assert.equal(page.revision,before,"A retired parent retry cannot resurrect an old catalog");
  const latest = await concurrent.entities().read();
  await concurrent.entities().save({operationId:randomUUID(),heads:latest.heads,changes:[{key,base:latest.index[key],value:{...sample.projects[0].blocks[0],text:"Resolved"}}]});
  assert.equal((await concurrent.entities().catalog().readIdea(sample.projects[0].id)).idea.blocks[0].text,"Resolved");
  const ready = await concurrent.entities().read();
  await concurrent.entities().save({operationId:randomUUID(),heads:ready.heads,changes:[key,otherKey,entityKey("idea",sample.projects[0].id)].map(key=>({key,base:ready.index[key],value:null}))});
  assert.equal((await concurrent.entities().catalog().readPage()).total,0);
  await assert.rejects(()=>concurrent.entities().catalog().readIdea(sample.projects[0].id),e=>e.code==="NOT_FOUND");
  console.log("Catalog concurrency checks passed: branches, explicit conflicts, late retries, resolution and deletion.");
} finally { concurrent.storage.client.destroy(); }

const existing = memoryStorage();
try {
  const sample = {...library,projects:[library.projects[0]]};
  await existing.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(sample)).map(([key,value])=>({key,value,base:[]}))});
  // Simulate a v2 library written by a release that did not yet have a catalog.
  for (const key of existing.objects.keys()) if (key.includes("/catalog-v1/")) existing.objects.delete(key);
  const objectsBefore = [...existing.objects.entries()];
  assert.equal((await existing.entities().catalog().readPage()).total,1);
  for (const [key,value] of objectsBefore) assert.deepEqual(existing.objects.get(key),value,"Existing records are not rewritten during catalog initialization");
  const source = await existing.entities().catalogIndex();
  await existing.entities().catalog().readPage();
  const pointerKey = [...existing.objects.keys()].find(key=>key.includes("/views/"));
  const pointer = JSON.parse(existing.objects.get(pointerKey).body);
  const root = JSON.parse(existing.objects.get(pointer.root).body);
  const pageKey = root.pages[0].key;
  const original = existing.objects.get(pageKey);
  existing.objects.set(pageKey,{...original,body:"[]"});
  // A new instance/expired cache must still reject corrupt immutable objects.
  storageCache.clearStorageReadCache();
  await assert.rejects(()=>existing.entities().catalog().readPage(),e=>e.code==="INVALID_CATALOG");
  existing.objects.set(pageKey,original);
  // An interrupted secondary-index publication is repaired by the authoritative sync reader.
  existing.objects.delete(`${existing.storage.prefix}/sync-v2/catalog-v1/tips/${source.heads[0]}.json`);
  await existing.entities().read();
  assert.ok(existing.objects.has(`${existing.storage.prefix}/sync-v2/catalog-v1/tips/${source.heads[0]}.json`));
  console.log("Catalog compatibility checks passed: existing v2 data, immutable records, corruption detection and publication repair.");
} finally { existing.storage.client.destroy(); }

const interrupted = memoryStorage();
try {
  assert.equal((await interrupted.entities().catalog().readPage()).total,0);
  const sample = {...library,projects:[library.projects[0]]};
  await interrupted.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(sample)).map(([key,value])=>({key,value,base:[]}))});
  const state = await interrupted.entities().read(), key = entityKey("block",sample.projects[0].id,"body");
  const operation = {operationId:randomUUID(),heads:state.heads,changes:[{key,base:state.index[key],value:{...sample.projects[0].blocks[0],text:"Saved before publication failed"}}]};
  const send = interrupted.storage.client.send.bind(interrupted.storage.client);
  let fail = true;
  interrupted.storage.client.send = async command => {
    if(fail && command.constructor.name==="PutObjectCommand" && command.input.Key.includes("/catalog-v1/tips/")) { fail=false; throw new Error("Simulated interrupted publication"); }
    if(command.constructor.name==="DeleteObjectCommand") throw new Error("Simulated cleanup unavailable");
    return send(command);
  };
  await assert.rejects(()=>interrupted.entities().save(operation));
  await interrupted.entities().save(operation);
  assert.equal((await interrupted.entities().catalog().readIdea(sample.projects[0].id)).idea.blocks[0].text,"Saved before publication failed");
  let staleListing = true;
  const withFailedCleanup = interrupted.storage.client.send.bind(interrupted.storage.client);
  interrupted.storage.client.send = async command => {
    if(staleListing && command.constructor.name==="ListObjectsV2Command" && command.input.Prefix.endsWith("/tips/")) {
      staleListing = false;
      return {Contents:[{Key:`${interrupted.storage.prefix}/sync-v2/catalog-v1/tips/${state.heads[0]}.json`}]};
    }
    return withFailedCleanup(command);
  };
  assert.equal((await interrupted.entities().catalog().readPage()).total,1,"A retirement observed during pagination must not revive a cached empty library");
  console.log("Catalog recovery check passed: committed-save retries repair publication even when parent cleanup fails.");
} finally { interrupted.storage.client.destroy(); }
await import("./storage-read-cache-check.mjs");
await import("./storage-request-budget-check.mjs");
