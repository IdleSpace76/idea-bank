import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { memoryStorage, schema, storageCache, B2Storage, EntityStorage } from "./entity-fixture.mjs";

const f=memoryStorage(),calls=[],send=f.storage.client.send.bind(f.storage.client);
f.storage.client.send=async command=>{calls.push({name:command.constructor.name,key:command.input.Key || command.input.Prefix});return send(command);};
// Each API request owns a new B2Storage; only immutable JSON caches survive across requests.
async function request(work) {
  const storage=new B2Storage({...f.storage.settings});storage.client.send=f.storage.client.send;
  try{return await work(new EntityStorage(storage),storage);}finally{storage.client.destroy();}
}
const measure=async work=>{calls.length=0;const result=await request(work);return {result,get:calls.filter(c=>c.name==="GetObjectCommand").length,head:calls.filter(c=>c.name==="HeadObjectCommand").length,list:calls.filter(c=>c.name==="ListObjectsV2Command").length,put:calls.filter(c=>c.name==="PutObjectCommand").length,calls:[...calls]};};
const bytes=Buffer.from("Request budget fixture"),file={id:"",sha256:createHash("sha256").update(bytes).digest("hex"),md5:createHash("md5").update(bytes).digest("hex"),mime:"image/png",size:bytes.length};file.id=schema.contentId(file);
const asset={id:file.id,name:"fixture.png",kind:"image",mime:file.mime,size:file.size};
const library={version:1,sections:Array.from({length:3},(_,n)=>({id:`s${n}`,name:`Section ${n}`,description:"",icon:"folder"})),projects:Array.from({length:50},(_,n)=>({id:`i${n}`,sectionId:`s${n%3}`,name:`Idea ${n}`,description:"Description",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",...(n===0?{coverImage:asset}:{}),blocks:[{id:"b",heading:"Heading",text:`Body ${n}`,...(n===0?{media:[asset]}:{})}]}))};
const recordPath=key=>`/records/${createHash("sha256").update(key).digest("hex")}/`;
const viewKey=heads=>`${f.storage.prefix}/sync-v2/catalog-v1/views/${createHash("sha256").update(schema.stable(["reader-2",heads])).digest("hex")}.json`;
async function assertProjection(source) {
  await request(async entities=>{
    const catalog=entities.catalog(),actual=await catalog.view(source.heads);
    const expected=await catalog.build({heads:source.heads,index:source.index});
    assert.ok(schema.equal(actual,expected),"An incremental projection must equal a full reconstruction, including counts and conflict flags");
  });
}
try {
  f.objects.set(`${f.storage.prefix}/media/${file.id}`,{body:bytes,type:file.mime,metadata:{sha256:file.sha256},md5:file.md5});
  await request(entities=>entities.save({operationId:randomUUID(),heads:[],changes:Object.entries(schema.flattenLibrary(library,[file])).map(([key,value])=>({key,value,base:[]}))}));
  let page=await request(entities=>entities.readReaderBatch({pages:[{}],sidebar:true}));
  let source=await request(entities=>entities.catalogIndex());
  const edit=async changes=>{
    await request(entities=>entities.save({operationId:randomUUID(),heads:source.heads,changes:changes.map(([key,value])=>({key,value,base:source.index[key] || []}))}));
    source=await request(entities=>entities.catalogIndex());
  };
  const key=schema.entityKey("block","i0","b");
  await edit([[key,{...library.projects[0].blocks[0],text:"Edited"}]]);
  const warm=await measure(entities=>entities.readReaderBatch({since:page.heads,pages:[{}],sidebar:true}));
  assert.ok(warm.get<=12,`One block edit must not recheck all 50 descriptors/shards: ${warm.get} GETs`);
  assert.ok(!warm.calls.some(c=>c.key.includes(recordPath(schema.entityKey("idea","i1")))),"Unchanged idea metadata is reused");
  await assertProjection(source);page=warm.result;
  // Expired process caches must not turn the next small edit into a full rebuild either.
  await edit([[key,{...library.projects[0].blocks[0],text:"Edited again"}]]);
  storageCache.clearStorageReadCache();
  const cold=await measure(entities=>entities.readReaderBatch({since:page.heads,pages:[{}],sidebar:true}));
  assert.ok(cold.get<=20,`Cold incremental build has a bounded request budget: ${cold.get} GETs`);
  const ideaGets=cold.calls.filter(c=>c.name==="GetObjectCommand" && library.projects.some(idea=>c.key.includes(recordPath(schema.entityKey("idea",idea.id)))));
  assert.equal(ideaGets.length,1,"A cold rebuild fetches metadata of the changed idea only");
  await assertProjection(source);page=cold.result;
  // Several saves may happen while no list is open: reuse the last READY ancestor.
  for(let n=0;n<4;n++)await edit([[key,{...library.projects[0].blocks[0],text:`Unlisted edit ${n}`}]]);
  storageCache.clearStorageReadCache();
  const skipped=await measure(entities=>entities.readReaderBatch({pages:[{}],sidebar:true}));
  assert.ok(skipped.get<=22,`Missing intermediate projections must not trigger a 100-GET rebuild: ${skipped.get}`);
  await assertProjection(source);page=skipped.result;
  // Media tickets must use a current published projection, not either history prefix.
  const ticket=await measure(entities=>entities.readReaderBatch({mediaOnly:true,media:[file.id]}));
  assert.ok(ticket.result.media[0].download?.url);assert.equal(ticket.list,1);assert.equal(ticket.head,1);
  assert.ok(!ticket.calls.some(c=>c.name==="HeadObjectCommand" && c.key.includes("/media/")),"Signing a verified library attachment does not issue a separate media HEAD");
  assert.ok(ticket.get<=2,`A media lookup reads only its uncached shard and media record: ${ticket.get}`);
  assert.ok(ticket.calls.every(c=>!c.key.includes("/indexes/") && !c.key.includes("/revisions/")),"Media tickets never scan version history when a catalog exists");
  assert.deepEqual(ticket.result.changes,{index:{},records:[],previous:[]});
  const signing=await measure((_entities,storage)=>storage.signDownload(file));
  assert.equal(signing.calls.length,0,"Presigning an authorized attachment is local work, not a B2 operation");
  await request(async(_entities,storage)=>assert.rejects(()=>storage.signDownload({...file,size:0}),e=>e.code==="INVALID_DATA"));
  // A pending catalog must not trigger a full build just to sign a newly uploaded file.
  await edit([[key,{...library.projects[0].blocks[0],text:"Catalog not built yet"}]]);
  storageCache.clearStorageReadCache();
  const pending=await measure(entities=>entities.readReaderBatch({mediaOnly:true,media:[file.id]}));
  assert.ok(pending.result.media[0].download);assert.equal(pending.put,0);
  assert.equal(f.objects.has(viewKey(source.heads)),false);
  await request(entities=>entities.readReaderBatch({pages:[{}]}));
  // Changes in section metadata, moves, creation and deletion all agree with a full rebuild.
  await edit([[schema.entityKey("section","s0"),{...library.sections[0],name:"Renamed"}]]);
  await request(entities=>entities.readReaderBatch({pages:[{}]}));await assertProjection(source);
  const metadata=await request(entities=>entities.version(schema.entityKey("idea","i1"),source.index[schema.entityKey("idea","i1")][0]));
  await edit([[metadata.key,{...metadata.value,sectionId:"s0",name:"Moved",updatedAt:"2026-02-01T00:00:00Z"}]]);
  await request(entities=>entities.readReaderBatch({pages:[{}]}));await assertProjection(source);
  const added={...library.projects[2],id:"new",blocks:[{id:"b",heading:"New",text:"New"}]};
  await edit(Object.entries(schema.flattenLibrary({version:1,sections:[],projects:[added]})));
  await request(entities=>entities.readReaderBatch({pages:[{}]}));await assertProjection(source);
  await edit([[schema.entityKey("idea","new"),null],[schema.entityKey("block","new","b"),null]]);
  await request(entities=>entities.readReaderBatch({pages:[{}]}));await assertProjection(source);
  // Older catalogs have no index snapshot; one complete rebuild upgrades the projection.
  const parent=await request(entities=>entities.catalog().view(source.heads));
  const old={...parent};delete old.sourceIndex;
  const oldKey=`${f.storage.prefix}/sync-v2/catalog-v1/objects/${createHash("sha256").update(schema.stable(old)).digest("hex")}.json`;
  f.objects.set(oldKey,{body:schema.stable(old),type:"application/json"});
  f.objects.set(viewKey(source.heads),{body:JSON.stringify({root:oldKey}),type:"application/json"});
  f.objects.delete(`${f.storage.prefix}/sync-v2/catalog-v1/last-ready.json`);
  storageCache.clearStorageReadCache();
  await edit([[key,{...library.projects[0].blocks[0],text:"Upgrade old projection"}]]);
  await request(entities=>entities.readReaderBatch({pages:[{}]}));await assertProjection(source);
  // A read-only media miss and a builder can coalesce; the builder must retry the miss.
  f.objects.delete(viewKey(source.heads));storageCache.clearStorageReadCache();
  const beforeRace=f.storage.client.send;let release,started;
  const gate=new Promise(resolve=>release=resolve),waiting=new Promise(resolve=>started=resolve);
  let hold=true;
  f.storage.client.send=async command=>{if(hold && command.constructor.name==="GetObjectCommand" && command.input.Key===viewKey(source.heads)){hold=false;started();await gate;}return beforeRace(command);};
  const lookup=request(entities=>entities.catalog().readMediaBatch([file.id]));await waiting;
  const builder=request(entities=>entities.catalog().readPage());await new Promise(resolve=>setTimeout(resolve,0));release();
  assert.equal(await lookup,null);assert.equal((await builder).total,50);f.storage.client.send=beforeRace;
  const readyHeads=source.heads;
  await edit([[key,{...library.projects[0].blocks[0],text:"Missing hint root 1"}]]);
  await edit([[key,{...library.projects[0].blocks[0],text:"Missing hint root 2"}]]);
  f.objects.set(`${f.storage.prefix}/sync-v2/catalog-v1/last-ready.json`,{body:JSON.stringify({heads:readyHeads,root:`${f.storage.prefix}/sync-v2/catalog-v1/objects/${"0".repeat(64)}.json`}),type:"application/json"});
  await request(entities=>entities.readReaderBatch({pages:[{}]}));await assertProjection(source);
  // One request deduplicates even concurrent checks, but validates every caller's metadata.
  const checks=await measure(async(entities,storage)=>{
    await Promise.all(Array.from({length:8},()=>storage.verifyMedia(file)));
    await storage.verifyMedia({...file,id:"another-reference"});
    await assert.rejects(()=>storage.verifyMedia({...file,size:file.size+1}),error=>error.code==="MEDIA_MISMATCH");
    await assert.rejects(()=>storage.verifyMedia({...file,mime:"video/mp4"}),error=>error.code==="MEDIA_MISMATCH");
  });assert.equal(checks.head,1);
  const another=await measure((entities,storage)=>storage.verifyMedia(file));assert.equal(another.head,1,"A different request must verify the file again");
  // Missing files and transient failures must not poison a subsequent retry/upload.
  const mediaKey=`${f.storage.prefix}/media/${file.id}`,original=f.objects.get(mediaKey);f.objects.delete(mediaKey);
  await request(async(entities,storage)=>{await assert.rejects(()=>storage.verifyMedia(file),e=>e.code==="MEDIA_MISSING");f.objects.set(mediaKey,original);await storage.verifyMedia(file);});
  let fail=true;const checkedSend=f.storage.client.send;
  f.storage.client.send=async command=>{if(fail && command.constructor.name==="HeadObjectCommand"){fail=false;throw new Error("Transient");}return checkedSend(command);};
  await request(async(entities,storage)=>{await assert.rejects(()=>storage.verifyMedia(file),/Transient/);await storage.verifyMedia(file);});
  f.storage.client.send=checkedSend;
  const ideaKey=schema.entityKey("idea","i0"),mediaRecord=schema.entityKey("media",file.id);
  const metadata0=(await request(entities=>entities.version(ideaKey,source.index[ideaKey][0]))).value;
  const savedChecks=await measure(entities=>entities.save({operationId:randomUUID(),heads:source.heads,changes:[
    {key:mediaRecord,value:file,base:source.index[mediaRecord]},
    {key:ideaKey,value:metadata0,base:source.index[ideaKey]},
    {key,value:{...library.projects[0].blocks[0],text:"Shared verified media"},base:source.index[key]},
  ]}));
  assert.equal(savedChecks.calls.filter(c=>c.name==="HeadObjectCommand" && c.key===mediaKey).length,1,"The media record, cover and block references share one verification during a real save");
  console.log(`Storage optimization budget (50 ideas): catalog rebuild ${warm.get} warm / ${cold.get} cold / ${skipped.get} after four unlisted saves; media ticket ${ticket.get} GET + ${ticket.head} HEAD + ${ticket.list} LIST; repeated file verification ${checks.head} HEAD. Incremental projections match full reconstruction.`);
}finally{f.storage.client.destroy();storageCache.clearStorageReadCache();}

const empty=memoryStorage();
try {
  await empty.entities().catalog().readPage();
  const pointerKey=[...empty.objects.keys()].find(key=>key.includes("/views/"));
  const pointer=JSON.parse(empty.objects.get(pointerKey).body),old=JSON.parse(empty.objects.get(pointer.root).body);delete old.sourceIndex;
  const key=`${empty.storage.prefix}/sync-v2/catalog-v1/objects/${createHash("sha256").update(schema.stable(old)).digest("hex")}.json`;
  empty.objects.set(key,{body:schema.stable(old),type:"application/json"});
  empty.objects.set(pointerKey,{body:JSON.stringify({root:key}),type:"application/json"});storageCache.clearStorageReadCache();
  assert.equal((await empty.entities().catalog().readPage()).total,0,"An existing empty catalog without sourceIndex is read without rewriting its immutable pointer");
}finally{empty.storage.client.destroy();storageCache.clearStorageReadCache();}

// Measure real cold HTTP request boundaries, including causal validation and the fresh acknowledgement.
for(const count of [1,12]) {
  const fixture=memoryStorage(),commands=[],send=fixture.storage.client.send.bind(fixture.storage.client);
  fixture.storage.client.send=async command=>{commands.push({name:command.constructor.name,key:command.input.Key || command.input.Prefix});return send(command);};
  const perform=async work=>{const storage=new B2Storage({...fixture.storage.settings});storage.client.send=fixture.storage.client.send;try{return await work(new EntityStorage(storage));}finally{storage.client.destroy();}};
  try {
    const idea={id:"i",sectionId:"s",name:"Idea",description:"",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:Array.from({length:count},(_,n)=>({id:`b${n}`,heading:"Heading",text:`Text ${n}`}))};
    const library={version:1,sections:[{id:"s",name:"Section",description:"",icon:"folder"}],projects:[idea]};
    await perform(entities=>entities.save({operationId:randomUUID(),heads:[],changes:Object.entries(schema.flattenLibrary(library)).map(([key,value])=>({key,value,base:[]}))}));
    const base=await perform(entities=>entities.readScoped({kind:"idea",id:"i"}));
    const values=schema.flattenLibrary({...library,projects:[{...idea,updatedAt:"2026-01-02T00:00:00Z",blocks:idea.blocks.map((block,n)=>n===0?{...block,text:"Changed"}:block)}]});
    const changes=Object.entries(values).filter(([key,value])=>!schema.equal(value,base.records.find(record=>record.key===key)?.value)).map(([key,value])=>({key,value,base:base.index[key] || []}));
    storageCache.clearStorageReadCache();commands.length=0;
    const saved=await perform(entities=>entities.saveScoped({operationId:randomUUID(),heads:base.heads,changes,readBack:{target:base.target}}));
    const gets=commands.filter(c=>c.name==="GetObjectCommand").length;
    assert.equal(gets,count+7,`A cold ${count}-block save has a fixed checked-write budget, not repeated record reads`);
    for(const change of changes) {
      const suffix=`/records/${createHash("sha256").update(change.key).digest("hex")}/${saved.revision}.json`;
      assert.equal(commands.filter(c=>c.name==="GetObjectCommand" && c.key.endsWith(suffix)).length,1,"Keep the pre-write existence check and eliminate the post-write download");
    }
    assert.equal(saved.read.records.find(record=>record.key===schema.entityKey("block","i","b0")).value.text,"Changed");
    console.log(`Cold save budget (${count} blocks, text + date changed): ${gets} GET + ${commands.filter(c=>c.name==="HeadObjectCommand").length} HEAD; no re-download after writing.`);
  }finally{fixture.storage.client.destroy();storageCache.clearStorageReadCache();}
}
