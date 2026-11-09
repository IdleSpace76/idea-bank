import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,rm,stat} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID,createHash} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createIdeaMcpServer} from "../lib/mcp-server.ts";
import {CloudAgentBackend} from "../lib/mcp-cloud-backend.ts";
import {publicAddress,downloadAgentFile,loadAgentFile} from "../lib/mcp-files.ts";
import {memoryStorage} from "./entity-fixture.mjs";

const root=fileURLToPath(new URL("../",import.meta.url)),cache=path.join(root,".cache");await mkdir(cache,{recursive:true});
const directory=await mkdtemp(path.join(cache,"mcp-check-")),data=path.join(directory,"data");
const image=path.join(root,"public/examples/little-robot.png"),bytes=await readFile(image);
async function scenario(client,local=true){
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result.structuredContent || result.content));return result.structuredContent;};
  const tools=(await client.listTools()).tools;assert.equal(tools.length,9);assert.ok(tools.find(tool=>tool.name==="get_idea").annotations.readOnlyHint);
  if(!local){const input=tools.find(tool=>tool.name==="attach_media").inputSchema.properties.file;assert.deepEqual(input.required,["download_url","file_id"]);assert.ok(input.properties.mime_type && input.properties.file_name);}
  const section=(await call("create_section",{operation_id:randomUUID(),name:"Game development",description:"Worlds and mechanics",icon:"gamepad"})).section;
  const create={operation_id:randomUUID(),section_id:section.id,name:"Тихий лес",description:"Спокойная игра про исследование леса",blocks:[{heading:"Основная идея",text:"Игрок исследует лес и обустраивает дом."}]};
  const first=await call("create_idea",create),retry=await call("create_idea",create);assert.equal(retry.idea.id,first.idea.id);
  assert.equal((await call("search_ideas",{query:"лесу"})).ideas[0].id,first.idea.id);
  assert.equal((await call("search_ideas",{query:"тихий лесс"})).ideas[0].id,first.idea.id);
  const read=await call("get_idea",{idea_id:first.idea.id});assert.equal(read.idea.blocks[0].text,create.blocks[0].text);
  const edit={operation_id:randomUUID(),idea_id:read.idea.id,version:read.version,block_changes:[{action:"update",id:read.idea.blocks[0].id,text:"Лес меняется в зависимости от сезона."},{action:"add",heading:"Звук",text:"Шум ветра и птиц",width:"half"}]};
  const saved=await call("update_idea",edit),again=await call("update_idea",edit);assert.equal(saved.idea.blocks.length,2);assert.equal(again.idea.blocks.length,2);
  const stale=await client.callTool({name:"update_idea",arguments:{...edit,operation_id:randomUUID(),description:"Must not overwrite"}});assert.equal(stale.isError,true);assert.equal(stale.structuredContent.error.code,"CONFLICT");
  assert.equal((await call("get_idea",{idea_id:read.idea.id})).idea.description,create.description);
  if(local){
    const attachment={operation_id:randomUUID(),idea_id:saved.idea.id,version:saved.version,block_id:saved.idea.blocks[0].id,file:{path:image}};
    const attached=await call("attach_media",attachment),repeated=await call("attach_media",attachment);assert.equal(attached.idea.blocks[0].media.length,1);assert.equal(repeated.idea.blocks[0].media.length,1);
    const viewed=await client.callTool({name:"get_media",arguments:{idea_id:saved.idea.id,media_id:attached.idea.blocks[0].media[0].id,preview:true}});assert.deepEqual(Buffer.from(viewed.content.find(row=>row.type==="image").data,"base64"),bytes);
    const bad=await client.callTool({name:"attach_media",arguments:{...attachment,operation_id:randomUUID(),version:attached.version,file:{path:path.join(root,".env.local")}}});assert.equal(bad.isError,true);assert.equal(bad.structuredContent.error.code,"FILE_ACCESS_DENIED");
  }
  const noOp=await call("get_idea",{idea_id:first.idea.id});assert.equal(noOp.idea.blocks[0].text,"Лес меняется в зависимости от сезона.");
  return {id:first.idea.id,call};
}
let stdio,client;
try{
  // Match a desktop client launched outside the checkout; Windows ESM loaders require file URLs.
  stdio=new StdioClientTransport({command:process.execPath,args:["--import",new URL("../node_modules/tsx/dist/loader.mjs",import.meta.url).href,path.join(root,"scripts/mcp-local.mts"),"--data-dir",data,"--allow-files",path.dirname(image)],cwd:directory,stderr:"pipe",env:Object.fromEntries(Object.entries(process.env).filter(([,value])=>typeof value==="string"))});
  const diagnostics=[];stdio.stderr?.on("data",chunk=>diagnostics.push(String(chunk)));
  client=new Client({name:"idea-bank-protocol-check",version:"1.0.0"});await client.connect(stdio);
  await client.listTools();await assert.rejects(stat(data),error=>error.code==="ENOENT");
  const result=await scenario(client);await client.close();client=undefined;
  const {DiskLibraryStore}=await import("../lib/disk-library.ts");const db=await DiskLibraryStore.open({...process.env,IDEA_BANK_AUTH_MODE:"local",VERCEL:"",IDEA_BANK_DATA_DIR:data});
  try{const idea=db.readIdea(result.id).idea,stored=db.readMedia(idea.blocks[0].media[0].id);assert.deepEqual(await readFile(stored.path),bytes);assert.equal(db.readPage({limit:100}).total,1);}finally{db.close();}
  const readonly=new StdioClientTransport({command:process.execPath,args:["--import","tsx","scripts/mcp-local.mts","--data-dir",data,"--read-only"],cwd:root,stderr:"pipe",env:Object.fromEntries(Object.entries(process.env).filter(([,value])=>typeof value==="string"))});
  client=new Client({name:"readonly-check",version:"1.0.0"});await client.connect(readonly);assert.equal((await client.listTools()).tools.length,4);const denied=await client.callTool({name:"create_section",arguments:{operation_id:randomUUID(),name:"No"}});assert.equal(denied.structuredContent.error.code,"FORBIDDEN");await client.close();client=undefined;
  console.log("MCP local STDIO: real SDK initialization, lazy storage, schemas, fuzzy search, read/create/patch, original PNG bytes, repeat protection, stale-write conflict and read-only permission passed.");
  const fixture=memoryStorage(),backend=new CloudAgentBackend(fixture.storage),[serverTransport,clientTransport]=InMemoryTransport.createLinkedPair(),server=createIdeaMcpServer({backend:async()=>backend,scopes:["ideas:read","ideas:write"],keepOpen:true});
  client=new Client({name:"cloud-check",version:"1.0.0"});await server.connect(serverTransport);await client.connect(clientTransport);
  try{
    const {id,call}=await scenario(client,false),read=await call("get_idea",{idea_id:id});
    const sha256=createHash("sha256").update(bytes).digest("hex"),md5=createHash("md5").update(bytes).digest("hex"),file={id:`${sha256}-${md5}`,sha256,md5,size:bytes.length,mime:"image/png"};
    fixture.objects.set(fixture.storage.mediaKey(file),{body:bytes,type:file.mime,metadata:{sha256},md5});
    const attachOperation=randomUUID(),args=[attachOperation,id,read.version,{}, {asset:{id:file.id,name:"robot.png",kind:"image",mime:file.mime,size:bytes.length},cloud:file},{blockId:read.idea.blocks[0].id}];
    const attached=await backend.update(...args),again=await backend.update(...args);assert.equal(attached.idea.blocks[0].media.length,1);assert.equal(again.idea.blocks[0].media.length,1);
    const other=await backend.create(randomUUID(),{section_id:read.idea.sectionId,name:"Shared media",blocks:[{heading:"Same original",text:"",width:"full"}]}),shared=[randomUUID(),other.idea.id,other.version,{},args[4],{blockId:other.idea.blocks[0].id}];
    const sharedSaved=await backend.update(...shared),sharedRetry=await backend.update(...shared);assert.equal(sharedSaved.idea.blocks[0].media[0].id,file.id);assert.equal(sharedRetry.idea.blocks[0].media.length,1);
    const changed=await backend.update(randomUUID(),sharedSaved.idea.id,sharedSaved.version,{block_changes:[{action:"update",id:sharedSaved.idea.blocks[0].id,text:"Edited without losing shared media"}]});assert.equal(changed.idea.blocks[0].media[0].id,file.id);
    assert.equal((await fixture.entities().catalog().readPage()).total,2);
  }finally{await client.close();client=undefined;await server.close();backend.close();}
  for(const address of ["127.0.0.1","10.0.0.1","169.254.169.254","172.16.0.1","192.168.1.2","::1","::ffff:127.0.0.1","fd00::1","2001:db8::1"])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress("8.8.8.8"),true);await assert.rejects(downloadAgentFile("http://127.0.0.1/file.png"));await assert.rejects(downloadAgentFile("https://127.0.0.1/file.png"));
  const remote=async(_url,_redirects,info)=>{if(info)info.mime="image/png";return bytes;},native={mode:"local"};
  const fromRef=await loadAgentFile({download_url:"https://files.example/download",file_id:"file-fixture",file_name:"original.png",mime_type:"image/png"},native,randomUUID(),[],remote);assert.equal(fromRef.asset.name,"original.png");assert.deepEqual(fromRef.disk.data,bytes);
  const fromHeaders=await loadAgentFile({download_url:"https://files.example/download",file_id:"file-fixture"},native,randomUUID(),[],remote);assert.equal(fromHeaders.asset.mime,"image/png");assert.deepEqual(fromHeaders.disk.data,bytes);
  console.log("MCP cloud adapter: scoped records, idempotent edits/media, no full snapshots and SSRF address gates passed on synthetic B2.");
}catch(error){throw error;}
finally{await client?.close().catch(()=>{});await stdio?.close().catch(()=>{});const relative=path.relative(cache,directory);if(!relative||relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Unsafe fixture cleanup");await rm(directory,{recursive:true,force:true});}
