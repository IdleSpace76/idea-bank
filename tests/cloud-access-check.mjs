import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source=await readFile(new URL("../lib/cloud-access.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let now=1000000, calls=0, mode="ok", release;
const exports={};
vm.runInNewContext(compiled,{exports,Headers,Date:{now:()=>now},fetch:async()=>{
  calls++;
  if(mode==="held")await new Promise(resolve=>release=resolve);
  if(mode==="denied")return Response.json({error:{code:"STORAGE_ACCESS_DENIED",message:"Fixture denied"}},{status:503});
  if(mode==="unavailable")return Response.json({error:{code:"STORAGE_UNAVAILABLE",message:"Fixture unavailable"}},{status:502});
  if(mode==="network")throw new TypeError("Fixture network");
  return Response.json({ok:true});
}});
const {cloudFetch,cloudBackoffRemaining,retryCloudAccess,CloudAccessError}=exports;
mode="held";
const concurrent=Array.from({length:20},()=>cloudFetch("/api/catalog?limit=24",{},"owner"));
assert.equal(calls,1,"Twenty concurrent identical reads produce one HTTP request");
release();
for(const response of await Promise.all(concurrent))assert.deepEqual(await response.json(),{ok:true},"Every consumer can independently read the body");
mode="ok";
await cloudFetch("/api/catalog?limit=24",{},"another-owner");
assert.equal(calls,2);
mode="denied";
assert.equal((await cloudFetch("/api/catalog",{})).status,503);
assert.equal(cloudBackoffRemaining(),300000);
const before=calls;
for(let n=0;n<50;n++)await assert.rejects(()=>cloudFetch(n%2?"/api/ideas/i":"/api/sync/scoped",n%2?{}:{method:"PUT",body:"fixture"}),e=>e instanceof CloudAccessError && e.code==="STORAGE_ACCESS_DENIED" && e.status===503);
assert.equal(calls,before,"Reads and queued writes cannot bypass the B2 denial pause");
now+=299999;
await assert.rejects(()=>cloudFetch("/api/catalog",{}));assert.equal(calls,before);
now++;
mode="ok";await cloudFetch("/api/catalog",{});
assert.equal(calls,before+1);assert.equal(cloudBackoffRemaining(),0);
mode="denied";await cloudFetch("/api/catalog",{});
retryCloudAccess();mode="ok";await cloudFetch("/api/catalog",{});
assert.equal(cloudBackoffRemaining(),0,"Explicit retry bypasses the pause");
mode="unavailable";
for(const expected of [5000,15000,60000,300000,300000]){
  await cloudFetch("/api/catalog",{});assert.equal(cloudBackoffRemaining(),expected);now+=expected;
}
retryCloudAccess();mode="network";await assert.rejects(()=>cloudFetch("/api/catalog",{}));
assert.equal(cloudBackoffRemaining(),5000);
await assert.rejects(()=>cloudFetch("/api/catalog",{}),e=>e.code==="NETWORK");
console.log("Cloud access: concurrent reads, B2 denial pause, queued-write protection, explicit retry and bounded backoff passed.");
