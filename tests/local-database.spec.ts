import { test,expect } from "@playwright/test";
import { exposeLibraryStore } from "./local-fixture";

test("database connections are shared, reopen after deletion and keep transaction aborts atomic",async({page})=>{
  await exposeLibraryStore(page);
  await page.route("**/__database_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Database fixture</title>"}));
  await page.goto("/__database_probe__");
  const result=await page.evaluate(async()=>{
    const native=indexedDB.open.bind(indexedDB);let opens=0;
    indexedDB.open=(name,version)=>{if(name==="idea-bank.local")opens++;return native(name,version);};
    const {transaction,request,openLocalDatabase}=await import("/__local_fixture__/"+"local-database.js");
    await Promise.all(Array.from({length:30},(_,n)=>transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put(n,String(n));})));
    const first=opens;
    await Promise.all(Array.from({length:30},(_,n)=>transaction(["meta"],"readonly",async(tx:IDBTransaction)=>request(tx.objectStore("meta").get(String(n))))));
    const reused=opens;
    await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase("idea-bank.local");r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error("Connection did not close on version change"));});
    const absent=await transaction(["meta"],"readonly",async(tx:IDBTransaction)=>request(tx.objectStore("meta").get("0")));
    const afterDelete=opens;
    (await openLocalDatabase()).close();
    await transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{tx.objectStore("meta").put("committed","value");});
    const afterClose=opens;
    let attempts=0;
    try{await transaction(["meta"],"readwrite",async(tx:IDBTransaction)=>{attempts++;tx.objectStore("meta").put("not committed","value");throw new Error("Fixture abort");});}catch{}
    const value=await transaction(["meta"],"readonly",async(tx:IDBTransaction)=>request(tx.objectStore("meta").get("value")));
    return {first,reused,absent,afterDelete,afterClose,attempts,value};
  });
  expect(result).toEqual({first:1,reused:1,absent:undefined,afterDelete:2,afterClose:3,attempts:1,value:"committed"});
});

test("read observations do not repeatedly write unchanged cache and deletion metadata",async({page})=>{
  await exposeLibraryStore(page);
  await page.route("**/__database_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Metadata fixture</title>"}));
  await page.goto("/__database_probe__");
  const counts=await page.evaluate(async()=>{
    const root="/__local_fixture__/",db=await import(root+"local-database.js"),cache=await import(root+"reader-cache.js"),scoped=await import(root+"scoped-store.js");
    await cache.writeReaderCache("owner","idea","one",{value:"Fixture"});
    let writes=0;const native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key){if(this.name==="meta")writes++;return native.call(this,value,key!);};
    for(let n=0;n<10;n++){await cache.readReaderCache("owner","idea","one");await cache.markReaderFresh("owner","one");await scoped.observeScopedAlive("owner",["one"],[],0);}
    const unchanged=writes;
    await cache.markReaderStale("owner");const marked=writes;
    await cache.markReaderStale("owner");const repeated=writes;
    await cache.markReaderFresh("owner","one");const fresh=writes;
    await scoped.noteScopedDeletion("owner","one");const deletion=writes;
    await scoped.observeScopedAlive("owner",["one"],[],0);const staleObservation=writes;
    await scoped.observeScopedAlive("owner",["one"],[],await scoped.scopedReadCounter());const alive=writes;
    IDBObjectStore.prototype.put=native;
    return {unchanged,marked,repeated,fresh,staleObservation:staleObservation-deletion,alive:alive-deletion};
  });
  expect(counts).toEqual({unchanged:0,marked:1,repeated:1,fresh:2,staleObservation:0,alive:1});
});
