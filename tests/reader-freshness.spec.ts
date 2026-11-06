import {test,expect} from "@playwright/test";
import {exposeLibraryStore} from "./local-fixture";

test("catalog validation promotes matching pages; invalidated in-flight reads cannot restore freshness",async({page})=>{
  await exposeLibraryStore(page);
  await page.route("**/__freshness_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Cache fixture</title>"}));
  await page.goto("/__freshness_probe__");
  const result=await page.evaluate(async()=>{
    const cache=await import("/__local_fixture__/"+"reader-cache.js"),scope="fixture";
    await cache.writeReaderCache(scope,"page","root",{revision:"A",items:["root"]});
    await cache.writeReaderCache(scope,"page","section",{revision:"A",items:["section"]});
    await cache.writeReaderCache("other","page","root",{revision:"Z"});
    const original=await cache.readReaderCacheState(scope,"page","section");
    await cache.markReaderStale(scope);
    const invalid=await cache.readReaderCacheState(scope,"page","section");
    await cache.writeReaderCache(scope,"page","root",{revision:"A",items:["root"]},undefined,invalid.epoch);
    const promoted=await cache.readReaderCacheState(scope,"page","section");
    await cache.markReaderStale(scope);
    const latest=await cache.readReaderCacheState(scope,"page","root");
    await cache.writeReaderCache(scope,"page","root",{revision:"B",items:["new"]},undefined,latest.epoch);
    await cache.writeReaderCache(scope,"page","root",{revision:"A",items:["late"]},undefined,original.epoch);
    const root=await cache.readReaderCacheState(scope,"page","root"),section=await cache.readReaderCacheState(scope,"page","section"),other=await cache.readReaderCacheState("other","page","root");
    return {original:original.fresh,invalid:invalid.fresh,promoted:promoted.fresh,root,section:section.fresh,other:other.fresh};
  });
  expect(result.original).toBe(true);expect(result.invalid).toBe(false);expect(result.promoted).toBe(true);
  expect(result.root.fresh).toBe(true);expect(result.root.value).toEqual({revision:"B",items:["new"]});
  expect(result.section).toBe(false);expect(result.other).toBe(true);
});

test("persisted pages are revalidated once for a new browser page session",async({page})=>{
  await exposeLibraryStore(page);
  await page.route("**/__freshness_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Session fixture</title>"}));
  await page.goto("/__freshness_probe__");
  await page.evaluate(async()=>{const cache=await import("/__local_fixture__/"+"reader-cache.js");await cache.writeReaderCache("session","page","root",{revision:"A"});await cache.writeReaderCache("session","page","section",{revision:"A"});});
  await page.reload();
  const result=await page.evaluate(async()=>{
    const cache=await import("/__local_fixture__/"+"reader-cache.js");
    const before=await cache.readReaderCacheState("session","page","section");
    await cache.writeReaderCache("session","page","root",{revision:"A"},undefined,before.epoch);
    const after=await cache.readReaderCacheState("session","page","section");
    return {before:before.fresh,retained:before.value,after:after.fresh};
  });
  expect(result).toEqual({before:false,retained:{revision:"A"},after:true});
});

test("an invalidated response can retain newer text without overwriting newer data or declaring it fresh",async({page})=>{
  await exposeLibraryStore(page);
  await page.route("**/__freshness_probe__",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Response fixture</title>"}));
  await page.goto("/__freshness_probe__");
  const result=await page.evaluate(async()=>{
    const cache=await import("/__local_fixture__/"+"reader-cache.js");
    await cache.writeReaderCache("response","idea","one",{text:"Original"});
    await cache.markReaderStale("response");
    const started=await cache.readReaderCacheState("response","idea","one");
    await cache.markReaderStale("response");
    await cache.writeReaderCache("response","idea","one",{text:"Downloaded"},undefined,started.epoch);
    const retained=await cache.readReaderCacheState("response","idea","one");
    await cache.writeReaderCache("response","idea","one",{text:"Older response"},undefined,started.epoch-1);
    const protectedValue=await cache.readReaderCacheState("response","idea","one");
    return {retained,protectedValue};
  });
  expect(result.retained.value).toEqual({text:"Downloaded"});expect(result.retained.fresh).toBe(false);
  expect(result.protectedValue.value).toEqual({text:"Downloaded"});expect(result.protectedValue.fresh).toBe(false);
});
