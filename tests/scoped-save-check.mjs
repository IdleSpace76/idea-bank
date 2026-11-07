import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {memoryStorage,schema,storageCache} from "./entity-fixture.mjs";
const f=memoryStorage(),{entityKey,flattenLibrary}=schema;
const library={version:1,sections:[{id:"s",name:"Section",description:"",icon:"folder"}],projects:[{id:"i",sectionId:"s",name:"Idea",description:"",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"a",heading:"A",text:"Before A"},{id:"b",heading:"B",text:"Before B"}]}]};
try {
  await f.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(library)).map(([key,value])=>({key,value,base:[]}))});
  const base=await f.entities().readScoped({kind:"idea",id:"i"}),ka=entityKey("block","i","a"),kb=entityKey("block","i","b");
  const body={operationId:randomUUID(),heads:base.heads,changes:[{key:ka,base:base.index[ka],value:{...library.projects[0].blocks[0],text:"Saved A"}}],readBack:{target:base.target,includeIdeas:["i"]}};
  const count=f.objects.size;
  for(const readBack of [null,{}, {target:base.target,includeIdeas:null},{target:{kind:"invalid",id:"i"}}])await assert.rejects(()=>f.entities().saveScoped({...body,readBack}),error=>error.code==="INVALID_DATA");
  assert.equal(f.objects.size,count,"Read-back parameters are validated before any write");
  const send=f.storage.client.send.bind(f.storage.client);let inject=true;
  f.storage.client.send=async command=>{
    const result=await send(command);
    if(inject && command.constructor.name==="PutObjectCommand" && command.input.Key.includes("/catalog-v1/tips/")) {
      inject=false;
      await f.entities().save({operationId:randomUUID(),heads:base.heads,changes:[{key:kb,base:base.index[kb],value:{...library.projects[0].blocks[1],text:"Concurrent B"}}]});
    }
    return result;
  };
  const saved=await f.entities().saveScoped(body);
  assert.equal(saved.read.records.find(record=>record.key===ka).value.text,"Saved A");
  assert.equal(saved.read.records.find(record=>record.key===kb).value.text,"Concurrent B");
  assert.equal(saved.read.heads.length,2,"The PUT response includes concurrent post-commit branches");
  const retry=await f.entities().saveScoped(body);assert.equal(retry.revision,saved.revision);assert.deepEqual(retry.read,saved.read);
  const another=await f.entities().saveScoped({operationId:randomUUID(),heads:saved.read.heads,changes:[{key:ka,base:saved.read.index[ka],value:{...library.projects[0].blocks[0],text:"Old client"}}]});
  assert.deepEqual(Object.keys(another),["revision"],"Older clients retain their revision-only protocol");
  console.log("Scoped save checks passed: combined acknowledgement, concurrent branches, lost-response retry, old clients and validation before commit.");
}finally{f.storage.client.destroy();storageCache.clearStorageReadCache();}
