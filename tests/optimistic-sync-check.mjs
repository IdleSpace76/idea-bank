import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import vm from "node:vm";
import {createRequire} from "node:module";
import ts from "typescript";
import {memoryStorage,schema,client} from "./entity-fixture.mjs";
const f=memoryStorage(),{entityKey,flattenLibrary,assembleLibrary}=schema;
const {summarizeIdea}=createRequire(import.meta.url)("../.cache/entity-check/ideas.js"),cache=new Map();
const fileFor=text=>{const bytes=Buffer.from(text),sha256=createHash("sha256").update(bytes).digest("hex"),md5=createHash("md5").update(bytes).digest("hex");const file={id:`${sha256}-${md5}`,sha256,md5,size:bytes.length,mime:"image/png"};f.objects.set(`${f.storage.prefix}/media/${file.id}`,{body:bytes,type:file.mime,metadata:{sha256},md5});return file;};
const file=fileFor("existing immutable media"),asset={id:file.id,name:"image.png",kind:"image",mime:file.mime,size:file.size};
const library={version:1,sections:[{id:"s",name:"Section",description:"",icon:"folder"}],projects:[{id:"i",sectionId:"s",name:"Idea",description:"",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"b",heading:"Heading",text:"Before",media:[asset]}]}]};
const target={kind:"idea",id:"i"},key=entityKey("block","i","b"),calls=[],operations=[];
let pending,settled,hashes=0,lose=false,sources=[file];
async function api(path,init) {
  const body=JSON.parse(init.body);calls.push({path,method:init.method,body});
  try {
    if(path==="/api/storage/media/upload")return Response.json(await f.storage.createUpload(body));
    assert.equal(path,"/api/sync/scoped");
    if(init.method==="PUT") {const result=await f.entities().saveScoped(body);if(lose){lose=false;throw new TypeError("Lost response");}return Response.json(result);}
    return Response.json(await f.entities().readScoped(body.target,body.includeIdeas,body.includeMedia));
  }catch(error){if(error instanceof TypeError)throw error;return Response.json({error:{code:error.code,message:error.message}},{status:error.status || 502});}
}
const modules={
  "./entity-sync":schema,"./entity-client":{...client,localMedia:async()=>{hashes++;return sources;}},
  "./cloud-library":{revisionPattern:/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,libraryAssets:library=>new Map(library.projects.flatMap(idea=>[...(idea.coverImage?[idea.coverImage]:[]),...idea.blocks.flatMap(block=>block.media || [])]).map(asset=>[asset.id,asset])),parseCloudMedia:value=>value},
  "./reader-cache":{readReaderCache:async(_scope,_kind,id)=>cache.get(id),writeReaderCache:async(_scope,_kind,id,value)=>cache.set(id,value)},"./scoped-types":{editCacheId:target=>`edit:${target.kind}:${target.id}`},"./ideas":{summarizeIdea},
  "./scoped-store":{readScopedEntry:async()=>pending,persistScopedOperation:async(entry,operation)=>{assert.equal(entry.sequence,pending.sequence);pending={...entry,operation};operations.push(operation);return true;},clearScopedOperation:async()=>{delete pending.operation;},settleScoped:async(_entry,read,values,document)=>{settled={read,values,document};pending=null;},rebaseScoped:async(entry,read,values)=>({...entry,base:read,local:values})},
  "./cloud-access":{cloudFetch:api,CloudAccessError:class extends Error{}},
};
const exports={},navigator={onLine:true};vm.runInNewContext(ts.transpileModule(await readFile("lib/scoped-client.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{assert.ok(Object.hasOwn(modules,name),name);return modules[name];},crypto,structuredClone,TextEncoder,Date,AbortSignal,navigator});
const baseFor=async()=>{const read=await f.entities().readScoped(target);return {...read,index:Object.fromEntries(Object.entries(read.index).filter(([key])=>schema.keyParts(key).kind!=="media")),records:read.records.filter(record=>schema.keyParts(record.key).kind!=="media")};};
function queue(base,text,media=asset) {const local=flattenLibrary(assembleLibrary(schema.validateRead(base,{},{}).remote));local[key]={...local[key],text,media:[media]};pending={scope:"fixture",target,base,local,sequence:1};calls.length=0;settled=null;return pending;}
const originalFetch=globalThis.fetch;
globalThis.fetch=api;
try {
  await f.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(library,[file])).map(([key,value])=>({key,value,base:[]}))});
  let base=await baseFor();
  await exports.flushScoped(queue(base,"Changed without cached bytes"));
  assert.deepEqual(calls.map(call=>call.method),["PUT"]);assert.equal(hashes,0,"Canonical media dependencies need no original blob or hash computation");
  assert.equal(settled.document.idea.blocks[0].media[0].id,file.id);assert.ok(settled.values[entityKey("media",file.id)]);
  base=await baseFor();lose=true;await assert.rejects(()=>exports.flushScoped(queue(base,"Retry unchanged operation")),error=>error.code==="NETWORK");
  const operationId=pending.operation.body.operationId;assert.equal(pending.operation.optimistic,true);
  await exports.flushScoped(pending);assert.equal(calls.at(-1).body.operationId,operationId);assert.equal(settled.document.idea.blocks[0].text,"Retry unchanged operation");
  base=await baseFor();
  await f.entities().save({operationId:randomUUID(),heads:base.heads,changes:[{key,base:base.index[key],value:{...library.projects[0].blocks[0],text:"Remote version"}}]});
  const conflict=await exports.flushScoped(queue(base,"Local version"));
  assert.ok(conflict.plan?.conflicts.length);assert.deepEqual(calls.map(call=>call.method),["PUT","POST"]);
  assert.equal((await f.entities().catalog().readIdea("i")).idea.blocks[0].text,"Remote version","A stale optimistic write never overwrites the cloud");
  const added=fileFor("new media upload"),newAsset={...asset,id:"new-local-file",size:added.size};sources=[{...added,id:newAsset.id}];
  await exports.flushScoped(queue(await baseFor(),"New media",newAsset));
  assert.equal(calls[0].method,"POST");assert.ok(calls.some(call=>call.path==="/api/storage/media/upload"));
  assert.deepEqual(calls.map(call=>call.method),["POST","POST","PUT"],"New media uses one domain read, one upload ticket and one write");
  assert.deepEqual(calls[0].body.includeMedia,[added.id],"Hash locally before the only preliminary read");
  assert.ok(!operations.at(-1).optimistic);assert.equal(settled.document.idea.blocks[0].media[0].id,added.id);
  const current=await baseFor(),visible=summarizeIdea(assembleLibrary(schema.validateRead(current,{},{}).remote).projects[0]);
  cache.set("i",{editBase:current});calls.length=0;
  assert.equal((await exports.prepareTarget("fixture",target,visible)).library.projects[0].name,"Idea");assert.equal(calls.length,0,"Metadata forms reuse a cached full body matching their visible card");
  await exports.prepareTarget("fixture",target,{...visible,name:"Different visible card"});assert.equal(calls.length,1,"A mismatched card cannot silently open an older cached edit base");
  navigator.onLine=false;await assert.rejects(()=>exports.prepareTarget("fixture",target,{...visible,name:"Different visible card"}),error=>error.code==="OFFLINE");navigator.onLine=true;
  calls.length=0;await exports.prepareTarget("fixture",target);assert.equal(calls.length,1,"An explicit conflict review bypasses cached form preparation");
  const sectionTarget={kind:"section",id:"s"},sectionBase=await f.entities().readScoped(sectionTarget);
  cache.set("edit:section:s",sectionBase);calls.length=0;
  const prepared=await exports.prepareTarget("fixture",sectionTarget,library.sections[0]);assert.equal(calls.length,0,"A known section edit base needs no repeated read");
  pending={...prepared.entry,sequence:2,local:{...prepared.entry.local,[entityKey("section","s")]:{...library.sections[0],description:"Changed section"}}};
  await exports.flushScoped(pending);assert.deepEqual(calls.map(call=>call.method),["PUT"],"A section update uses the same checked one-PUT path");
  // A whole-library reset is one resumable scoped operation, never a compatibility sync.
  const resetTarget={kind:"library",id:"all"},resetBase=await f.entities().readScoped(resetTarget);
  const resetLocal=Object.fromEntries(Object.entries(schema.validateRead(resetBase,{},{}).remote).map(([key,value])=>[key,schema.keyParts(key).kind==="media"?value:null]));
  pending={scope:"fixture",target:resetTarget,base:resetBase,local:resetLocal,sequence:3};calls.length=0;lose=true;
  await assert.rejects(()=>exports.flushScoped(pending),error=>error.code==="NETWORK");
  const resetOperation=pending.operation.body.operationId;
  await exports.flushScoped(pending);
  assert.deepEqual(calls.map(call=>call.method),["PUT","PUT"],"Lost reset responses retry the identical operation without another read");
  assert.equal(calls.at(-1).body.operationId,resetOperation);assert.equal((await f.entities().catalog().readPage()).total,0);
  const restore=async()=>{const state=await f.entities().read();await f.entities().save({operationId:randomUUID(),heads:state.heads,changes:Object.entries(flattenLibrary(library,[file])).map(([key,value])=>({key,value,base:state.index[key] || []}))});};
  const resetEntry=async()=>{const base=await f.entities().readScoped(resetTarget);return {scope:"fixture",target:resetTarget,base,sequence:4,local:Object.fromEntries(Object.entries(schema.validateRead(base,{},{}).remote).map(([key,value])=>[key,schema.keyParts(key).kind==="media"?value:null]))};};
  await restore();pending=await resetEntry();
  const separate={version:1,sections:[{...library.sections[0],id:"new-section"}],projects:[{...library.projects[0],id:"new-idea",sectionId:"new-section",blocks:[]}]};
  await f.entities().save({operationId:randomUUID(),heads:pending.base.heads,changes:Object.entries(flattenLibrary(separate)).map(([key,value])=>({key,value,base:[]}))});
  calls.length=0;await exports.flushScoped(pending);
  assert.equal(assembleLibrary(settled.values).projects[0].id,"new-idea","A concurrent independent addition survives reset and its local acknowledgement");
  await restore();pending=await resetEntry();
  const child={...library.projects[0],id:"concurrent-child",blocks:[]};
  await f.entities().save({operationId:randomUUID(),heads:pending.base.heads,changes:Object.entries(flattenLibrary({version:1,sections:[],projects:[child]})).map(([key,value])=>({key,value,base:[]}))});
  const resetConflict=await exports.flushScoped(pending);
  assert.ok(resetConflict.plan?.conflicts.length,"A new child in a section being deleted requires explicit conflict resolution");
  assert.ok((await f.entities().catalog().readPage()).ideas.some(idea=>idea.id===child.id),"A stale reset never silently deletes a concurrent child");
  console.log("Optimistic client checks passed: cached idea/section forms, one PUT, uncached media dependencies, stable lost-response retry, stale-version conflict and normal new-media upload path.");
}finally{globalThis.fetch=originalFetch;f.storage.client.destroy();}
