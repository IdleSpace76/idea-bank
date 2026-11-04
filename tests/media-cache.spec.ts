import { test, expect } from "@playwright/test";
import { exposeLibraryStore, readStoredLibrary, setStoredLibrary } from "./local-fixture";

test("LRU removes cloud copies, protects local originals and invalidates overwritten cache entries",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card")).toHaveCount(1);
  await exposeLibraryStore(page);
  const result=await page.evaluate(async()=>{
    const {transaction,request}=await import("/__local_fixture__/"+"local-database.js");
    const {pruneCacheIn,cacheKey}=await import("/__local_fixture__/"+"media-cache-store.js");
    const {saveMediaFiles}=await import("/__local_fixture__/"+"media-store.js");
    await transaction(["meta","media"],"readwrite",async (tx:IDBTransaction)=>{
      const meta=tx.objectStore("meta"),files=tx.objectStore("media");
      meta.put({scope:"fixture"},"sync-v2");
      for(const id of ["old","recent","unsent","overwritten"])files.put(new Blob([id]),id);
      meta.put({old:{scope:"fixture",size:10,used:1},recent:{scope:"fixture",size:10,used:2},overwritten:{scope:"fixture",size:10,used:3}},cacheKey);
    });
    await saveMediaFiles(new Map([["overwritten",new Blob(["new local bytes"])]]));
    await transaction(["meta","media"],"readwrite",(tx:IDBTransaction)=>pruneCacheIn(tx,"fixture",10));
    const retained=await transaction(["media"],"readonly",async (tx:IDBTransaction)=>request(tx.objectStore("media").getAllKeys()));
    // A cache from a different deployment cannot be evicted using the current deployment's proof.
    await transaction(["meta","media"],"readwrite",(tx:IDBTransaction)=>pruneCacheIn(tx,"other-scope",0));
    const afterWrongScope=await transaction(["media"],"readonly",async (tx:IDBTransaction)=>request(tx.objectStore("media").getAllKeys()));
    return {retained,afterWrongScope};
  });
  expect(result.retained).not.toContain("old");
  for(const id of ["recent","unsent","overwritten"])expect(result.retained).toContain(id);
  expect(result.afterWrongScope).toEqual(result.retained);
});

test("large lists render in batches and off-screen media are not read until opened",async({page})=>{
  await page.goto("/");await expect(page.locator(".project-card")).toHaveCount(1);
  const library=await page.evaluate(readStoredLibrary),base=library.projects[0];
  const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=","base64");
  library.projects=Array.from({length:60},(_,index)=>({...structuredClone(base),id:`idea-${index}`,name:`Idea ${index}`,coverImage:undefined,blocks:index?[]:Array.from({length:20},(_,n)=>({id:`block-${n}`,heading:`Image ${n}`,text:"",media:[{id:`image-${n}`,name:`image-${n}.png`,mime:"image/png",kind:"image" as const,size:pixel.length,displaySize:{width:600,height:600}}]}))}));
  await setStoredLibrary(page,library);
  await page.evaluate(async bytes=>{
    const {saveMediaFiles}=await import("/__local_fixture__/"+"media-store.js");
    await saveMediaFiles(new Map(Array.from({length:20},(_,n)=>[`image-${n}`,new Blob([new Uint8Array(bytes)],{type:"image/png"})])));
    const original=IDBObjectStore.prototype.get;
    (window as any).mediaReads=[];
    IDBObjectStore.prototype.get=function(key){if(this.name==="media")(window as any).mediaReads.push(String(key));return original.call(this,key);};
  },[...pixel]);
  await expect(page.locator(".project-card")).toHaveCount(24);
  // Desktop cards are hidden on mobile, but filtering exposes the common grid.
  await page.getByRole("searchbox",{name:"Найти идею",exact:true}).fill("Idea");
  await page.getByRole("button",{name:"Показать ещё идеи",exact:true}).click();
  await expect(page.locator(".project-card")).toHaveCount(48);
  await page.getByRole("button",{name:"Показать ещё идеи",exact:true}).click();
  await expect(page.locator(".project-card")).toHaveCount(60);
  await page.locator(".project-card").filter({has:page.getByText("Idea 0",{exact:true})}).click();
  await expect(page.locator(".image-preview img").first()).toBeVisible();
  expect(await page.evaluate(()=>(window as any).mediaReads)).not.toContain("image-19");
  await page.locator(".media-item").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".media-item").last().locator(".image-preview img")).toBeVisible();
  expect(await page.evaluate(()=>(window as any).mediaReads)).toContain("image-19");
});
