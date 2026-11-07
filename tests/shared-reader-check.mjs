import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {chromium,expect} from "@playwright/test";

// Route-only origin: no Next server, real B2, user profile or user database is used.
const origin="http://127.0.0.1:39991",compiled=new Map();
const browser=await chromium.launch({channel:"msedge",headless:true});
try {
  for(const fallback of [false,true]) {
    const context=await browser.newContext();let reads=0,fail=false;
    if(fallback)await context.addInitScript(()=>Object.defineProperty(navigator,"locks",{configurable:true,value:undefined}));
    await context.route(`${origin}/**`,async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==="/read"){reads++;return route.fulfill({status:fail?503:200,body:"{}",contentType:"application/json"});}
      if(path.endsWith(".js")) {
        const name=path.slice(1,-3);assert.ok(["shared-reader-check","sync-lock","local-database","i18n","translations"].includes(name));
        if(!compiled.has(name))compiled.set(name,ts.transpileModule(await readFile(`lib/${name}.ts`,"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from "\.\/([\w-]+)"/g,'from "./$1.js"'));
        return route.fulfill({contentType:"text/javascript",body:compiled.get(name)});
      }
      return route.fulfill({contentType:"text/html",body:"<!doctype html><title>Isolated reader coordination</title>"});
    });
    const a=await context.newPage(),b=await context.newPage(),now=Date.now();
    for(const page of [a,b]){await page.goto(origin);await page.evaluate(async now=>{
      window.testNow=now;Date.now=()=>window.testNow;
      window.reader=await import("/shared-reader-check.js");window.notifications=[];
      window.stopReader=window.reader.subscribeReaderChecks(scope=>window.notifications.push(scope));
    },now);}
    assert.equal(await a.evaluate(()=>!!navigator.locks),!fallback);
    const check=(page,scope="owner")=>page.evaluate(async scope=>window.reader.runSharedReaderCheck(scope,async()=>{
      const response=await fetch("/read");if(!response.ok)throw new Error("Fixture offline");await window.reader.noteReaderCheck(scope);
    }),scope);
    await Promise.all([check(a),check(b)]);assert.equal(reads,1,"Two tabs share one ten-minute check");
    await expect.poll(()=>Promise.all([a,b].map(page=>page.evaluate(()=>window.notifications.length))).then(counts=>counts.reduce((sum,n)=>sum+n,0))).toBe(1);
    await Promise.all([check(a),check(b)]);assert.equal(reads,1,"A recent successful check suppresses further automatic requests");
    for(const page of [a,b])await page.evaluate(()=>window.testNow+=600001);
    await Promise.all([check(a),check(b)]);assert.equal(reads,2,"After ten minutes exactly one tab checks again");
    await check(b,"other-owner");assert.equal(reads,3,"Storage scopes never share the freshness stamp");
    fail=true;await assert.rejects(()=>check(a,"failed-scope"));
    fail=false;await check(b,"failed-scope");assert.equal(reads,5,"Failed checks release their lease and do not mark data fresh");
    // Invalid future timestamps must not suppress checks after a device clock adjustment.
    await a.evaluate(async()=>{const {transaction,request}=await import("/local-database.js");await transaction(["meta"],"readwrite",async tx=>{await request(tx.objectStore("meta").put(window.testNow+3600000,"reader-verified:future"));});});
    await check(a,"future");assert.equal(reads,6);
    const event=(page,ids,confirm=true)=>page.evaluate(async({ids,confirm})=>window.reader.runSharedReaderEvents("events",ids,async()=>{
      const response=await fetch("/read");if(!response.ok)throw new Error("Fixture offline");await window.reader.noteReaderCheck("events");return confirm?ids:[];
    }),{ids,confirm});
    await Promise.all([event(a,["revision-a"]),event(b,["revision-a"])]);assert.equal(reads,7,"Two tabs fetch one broker event only once, without waiting for ten minutes");
    await event(b,["revision-a"]);assert.equal(reads,7,"A confirmed duplicate event uses local cache");
    await Promise.all([event(a,["revision-b"]),event(b,["revision-b"])]);assert.equal(reads,8,"A different event is fetched immediately despite a recent check");
    await event(a,["not-yet-visible"],false);await event(b,["not-yet-visible"]);assert.equal(reads,10,"An event absent from the server snapshot must not be marked processed");
    fail=true;await assert.rejects(()=>event(a,["failed-event"]));fail=false;await event(b,["failed-event"]);assert.equal(reads,12,"An event can be retried by another tab after failure");
    const holdWriter=()=>a.evaluate(async()=>{
      const {withSyncLock}=await import("/sync-lock.js");let started;
      const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>window.releaseWriter=resolve);
      window.writer=withSyncLock(async()=>{started();await gate;});await entered;
    });
    await holdWriter();
    const echo=event(b,["own-write"]);await new Promise(resolve=>setTimeout(resolve,150));assert.equal(reads,12,"A broker echo waits for the shared in-flight writer");
    await a.evaluate(async()=>{
      const {transaction}=await import("/local-database.js");
      await transaction(["meta"],"readwrite",tx=>window.reader.rememberReaderEventsIn(tx,"events",["own-write"]));
      window.releaseWriter();await window.writer;
    });await echo;assert.equal(reads,12,"An atomic local acknowledgement suppresses the sibling tab's cloud echo");
    await holdWriter();
    const foreign=event(b,["foreign-during-write"]);
    await a.evaluate(async()=>{window.releaseWriter();await window.writer;});await foreign;
    assert.equal(reads,13,"Waiting for a writer never drops a foreign revision or an unacknowledged write");
    await a.evaluate(async()=>{
      const {transaction}=await import("/local-database.js");
      try{await transaction(["meta"],"readwrite",async tx=>{await window.reader.rememberReaderEventsIn(tx,"events",["aborted-write"]);throw new Error("Abort fixture");});}catch{}
    });await event(b,["aborted-write"]);assert.equal(reads,14,"An aborted local transaction must not acknowledge a revision");
    await context.close();
    console.log(`Shared reader checks passed (${fallback?"IndexedDB lease":"Web Locks"}): shared safety and broker reads, distinct revisions, server confirmation, expiry, broadcast, failure retry and clock adjustment.`);
  }
}finally{await browser.close();}
