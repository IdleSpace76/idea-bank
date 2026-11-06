import {test,expect} from "@playwright/test";
import {exposeLibraryStore,readStoredLibrary} from "./local-fixture";

test("acknowledging an old upload preserves a newer queue generation and its merge baseline",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",store=await import(root+"scoped-store.js"),schema=await import(root+"entity-sync.js"),libraryStore=await import(root+"library-store.js");
    const original=await libraryStore.readLocalLibrary(),target={kind:"idea",id:"example"},scope="test-scope",revision="11111111-1111-4111-8111-111111111111";
    const values=schema.flattenLibrary(original);
    const makeRead=(values:Record<string,unknown>,revision:string)=>({target,heads:[revision],index:Object.fromEntries(Object.keys(values).map(key=>[key,[revision]])),records:Object.entries(values).map(([key,value])=>({key,revision,value}))});
    const base=makeRead(values,revision),firstValues=structuredClone(values);firstValues[schema.entityKey("idea","example")].description="First upload";
    const first=await store.queueScoped(scope,target,base,firstValues,0);
    const operation={sequence:first.sequence,before:firstValues,values:firstValues,read:base,body:{operationId:crypto.randomUUID(),heads:base.heads,changes:[]}};
    await store.persistScopedOperation(first,operation);
    const nextValues=structuredClone(firstValues);nextValues[schema.entityKey("idea","example")].description="New generation";
    const second=await store.queueScoped(scope,target,base,nextValues,first.sequence);
    const confirmed=makeRead(firstValues,"22222222-2222-4222-8222-222222222222");
    await store.settleScoped(second,confirmed,firstValues,undefined,confirmed);
    const kept=await store.readScopedEntry(scope,target);
    let stale=false;try{await store.queueScoped(scope,target,base,firstValues,first.sequence);}catch{stale=true;}
    return {kept,sequence:second.sequence,stale,base:confirmed,old:original,after:await libraryStore.readLocalLibrary()};
  });
  expect(result.kept.sequence).toBe(result.sequence);expect(result.kept.local['idea:["example"]'].description).toBe("New generation");
  expect(result.kept.operation).toBeUndefined();expect(result.kept.base).toEqual(result.base);expect(result.stale).toBe(true);expect(result.after).toEqual(result.old);
});

test("queue write failures roll back and notifications invalidate only cache metadata",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card > strong")).toHaveText("Example");await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const original=await page.evaluate(readStoredLibrary);
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",store=await import(root+"scoped-store.js"),schema=await import(root+"entity-sync.js"),library=await import(root+"library-store.js"),cache=await import(root+"reader-cache.js");
    const local=await library.readLocalLibrary(),values=schema.flattenLibrary(local),target={kind:"idea",id:"example"},revision="11111111-1111-4111-8111-111111111111";
    const base={target,heads:[revision],index:Object.fromEntries(Object.keys(values).map(key=>[key,[revision]])),records:Object.entries(values).map(([key,value])=>({key,revision,value}))};
    const before=await store.readScopedIndex(),put=IDBObjectStore.prototype.put;let failed=false;
    IDBObjectStore.prototype.put=function(value,key){if(key==="scoped-queue-v1")throw new DOMException("Fixture disk full","QuotaExceededError");return put.call(this,value,key);};
    try{await store.queueScoped("scope",target,base,values,0);}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
    await cache.writeReaderCache("scope","idea","example",{idea:local.projects[0],version:"a".repeat(64)});
    const reads:string[]=[],get=IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get=function(key){reads.push(String(key));return get.call(this,key);};
    try{await cache.markReaderStale("scope");}finally{IDBObjectStore.prototype.get=get;}
    return {before,after:await store.readScopedIndex(),failed,reads,pending:await store.readScopedEntry("scope",target)};
  });
  expect(result.failed).toBe(true);expect(result.after).toEqual(result.before);expect(result.pending).toBeUndefined();expect(result.reads).toEqual(["reader-cache-v1","reader-epoch:scope"]);
  expect(await page.evaluate(readStoredLibrary)).toEqual(original);
});
