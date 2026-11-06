import { test,expect } from "@playwright/test";
import { exposeLibraryStore,readStoredLibrary } from "./local-fixture";

test("retiring a confirmed cloud replica preserves pending data and never reimports the legacy backup",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",store=await import(root+"library-store.js"),db=await import(root+"local-database.js"),cache=await import(root+"reader-cache.js");
    const original=await store.readLocalLibrary(),scope="retirement-test";
    localStorage.setItem("idea-bank.library.v1",JSON.stringify(original));
    await cache.writeReaderCache(scope,"idea","example",{idea:original.projects[0]});
    await db.transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put({version:2,scope},"sync-v2");});
    const unsent=await store.retireCloudReplica(scope); // Starter originals have not been acknowledged.
    await db.transaction(["outbox","meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("outbox").clear();tx.objectStore("meta").put({body:{operationId:"inflight"}},"sync-operation");});
    const inflight=await store.retireCloudReplica(scope);
    await db.transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").delete("sync-operation");tx.objectStore("meta").put([{scope}],"scoped-queue-v1");});
    const queued=await store.retireCloudReplica(scope);
    await db.transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put([],"scoped-queue-v1");});
    const wrongScope=await store.retireCloudReplica("another-account"),retired=await store.retireCloudReplica(scope);
    const snapshot=await store.readLocalSnapshot(),checkpoint=await store.readMeta("sync-v2"),marker=await store.readMeta("cloud-reader"),cached=await cache.readReaderCache(scope,"idea","example");
    const media=await db.transaction(["media"],"readonly",async(tx:IDBTransaction)=>db.request(tx.objectStore("media").count()));
    const raw=localStorage.getItem("idea-bank.library.v1");
    const empty={version:1,sections:[],projects:[]};await store.initializeLocalLibrary(async()=>({library:empty,files:new Map()}),{ignoreLegacy:true});
    return {unsent,inflight,queued,wrongScope,retired,snapshot,checkpoint,marker,cached,media,raw,after:await store.readLocalLibrary()};
  });
  expect([result.unsent,result.inflight,result.queued,result.wrongScope]).toEqual([false,false,false,false]);expect(result.retired).toBe(true);
  expect(result.snapshot).toBeNull();expect(result.checkpoint).toBeUndefined();expect(result.marker.scope).toBe("retirement-test");expect(result.cached.idea.name).toBe("Example");
  expect(result.media).toBeGreaterThan(0);expect(result.raw).toContain("Example");expect(result.after.projects).toEqual([]);
});

test("downloaded document cache evicts by count and bytes without touching originals or pending writes",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");
  const original=await page.evaluate(readStoredLibrary);await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/";
    const cache=await import(root+"reader-cache.js"),store=await import(root+"library-store.js");
    const queue=await store.readOutbox();
    for(let n=0;n<25;n++)await cache.writeReaderCache("scope","idea",String(n),{text:"Downloaded "+n});
    const evicted=await cache.readReaderCache("scope","idea","0"),kept=await cache.readReaderCache("scope","idea","24");
    await cache.writeReaderCache("other","idea","24",{text:"Other account"});
    const scoped=await cache.readReaderCache("scope","idea","24");
    await cache.writeReaderCache("scope","page","page",{text:"x".repeat(200)},250);
    await cache.writeReaderCache("scope","page","next",{text:"y".repeat(200)},250);
    return {evicted,kept,scoped,firstPage:await cache.readReaderCache("scope","page","page"),nextPage:await cache.readReaderCache("scope","page","next"),queue,after:await store.readOutbox()};
  });
  expect(result.evicted).toBeUndefined();expect(result.kept).toEqual({text:"Downloaded 24"});expect(result.scoped).toEqual(result.kept);
  expect(result.firstPage).toBeUndefined();expect(result.nextPage.text).toHaveLength(200);expect(result.after).toEqual(result.queue);
  expect(await page.evaluate(readStoredLibrary)).toEqual(original);
});

test("editing a partial catalog preserves every unloaded idea and its blocks",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/";
    const {applyVisibleEdit}=await import(root+"library-edit.js"),store=await import(root+"library-store.js");
    const base=await store.readLocalLibrary();
    base.projects.push({...structuredClone(base.projects[0]),id:"unloaded",name:"Do not delete"});
    const before={...base,projects:[{...base.projects[0],blocks:[]}]};
    const next=structuredClone(before);next.projects[0].name="New name";
    const edited=applyVisibleEdit(base,before,next);
    const removed=applyVisibleEdit(base,before,{...before,projects:[]});
    const sectionRemoved=applyVisibleEdit(base,before,{version:1,sections:[],projects:[]});
    return {base,edited,removed,sectionRemoved};
  });
  expect(result.edited.projects[0].name).toBe("New name");expect(result.edited.projects[0].blocks).toEqual(result.base.projects[0].blocks);
  expect(result.edited.projects[1]).toEqual(result.base.projects[1]);expect(result.removed.projects.map((idea:{id:string})=>idea.id)).toEqual(["unloaded"]);
  expect(result.sectionRemoved.projects).toEqual([]);
});

test("offline reading preserves previously synced originals; a cloud deletion invalidates a cached document",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const offline=await page.evaluate(async()=>{
    const root="/__local_fixture__/",db=await import(root+"local-database.js"),reader=await import(root+"library-reader.js");
    await db.transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put({scope:"legacy"},"sync-v2");});
    Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>false});
    const idea=await reader.loadReaderIdea("legacy","example"),page=await reader.loadReaderPage("legacy");
    Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>true});
    return {idea,page};
  });
  expect(offline.idea.offline).toBe(true);expect(offline.idea.idea.blocks.length).toBeGreaterThan(0);expect(offline.page.offline).toBe(true);
  await page.route("**/api/reader/batch",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({heads:[],revision:"0".repeat(64),reset:true,pages:[],changes:{index:{},records:[],previous:[]},bodies:[{id:"example",error:{code:"NOT_FOUND",message:"Deleted"}}],media:[]})}));
  const deleted=await page.evaluate(async()=>{
    const root="/__local_fixture__/",reader=await import(root+"library-reader.js"),cache=await import(root+"reader-cache.js"),store=await import(root+"library-store.js");
    await cache.writeReaderCache("cloud","idea","example",{idea:(await store.readLocalLibrary()).projects[0],version:"a".repeat(64),offline:false});
    await cache.markReaderStale("cloud");
    let code="";try{await reader.loadReaderIdea("cloud","example");}catch(error){code=(error as {code:string}).code;}
    return {code,cached:await cache.readReaderCache("cloud","idea","example")};
  });
  expect(deleted.code).toBe("NOT_FOUND");expect(deleted.cached).toBeUndefined();
});

test("known deletions stay hidden offline and stale reads cannot undo them",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",reader=await import(root+"library-reader.js"),cache=await import(root+"reader-cache.js"),store=await import(root+"scoped-store.js"),local=await import(root+"library-store.js"),ideas=await import(root+"ideas.js");
    const library=await local.readLocalLibrary(),idea=library.projects[0],scope="deletion-fixture";
    await cache.writeReaderCache(scope,"page","limit=24",{sections:library.sections,ideas:[ideas.summarizeIdea(idea)],total:1,counts:{[idea.sectionId]:1},revision:"a".repeat(64),nextCursor:null,offline:false,uninitialized:false});
    await cache.writeReaderCache(scope,"idea",idea.id,{idea,version:"a".repeat(64),offline:false});
    const started=await store.scopedReadCounter();await store.noteScopedDeletion(scope,idea.id);await store.observeScopedAlive(scope,[idea.id],[idea.sectionId],started);
    Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>false});
    const page=await reader.loadReaderPage(scope);let code="";try{await reader.loadReaderIdea(scope,idea.id);}catch(error){code=(error as {code:string}).code;}
    Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>true});
    return {page,code,marks:await store.readScopedDeletions()};
  });
  expect(result.page.ideas).toEqual([]);expect(result.code).toBe("NOT_FOUND");expect(result.marks.some((row:{scope:string})=>row.scope==="deletion-fixture")).toBe(true);
});
