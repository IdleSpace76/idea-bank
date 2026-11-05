import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { memoryStorage, schema, storageCache, EntityStorage, B2Storage } from "./entity-fixture.mjs";

// Fake time verifies expiry and bounds without waiting or using a real bucket.
const source=await readFile(new URL("../lib/storage-read-cache.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};let now=0;
vm.runInNewContext(compiled,{exports,Buffer,structuredClone,Date:{now:()=>now},require:name=>{assert.equal(name,"node:crypto");return {createHash};}});
const {cachedStorageRead:read,clearStorageReadCache:clear,STORAGE_READ_CACHE_TTL:ttl,STORAGE_READ_CACHE_ENTRIES:limit}=exports;
const owner={settings:{endpoint:"fixture",bucket:"one",keyId:"key",applicationKey:"secret"},prefix:"data"};
let calls=0,release;
const concurrent=Array.from({length:20},()=>read(owner,"same",async()=>{calls++;await new Promise(resolve=>release=resolve);return {nested:{value:1}};}));
assert.equal(calls,1);release();
const copies=await Promise.all(concurrent);copies[0].nested.value=9;
assert.equal(copies[1].nested.value,1,"Concurrent callers cannot mutate each other's values");
const load=async()=>{calls++;return {nested:{value:2}};};
assert.equal((await read({...owner},"same",load)).nested.value,1,"Instances for the same bucket and credentials share immutable data");
assert.equal(calls,1);
for(const other of [{...owner,settings:{...owner.settings,bucket:"two"}},{...owner,settings:{...owner.settings,applicationKey:"rotated"}},{...owner,prefix:"different"}])assert.equal((await read(other,"same",load)).nested.value,2);
assert.equal(calls,4,"Bucket, credentials and prefix isolate caches");
now=ttl;await read(owner,"same",load);assert.equal(calls,5,"Expired entries are re-read");
clear();calls=0;
for(let n=0;n<2;n++)assert.equal(await read(owner,"missing",async()=>{calls++;return null;}),null);
for(let n=0;n<2;n++)await assert.rejects(()=>read(owner,"error",async()=>{calls++;throw new Error("Fixture denied");}));
assert.equal(calls,4,"Missing objects and errors are not retained");
clear();calls=0;
for(let n=0;n<=limit;n++)await read(owner,String(n),async()=>{calls++;return n;});
await read(owner,"0",async()=>{calls++;return 0;});assert.equal(calls,limit+2,"Entry count has an LRU bound");
clear();calls=0;
const large=async()=>{calls++;return "x".repeat(3*1024*1024);};
for(const key of ["a","b","c","a"])await read(owner,key,large);
assert.equal(calls,4,"The byte limit evicts old large entries");
clear();
let fresh=0;const held=read(owner,"clear-race",async()=>{await new Promise(resolve=>release=resolve);return "old";});
clear();release();await held;
assert.equal(await read(owner,"clear-race",async()=>{fresh++;return "new";}),"new");assert.equal(fresh,1);
console.log("Storage cache bounds: coalescing, caller isolation, credential isolation, expiry, LRU, bytes, missing objects and failures passed.");

const f=memoryStorage(),{flattenLibrary,entityKey}=schema;
const library={version:1,sections:[{id:"s",name:"Section",description:"",icon:"folder"}],projects:[{id:"i",sectionId:"s",name:"Idea",description:"",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"b",heading:"Heading",text:"Before"}]}]};
const send=f.storage.client.send.bind(f.storage.client);let commands=[];
f.storage.client.send=async command=>{commands.push({name:command.constructor.name,key:command.input.Key || command.input.Prefix});return send(command);};
const measure=async fn=>{commands=[];const result=await fn();return {result,b:commands.filter(c=>["GetObjectCommand","HeadObjectCommand"].includes(c.name)).length,c:commands.filter(c=>c.name==="ListObjectsV2Command").length};};
try {
  await f.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(library)).map(([key,value])=>({key,value,base:[]}))});
  await f.entities().catalog().readPage();
  storageCache.clearStorageReadCache();
  const cold=await measure(()=>f.entities().catalog().readPage());
  const warm=await measure(()=>f.entities().catalog().readPage());
  assert.equal(cold.b,4);assert.equal(warm.b,1);assert.equal(warm.c,1,"Current frontier is still checked in B2 on every read");
  const sidebar=await measure(()=>f.entities().catalog().readPage({sectionId:"s",limit:4}));assert.equal(sidebar.b,1);
  const opened=await f.entities().catalog().readIdea("i");
  const conditional=await measure(()=>f.entities().catalog().readIdea("i",opened.version));
  assert.equal(conditional.result.notModified,true);assert.equal(conditional.b,1);
  const again=await measure(()=>f.entities().catalog().readIdea("i"));assert.equal(again.b,1);
  again.result.idea.blocks[0].text="Mutated by caller";
  assert.equal((await f.entities().catalog().readIdea("i")).idea.blocks[0].text,"Before");
  const base=await f.entities().catalogIndex(),key=entityKey("block","i","b");
  await f.entities().save({operationId:randomUUID(),heads:base.heads,changes:[{key,base:base.index[key],value:{...library.projects[0].blocks[0],text:"After"}}]});
  assert.equal((await f.entities().catalog().readIdea("i")).idea.blocks[0].text,"After","A newly published version is visible without cache expiry");
  await f.entities().catalog().readPage();
  const pointer=JSON.parse(f.objects.get([...f.objects.keys()].filter(key=>key.includes("/views/")).at(-1)).body);
  const pageKey=JSON.parse(f.objects.get(pointer.root).body).pages[0].key,original=f.objects.get(pageKey);
  f.objects.set(pageKey,{...original,body:"[]"});
  await assert.rejects(()=>f.entities().catalog().put(pageKey,JSON.parse(original.body)),e=>e.code==="INVALID_CATALOG","Pre-write existence/integrity checks bypass a warm read cache");
  f.objects.set(pageKey,original);
  // Concurrent requests for a not-yet-built projection build it once.
  for(const key of [...f.objects.keys()])if(key.includes("/catalog-v1/views/"))f.objects.delete(key);
  storageCache.clearStorageReadCache();commands=[];
  await Promise.all(Array.from({length:20},()=>f.entities().catalog().readPage()));
  assert.equal(commands.filter(c=>c.name==="PutObjectCommand" && c.key.includes("/catalog-v1/views/")).length,1);
  // A different storage client (as on a new API request) shares immutable reads.
  const second=new B2Storage({...f.storage.settings});second.client.send=f.storage.client.send;
  try {const other=await measure(()=>new EntityStorage(second).catalog().readPage());assert.equal(other.b,1);}finally{second.client.destroy();}
  console.log(`Storage request budget: warm catalog ${cold.b} → ${warm.b} Class B calls; sidebar, full idea and unchanged idea: 1 each. Fresh frontier and immediate post-write visibility preserved.`);
} finally {f.storage.client.destroy();storageCache.clearStorageReadCache();}
