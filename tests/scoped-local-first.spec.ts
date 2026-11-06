import {test,expect} from "@playwright/test";
import {exposeLibraryStore} from "./local-fixture";

test("a local scoped notification is delivered once and other tabs remain observable",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");
  await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const events=await page.evaluate(async()=>{
    const root="/__local_fixture__/",store=await import(root+"scoped-store.js");
    const events:{scope:string;external:boolean}[]=[];
    const stop=store.subscribeScoped((scope:string,external=false)=>events.push({scope,external}));
    store.notifyScoped("owner");
    await new Promise(resolve=>setTimeout(resolve,100));
    const channel=new BroadcastChannel("idea-bank.scoped.changes");
    channel.postMessage({scope:"owner",source:"another-page-session"});
    await new Promise(resolve=>setTimeout(resolve,100));channel.close();stop();
    return events;
  });
  expect(events).toEqual([{scope:"owner",external:false},{scope:"owner",external:true}]);
});

test("acknowledgements retain local counts across create, move and delete without downloading a catalog",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");
  await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",store=await import(root+"scoped-store.js"),schema=await import(root+"entity-sync.js"),cache=await import(root+"reader-cache.js"),overlay=await import(root+"scoped-overlay.js");
    const scope="local-first",sections=[{id:"s",name:"Section",description:"",icon:"folder"},{id:"other",name:"Other",description:"",icon:"folder"}];
    const idea={id:"new",name:"Local idea",description:"",cover:"forest",sectionId:"s",blocks:[],updatedAt:"2026-01-01T00:00:00Z"};
    const target={kind:"idea",id:idea.id},empty={target,heads:[],index:{},records:[]};
    const values=schema.flattenLibrary({version:1,sections,projects:[idea]});
    const makeRead=(values:Record<string,unknown>,revision:string)=>({target,heads:[revision],index:Object.fromEntries(Object.keys(values).map(key=>[key,[revision]])),records:Object.entries(values).map(([key,value])=>({key,revision,value}))});
    const initial={sections,ideas:[],counts:{s:0,other:0},total:0,revision:"0".repeat(64),nextCursor:null,offline:false,uninitialized:false};
    await cache.writeReaderCache(scope,"page","limit=24",initial);
    await cache.writeReaderCache(scope,"page","q=unmatched&limit=24",initial);
    const readPage=async()=>cache.readReaderCache(scope,"page","limit=24");
    const create=await store.queueScoped(scope,target,empty,values,0);
    const pending=await overlay.overlayPage(scope,await readPage(),{});
    const confirmed=makeRead(values,"11111111-1111-4111-8111-111111111111");
    await store.settleScoped(create,confirmed,values);
    const created=await overlay.overlayPage(scope,await readPage(),{});
    const filtered=await cache.readReaderCache(scope,"page","q=unmatched&limit=24");
    const movedValues=schema.flattenLibrary({version:1,sections,projects:[{...idea,sectionId:"other"}]});
    const move=await store.queueScoped(scope,target,confirmed,movedValues,0);
    const movedRead=makeRead(movedValues,"22222222-2222-4222-8222-222222222222");
    await store.settleScoped(move,movedRead,movedValues);
    const moved=await readPage();
    const deletedValues={...movedValues,[schema.entityKey("idea",idea.id)]:null};
    const remove=await store.queueScoped(scope,target,movedRead,deletedValues,0);
    await store.settleScoped(remove,makeRead(deletedValues,"33333333-3333-4333-8333-333333333333"),deletedValues);
    return {pending,created,filtered,moved,deleted:await readPage(),queue:await store.readScopedIndex()};
  });
  expect(result.pending.counts).toEqual({s:1,other:0});
  expect(result.created.counts).toEqual({s:1,other:0});expect(result.created.total).toBe(1);
  expect(result.filtered.counts).toEqual({s:1,other:0});expect(result.filtered.total).toBe(0);
  expect(result.moved.counts).toEqual({s:0,other:1});expect(result.moved.total).toBe(1);
  expect(result.deleted.counts).toEqual({s:0,other:0});expect(result.deleted.total).toBe(0);
  expect(result.queue).toEqual([]);
});

test("a cached paginated prefix is rebuilt locally when a new idea shifts its boundaries",async({page})=>{
  await exposeLibraryStore(page);await page.route("**/__storage_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html>"}));await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",cache=await import(root+"reader-cache.js"),db=await import(root+"local-database.js"),codec=await import(root+"reader-batch-types.js");
    const scope="prefix",revision="a".repeat(64),nextRevision="b".repeat(64),section={id:"s",name:"Section",description:"",icon:"folder"};
    const ideas=Array.from({length:8},(_,n)=>({id:`old-${n}`,name:`Old ${n}`,description:"",sectionId:"s",cover:"forest",updatedAt:"2026-01-01T00:00:00Z"}));
    const cursor=codec.readerCursor({},revision,4),secondKey=codec.readerPageKey({cursor,limit:4});
    const base={sections:[section],ideas:ideas.slice(0,4),counts:{s:8},total:8,revision,nextCursor:cursor,offline:false,uninitialized:false};
    await cache.writeReaderCache(scope,"page","limit=4",base);
    await cache.writeReaderCache(scope,"page",secondKey,{...base,ideas:ideas.slice(4),nextCursor:null});
    const idea={...ideas[0],id:"new",name:"New",updatedAt:"2026-11-01T00:00:00Z"};
    const row={key:"new",scope,target:{kind:"idea",id:idea.id},sequence:1,before:null,idea,deletedIds:[]};
    await db.transaction(["meta"],"readwrite",(tx:IDBTransaction)=>cache.settleReaderPagesIn(tx,scope,row,nextRevision));
    const first=await cache.readReaderCache(scope,"page","limit=4"),second=await cache.readReaderCacheState(scope,"page",codec.readerPageKey({cursor:first.nextCursor,limit:4}));
    return {first,second};
  });
  expect(result.first.ideas.map((idea:{id:string})=>idea.id)).toEqual(["new","old-0","old-1","old-2"]);
  expect(result.second.value.ideas.map((idea:{id:string})=>idea.id)).toEqual(["old-3","old-4","old-5","old-6"]);
  expect(result.first.counts.s).toBe(9);expect(result.second.fresh).toBe(true);
});

test("an unchanged control packet does not rewrite local data",async({page})=>{
  await exposeLibraryStore(page);await page.route("**/__storage_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html>"}));await page.goto("/__storage_probe__");
  const revision="4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
  await page.route("**/api/reader/batch",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({heads:[],revision,reset:false,pages:[],changes:{index:{},records:[],previous:[]},bodies:[],media:[]})}));
  const writes=await page.evaluate(async revision=>{
    const root="/__local_fixture__/",cache=await import(root+"reader-cache.js"),db=await import(root+"local-database.js"),reader=await import(root+"library-reader.js"),scope="unchanged";
    await cache.writeReaderCache(scope,"page","limit=24",{sections:[],ideas:[],total:0,counts:{},revision,nextCursor:null,offline:false,uninitialized:false});
    await db.transaction(["meta"],"readwrite",(tx:IDBTransaction)=>{tx.objectStore("meta").put([],cache.readerCheckpointKey(scope));});
    const original=IDBObjectStore.prototype.put;let writes=0;
    IDBObjectStore.prototype.put=function(...args){writes++;return original.apply(this,args);};
    try{await reader.syncReader(scope);}finally{IDBObjectStore.prototype.put=original;}
    return writes;
  },revision);
  expect(writes).toBe(0);
});
