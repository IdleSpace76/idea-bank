import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryStorage,schema } from "./entity-fixture.mjs";
const { entityKey,flattenLibrary,assembleLibrary } = schema;
const library = { version:1,sections:[{id:"s",name:"Section",description:"",icon:"folder"}],projects:[{id:"a",sectionId:"s",name:"Idea A",description:"",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"b1",heading:"One",text:"Original"},{id:"b2",heading:"Two",text:"Original"}]}] };
const fixture=memoryStorage();
try {
  const first={operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(library)).map(([key,value])=>({key,value,base:[]}))};
  await fixture.entities().save(first); const base=await fixture.entities().read();
  assert.equal(base.records.length,4);
  assert.equal((await fixture.entities().read(base.index)).records.length,0,"Unchanged records are not transmitted");
  const count=fixture.objects.size; await fixture.entities().save(first); assert.equal(fixture.objects.size,count,"Retry is idempotent");
  await assert.rejects(()=>fixture.entities().save({...first,changes:[] }));
  await assert.rejects(()=>fixture.storage.saveLibrary({baseRevisions:[],library,media:[]}),e=>e.code==="CLIENT_UPGRADE_REQUIRED");
  const k1=entityKey("block","a","b1"), k2=entityKey("block","a","b2");
  const make=(key,text)=>({operationId:randomUUID(),heads:base.heads,changes:[{key,base:base.index[key],value:{...base.records.find(r=>r.key===key).value,text}}]});
  const one=make(k1,"Changed one"),two=make(k2,"Changed two");
  // Both transactions observe the same global index and publish independently.
  await Promise.all([fixture.entities().save(one),fixture.entities().save(two)]);
  const merged=await fixture.entities().read();
  assert.equal(merged.index[k1].length,1); assert.equal(merged.index[k2].length,1); assert.equal(merged.heads.length,2);
  assert.equal(merged.records.find(r=>r.key===k1).value.text,"Changed one"); assert.equal(merged.records.find(r=>r.key===k2).value.text,"Changed two");
  await assert.rejects(()=>fixture.entities().save(make(k1,"Stale")),e=>e.code==="STALE_INDEX");
  // Actual simultaneous edits of the same record preserve two cloud heads.
  const fork={operationId:randomUUID(),heads:merged.heads,changes:[{key:k1,base:merged.index[k1],value:{id:"b1",heading:"One",text:"Left"}}]};
  const other={...fork,changes:[{...fork.changes[0],value:{...fork.changes[0].value,text:"Right"}}]};
  const send=fixture.storage.client.send.bind(fixture.storage.client); let arrivals=0, release;
  const barrier=new Promise(r=>{release=r;});
  fixture.storage.client.send=async command=>{
    if(command.constructor.name==="PutObjectCommand" && command.input.Key.includes("/indexes/")){if(++arrivals===2)release();await barrier;}
    return send(command);
  };
  await Promise.all([fixture.entities().save(fork),fixture.entities().save(other)]); fixture.storage.client.send=send;
  const conflicted=await fixture.entities().read();assert.equal(conflicted.index[k1].length,2);
  const resolved={operationId:randomUUID(),heads:conflicted.heads,changes:[{key:k1,base:conflicted.index[k1],value:{id:"b1",heading:"One",text:"Resolved"}}]};
  await fixture.entities().save(resolved);const done=await fixture.entities().read();assert.equal(done.index[k1].length,1);
  assert.equal(assembleLibrary(Object.fromEntries(done.records.map(r=>[r.key,r.value]))).projects[0].blocks[0].text,"Resolved");
  // A published manifest must not reference a missing media object.
  const missing={id:"f".repeat(64)+"-"+"a".repeat(32),sha256:"f".repeat(64),md5:"a".repeat(32),size:10,mime:"image/png"};
  await assert.rejects(()=>fixture.entities().save({operationId:randomUUID(),heads:done.heads,changes:[{key:entityKey("media",missing.id),base:[],value:missing}]}),e=>e.code==="MEDIA_MISSING");
  console.log("Entity storage checks passed: delta reads, idempotent retry, independent writes, concurrent conflicts, resolution, media verification and legacy write gate.");
} finally { fixture.storage.client.destroy(); }
const legacy=memoryStorage();
try {
  const formatted=structuredClone(library);
  formatted.projects[0].blocks[0].richText={type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Original",marks:[{type:"bold"},{type:"textStyle",attrs:{color:"#aabbcc",fontSize:"24px"}},{type:"link",attrs:{href:"https://example.org/"}}]}]}]};
  const saved=await legacy.storage.saveLibrary({baseRevisions:[],library:formatted,media:[]});
  const migrated=await legacy.entities().read();assert.equal(migrated.heads.length,1);
  assert.equal(assembleLibrary(Object.fromEntries(migrated.records.map(r=>[r.key,r.value]))).projects[0].name,"Idea A");
  assert.deepEqual(assembleLibrary(Object.fromEntries(migrated.records.map(r=>[r.key,r.value]))),formatted,"Migration must preserve formatting after sorted JSON storage");
  const count=legacy.objects.size;await legacy.entities().read();assert.equal(legacy.objects.size,count);
  const richKey=entityKey("block","a","b1"),richBlock=migrated.records.find(record=>record.key===richKey).value;
  await legacy.entities().save({operationId:randomUUID(),heads:migrated.heads,changes:[{key:richKey,base:migrated.index[richKey],value:{...richBlock,heading:"Edited heading"}}]});
  const richRead=await legacy.entities().read();assert.deepEqual(richRead.records.find(record=>record.key===richKey).value.richText,formatted.projects[0].blocks[0].richText);
  await assert.rejects(()=>legacy.storage.saveLibrary({baseRevisions:[saved.snapshot.revision],library,media:[]}),e=>e.code==="CLIENT_UPGRADE_REQUIRED");
  console.log("Legacy migration checks passed: preserved snapshot, deterministic import and repeatable migration.");
} finally { legacy.storage.client.destroy(); }
const late=memoryStorage();
try {
  const root=await late.storage.saveLibrary({baseRevisions:[],library,media:[]});const initial=await late.entities().read();
  const key=entityKey("block","a","b1");await late.entities().save({operationId:randomUUID(),heads:initial.heads,changes:[{key,base:initial.index[key],value:{id:"b1",heading:"One",text:"New protocol"}}]});
  const id=randomUUID(),old=structuredClone(library);old.projects[0].blocks[0].text="Late old deployment";
  const body=JSON.stringify({format:"idea-bank-cloud",version:1,revision:id,parents:[root.snapshot.revision],createdAt:new Date().toISOString(),library:old,media:[]});
  late.objects.set(`${late.storage.prefix}/revisions/${root.snapshot.revision}_${id}.json`,{body,type:"application/json"});
  const migrated=await late.entities().read();assert.equal(migrated.index[key].length,2);assert.deepEqual(migrated.records.filter(r=>r.key===key).map(r=>r.value.text).sort(),["Late old deployment","New protocol"]);
  console.log("Late legacy write check passed: both protocol versions survive as explicit record branches.");
} finally {late.storage.client.destroy();}
const history=memoryStorage();
try {
  let heads=[];const ids=[];
  for(let n=0;n<12;n++){const next=structuredClone(library);next.projects[0].description=`Revision ${n}`;const result=await history.storage.saveLibrary({baseRevisions:heads,library:next,media:[]});heads=result.heads;ids.push(result.snapshot.revision);}
  const read=await history.entities().read();assert.equal([...history.objects.keys()].filter(k=>k.includes("/indexes/")).length,1,"Only the current legacy head is imported");
  assert.equal(read.records.find(r=>r.key===entityKey("idea","a")).value.description,"Revision 11");assert.equal((await history.storage.readLibrary(ids[0])).snapshot.library.projects[0].description,"Revision 0");
  console.log("Long legacy history check passed: one current import, original historical snapshots retained.");
} finally {history.storage.client.destroy();}
const migrating=memoryStorage();
try {
  const root=await migrating.storage.saveLibrary({baseRevisions:[],library,media:[]});
  const send=migrating.storage.client.send.bind(migrating.storage.client);let releaseOld,releaseRoot,oldReady,rootReady;
  const oldBlocked=new Promise(r=>{releaseOld=r;}),rootBlocked=new Promise(r=>{releaseRoot=r;}),waitingOld=new Promise(r=>{oldReady=r;}),waitingRoot=new Promise(r=>{rootReady=r;});
  const newer=randomUUID();
  migrating.storage.client.send=async command=>{
    if(command.constructor.name==="PutObjectCommand"&&command.input.Key.includes("/indexes/")){
      const body=JSON.parse(command.input.Body);
      if(body.legacy===root.snapshot.revision){oldReady();await oldBlocked;}
      if(body.legacy===newer&&body.parents.length===0){rootReady();await rootBlocked;}
    }
    return send(command);
  };
  const first=migrating.entities().read();await waitingOld;
  const removed={...structuredClone(library),projects:[]};const body=JSON.stringify({format:"idea-bank-cloud",version:1,revision:newer,parents:[root.snapshot.revision],createdAt:new Date().toISOString(),library:removed,media:[]});
  migrating.objects.set(`${migrating.storage.prefix}/revisions/${root.snapshot.revision}_${newer}.json`,{body,type:"application/json"});
  const second=migrating.entities().read();await waitingRoot;releaseOld();await first;
  await migrating.entities().read();releaseRoot();await second;migrating.storage.client.send=send;
  const result=await migrating.entities().read();assert.equal(result.heads.length,1,"Equivalent imports have one deterministic frontier");assert.equal(assembleLibrary(Object.fromEntries(result.records.map(r=>[r.key,r.value]))).projects.length,0,"A late import cannot resurrect deleted ideas");
  console.log("Concurrent migration check passed: equivalent imports converge without overwritten indexes or resurrected deletions.");
} finally {migrating.storage.client.destroy();}
