// Real SQLite/filesystem tests, always in an isolated .cache directory; no browser or cloud data.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const workspace=fileURLToPath(new URL("../",import.meta.url)),cache=path.join(workspace,".cache");
await mkdir(cache,{recursive:true});
const fixture=await mkdtemp(path.join(cache,"disk-storage-check-")),modules=path.join(fixture,"modules"),stores=[];
await mkdir(modules);
const require=createRequire(import.meta.url),Database=require("better-sqlite3");
let checks=0;
const checked=message=>{checks++;console.log(`Disk storage: ${message}`);};
const local=directory=>({IDEA_BANK_AUTH_MODE:"local",IDEA_BANK_DATA_DIR:directory});
const section={id:"notes",name:"Заметки",description:"Personal notes",icon:"book"};
const idea=(id="first",extra={})=>({id,sectionId:section.id,name:"Идея",description:"Описание 100%_ready",cover:"forest",updatedAt:"2026-11-08T10:00:00.000Z",blocks:[{id:"text",heading:"Heading",text:"Body",headingFontSize:24,width:"half",textPosition:"below"}],...extra});
const bytes=Buffer.from("synthetic image bytes");
const asset=(id="image")=>({id,name:"picture.png",kind:"image",mime:"image/png",size:bytes.length,displaySize:{width:195,height:320}});
const withMedia=(id="first",file=asset())=>idea(id,{blocks:[{...idea().blocks[0],media:[file]}]});
const input=(id="image",data=bytes)=>({id,size:bytes.length,mime:"image/png",data});
const code=expected=>error=>error.code===expected;
let DiskLibraryStore,readDiskSettings;
async function open(directory){const store=await DiskLibraryStore.open(local(directory));stores.push(store);return store;}
function close(store){store.close();stores.splice(stores.indexOf(store),1);}
function child(script,...args){return childIn(undefined,script,...args);}
function childIn(cwd,script,...args){
  const result=spawnSync(process.execPath,["--input-type=commonjs","-e",script,...args],{cwd,encoding:"utf8",timeout:30000,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP}});
  if(result.error)throw result.error;return result;
}

try{
  for(const name of ["example-media","rich-text","ideas","cloud-library","entity-sync","disk-settings","disk-media","disk-library"]){
    const source=await readFile(path.join(workspace,"lib",`${name}.ts`),"utf8");
    await writeFile(path.join(modules,`${name}.js`),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
  }
  ({DiskLibraryStore}=require(path.join(modules,"disk-library.js")));
  ({readDiskSettings}=require(path.join(modules,"disk-settings.js")));
  assert.deepEqual((await readdir(fixture)).sort(),["modules"]);
  assert.equal(readDiskSettings({},fixture).root,path.join(fixture,"data"));
  assert.equal(readDiskSettings({LOCALAPPDATA:path.join(fixture,"system-local"),XDG_DATA_HOME:path.join(fixture,"system-share")},fixture).root,path.join(fixture,"data"));
  assert.equal(readDiskSettings(local("./data"),fixture).root,path.join(fixture,"data"));
  assert.equal(readDiskSettings(local("  ./my notes  "),fixture).root,path.join(fixture,"my notes"));
  assert.equal(readDiskSettings(local("   "),fixture).root,path.join(fixture,"data"));
  assert.equal(readDiskSettings(local(path.join(fixture,"absolute")),path.join(fixture,"app")).root,path.join(fixture,"absolute"));
  assert.deepEqual((await readdir(fixture)).sort(),["modules"]);
  const forbidden=path.join(fixture,"forbidden");
  await assert.rejects(DiskLibraryStore.open({...local(forbidden),IDEA_BANK_AUTH_MODE:"github"}));
  await assert.rejects(DiskLibraryStore.open({...local(forbidden),VERCEL:"1"}));
  await assert.rejects(readdir(forbidden),code("ENOENT"));
  checked("app-local default, relative/absolute overrides, cloud guards and side-effect-free settings");

  const portable=path.join(fixture,"Portable app"),relocated=path.join(fixture,"Moved app");await mkdir(portable);
  const portableWrite=childIn(portable,`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({});await db.commit({sections:[JSON.parse(process.argv[2])],ideas:[JSON.parse(process.argv[3])]},0,[{id:'image',size:Number(process.argv[4]),mime:'image/png',data:Buffer.from(process.argv[5],'base64')}]);db.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`,path.join(modules,"disk-library.js"),JSON.stringify(section),JSON.stringify(withMedia()),String(bytes.length),bytes.toString("base64"));
  assert.equal(portableWrite.status,0,portableWrite.stderr);
  assert.equal((await readFile(path.join(portable,"data","library.sqlite"))).subarray(0,16).toString(),"SQLite format 3\0");
  for(const target of [portable,relocated]){
    const relative=path.relative(fixture,path.resolve(target));
    if(!relative || relative.startsWith("..") || path.isAbsolute(relative))throw new Error("Unsafe test relocation path");
  }
  await rename(portable,relocated);
  const portableRead=childIn(relocated,`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({});console.log(JSON.stringify({root:db.settings.root,idea:db.readIdea('first').idea,file:require('node:fs').readFileSync(db.readMedia('image').path).toString('base64')}));db.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`,path.join(modules,"disk-library.js"));
  assert.equal(portableRead.status,0,portableRead.stderr);
  assert.deepEqual(JSON.parse(portableRead.stdout),{root:path.join(relocated,"data"),idea:withMedia(),file:bytes.toString("base64")});
  checked("default data folder follows a relocated application, retaining ideas and attachments");

  const directory=path.join(fixture,"library");let store=await open(directory);
  assert.deepEqual(store.readState(),{revision:0,initialized:false});
  assert.deepEqual(store.readSnapshot().library,{version:1,sections:[],projects:[]});
  assert.equal(await store.commit({},0),1);close(store);store=await open(directory);
  assert.deepEqual(store.readState(),{revision:1,initialized:true});
  assert.equal(store.readPage().total,0);
  checked("empty library remains empty after restart, without implicit Example creation");

  const first=withMedia(),rich=structuredClone(first);
  rich.blocks[0].richText={type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Body",marks:[{type:"bold"}]}]}]};
  assert.equal(await store.commit({sections:[section,{...section,id:"empty",name:"Empty"}],ideas:[rich,idea("newer",{updatedAt:"2026-11-08T12:00:00+01:00"})]},1,[input()]),2);
  assert.deepEqual(store.readIdea("first"),{idea:rich,revision:2});
  assert.deepEqual(await readFile(store.readMedia("image").path),bytes);
  const page=store.readPage({limit:1});assert.equal(page.ideas[0].id,"newer");assert.equal(page.nextOffset,1);
  assert.equal(Object.hasOwn(page.ideas[0],"blocks"),false);assert.deepEqual(page.counts,{empty:0,notes:2});
  assert.equal(store.readPage({limit:1,offset:1}).ideas[0].id,"first");assert.equal(store.readPage({offset:2}).nextOffset,null);
  assert.equal(store.readPage({sectionId:"empty"}).total,0);
  assert.equal(store.readPage({query:"ИДЕЯ"}).total,2);assert.equal(store.readPage({query:"описание"}).total,2);
  assert.equal(store.readPage({query:"100%_ready"}).total,2);assert.equal(store.readPage({query:"100%Z"}).total,0);
  assert.throws(()=>store.readPage({limit:101}));assert.throws(()=>store.readPage({offset:-1}));
  assert.equal(await store.commit({sections:[section],ideas:[rich]},2),2);
  checked("metadata-only pages, Unicode/literal search, ordering, counts, formatting and unchanged writes");

  const metadata=store.readPage().ideas;
  close(store);store=await open(directory);assert.deepEqual(store.readIdea("first").idea,rich);assert.deepEqual(store.readPage().ideas,metadata);
  const workerModule=path.join(modules,"disk-library.js");
  const workerRead=child(`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({IDEA_BANK_DATA_DIR:process.argv[2]});console.log(JSON.stringify(db.readSnapshot()));db.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`,workerModule,directory);
  assert.equal(workerRead.status,0,workerRead.stderr);assert.deepEqual(JSON.parse(workerRead.stdout),store.readSnapshot());
  checked("full roundtrip across connection and process restarts");

  const other=await open(directory),edited={...rich,name:"Edited locally"};
  assert.equal(await store.commit({ideas:[edited]},2),3);
  await assert.rejects(other.commit({ideas:[{...rich,name:"Stale"}]},2),code("STALE_WRITE"));
  assert.equal(other.readIdea("first").idea.name,"Edited locally");assert.equal(other.readIdea("newer").revision,2);
  assert.equal(other.readIdeaSnapshot("newer").libraryRevision,3);
  const workerWrite=child(`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({IDEA_BANK_DATA_DIR:process.argv[2]});const p=db.readIdea('newer').idea;p.name='Other process';await db.commit({ideas:[p]},db.readState().revision);db.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`,workerModule,directory);
  assert.equal(workerWrite.status,0,workerWrite.stderr);assert.equal(store.readState().revision,4);
  await assert.rejects(store.commit({ideas:[rich]},3),code("STALE_WRITE"));close(other);
  checked("independent writers reject stale saves and preserve unrelated ideas");

  const duplicate=withMedia("duplicate",asset("../outside/unsafe-name"));
  await store.commit({ideas:[duplicate]},4,[input("../outside/unsafe-name",new Blob([bytes]))]);
  assert.equal(store.readMedia("image").path,store.readMedia("../outside/unsafe-name").path);
  assert.equal(path.dirname(store.readMedia("image").path),path.join(directory,"media"));
  assert.throws(()=>store.media.filePath("../escape"));
  await assert.rejects(store.commit({ideas:[edited]},5,[input("image",Buffer.alloc(bytes.length,9))]),code("MEDIA_CHANGED"));
  assert.deepEqual(await readFile(store.readMedia("image").path),bytes);assert.equal(store.readState().revision,5);
  checked("content deduplication, unsafe names and immutable media IDs");

  const bad=withMedia("bad",asset("missing"));
  await assert.rejects(store.commit({ideas:[bad]},5),code("MISSING_MEDIA"));
  for(const data of [bytes.subarray(1),Buffer.concat([bytes,Buffer.from("extra")]),(async function*(){yield bytes.subarray(0,2);throw new Error("fixture interrupted stream");})()]){
    await assert.rejects(store.commit({ideas:[bad]},5,[input("missing",data)]));
    assert.equal(store.readIdea("bad"),undefined);assert.equal(store.readState().revision,5);
  }
  assert.deepEqual(await readdir(path.join(directory,"temporary")),[]);
  checked("missing, truncated, oversized and interrupted uploads never publish partial changes");

  let release,started;
  const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve);
  const competing=await open(directory),pending=store.commit({ideas:[bad]},5,[input("missing",(async function*(){yield bytes.subarray(0,2);started();await gate;yield bytes.subarray(2);})())]);
  await began;await competing.commit({sections:[{...section,description:"Changed during upload"}]},5);release();
  await assert.rejects(pending,code("STALE_WRITE"));assert.equal(store.readMedia("missing"),undefined);assert.equal(store.readState().revision,6);close(competing);
  checked("final revision guard catches writes made while an attachment was streaming");

  const draftIdea=withMedia("first",asset("draft-file")),draft=await store.saveDraft(edited,draftIdea,null,[input("draft-file")]);
  assert.equal(store.readState().revision,6);assert.deepEqual(store.readDraft("first"),draft);
  assert.deepEqual(await store.saveDraft(edited,draftIdea,draft.revision),draft);
  await assert.rejects(store.saveDraft(edited,draftIdea,null),code("STALE_WRITE"));
  close(store);store=await open(directory);assert.deepEqual(store.readDraft("first"),draft);
  assert.throws(()=>store.removeDraft("first","stale"),code("STALE_WRITE"));store.removeDraft("first",draft.revision);
  const recreated=await store.saveDraft(edited,draftIdea,store.readDraftContext("first").head);assert.notEqual(recreated.revision,draft.revision);
  assert.throws(()=>store.removeDraft("first",draft.revision),code("STALE_WRITE"));store.removeDraft("first",recreated.revision);
  const oldContext=store.readDraftContext("first");await store.commit({deleteIdeas:["first"]},6);assert.equal(store.readDraft("first"),undefined);
  await assert.rejects(store.saveDraft(edited,draftIdea,oldContext.head,[],{instance:oldContext.instance,next:crypto.randomUUID()}),code("STALE_WRITE"));
  checked("draft persistence, independent revisions, protected attachments and stale delete guards");

  // A SQL trigger exits a real child process after the immutable file was published, mid-transaction.
  const crashBytes=Buffer.from("a new attachment published just before the process exits"),beforeCrash=store.readSnapshot(),crashIdea=withMedia("crash-idea",{...asset("crash-file"),size:crashBytes.length});close(store);
  const crash=child(`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({IDEA_BANK_DATA_DIR:process.argv[2]});db.db.function('fixture_crash',()=>process.exit(23));db.db.exec("CREATE TRIGGER fixture_crash BEFORE INSERT ON ideas WHEN NEW.id='crash-idea' BEGIN SELECT fixture_crash(); END;");const data=Buffer.from(process.argv[4],'base64');await db.commit({ideas:[JSON.parse(process.argv[3])]},db.readState().revision,[{id:'crash-file',size:data.length,mime:'image/png',data}]);})().catch(e=>{console.error(e.message);process.exitCode=1;});`,workerModule,directory,JSON.stringify(crashIdea),crashBytes.toString("base64"));
  assert.equal(crash.status,23,crash.stderr);store=await open(directory);
  assert.deepEqual(store.readSnapshot(),beforeCrash);assert.equal(store.readMedia("crash-file"),undefined);
  assert.deepEqual(await readFile(store.media.filePath(createHash("sha256").update(crashBytes).digest("hex"))),crashBytes);
  store.collectGarbage();await assert.rejects(readFile(store.media.filePath(createHash("sha256").update(crashBytes).digest("hex"))),code("ENOENT"));
  store.db.exec("DROP TRIGGER fixture_crash");
  await store.commit({ideas:[crashIdea]},beforeCrash.revision,[{id:"crash-file",mime:"image/png",size:crashBytes.length,data:crashBytes}]);assert.deepEqual(store.readIdea("crash-idea").idea,crashIdea);
  checked("abrupt process exit rolls back SQL and retains the previous library; retry succeeds");

  const beforeStreamExit=store.readSnapshot();close(store);
  const streamExit=child(`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({IDEA_BANK_DATA_DIR:process.argv[2]});await db.media.prepare({id:'partial',size:100,mime:'image/png',data:(async function*(){yield Buffer.from('partial');process.exit(24);})()});})().catch(e=>{console.error(e.message);process.exitCode=1;});`,workerModule,directory);
  assert.equal(streamExit.status,24,streamExit.stderr);store=await open(directory);
  assert.deepEqual(store.readSnapshot(),beforeStreamExit);assert.equal(store.readMedia("partial"),undefined);
  assert.equal((await readdir(path.join(directory,"temporary"))).length,1);
  store.collectGarbage();assert.deepEqual(await readdir(path.join(directory,"temporary")),[]);
  checked("process exit during streaming leaves only an unreferenced temporary file");

  const now=store.readState().revision,moved={...store.readIdea("duplicate").idea,sectionId:"empty"};
  await store.commit({ideas:[moved],deleteSections:["notes"]},now);
  assert.equal(store.readIdea("newer"),undefined);assert.equal(store.readIdea("crash-idea"),undefined);assert.deepEqual(store.readIdea("duplicate").idea,moved);
  assert.deepEqual(store.readPage().counts,{empty:1});assert.equal(store.db.prepare("SELECT count(*) AS n FROM blocks WHERE idea_id='newer'").get().n,0);
  await store.commit({deleteSections:["empty"]},now+1);assert.equal(store.readPage().total,0);assert.deepEqual(store.readSections(),[]);
  checked("atomic moves, section deletion and cascading block/reference cleanup");

  const gcDirectory=path.join(fixture,"gc"),gc=await open(gcDirectory),peer=await open(gcDirectory);
  const picture=Buffer.from("original bytes"),draftBytes=Buffer.from("new draft attachment bytes");
  const photo={...asset("photo"),size:picture.length},draftPhoto={...asset("draft-photo"),size:draftBytes.length};
  const originalIdea=withMedia("gc",photo),secondIdea=withMedia("shared",photo);
  await gc.commit({sections:[section],ideas:[originalIdea,secondIdea]},0,[{id:photo.id,size:picture.length,mime:photo.mime,data:picture}]);
  const changedIdea=withMedia("gc",draftPhoto),context=gc.readDraftContext("gc"),next=crypto.randomUUID();
  const gcDraft=await gc.saveDraft(originalIdea,changedIdea,null,[{id:draftPhoto.id,size:draftBytes.length,mime:draftPhoto.mime,data:draftBytes}],{instance:context.instance,next});
  assert.deepEqual(await gc.saveDraft(originalIdea,changedIdea,null,[],{instance:context.instance,next}),gcDraft,"A lost draft response replays the same revision");
  const originalPath=gc.readMedia(photo.id).path,draftPath=gc.readMedia(draftPhoto.id).path;
  gc.collectGarbage();assert.deepEqual(await readFile(draftPath),draftBytes);
  gc.removeDraft("gc",gcDraft.revision);gc.collectGarbage();await assert.rejects(readFile(draftPath),code("ENOENT"));assert.deepEqual(await readFile(originalPath),picture);
  await assert.rejects(gc.saveDraft(originalIdea,changedIdea,null,[],{instance:context.instance,next:crypto.randomUUID()}),code("STALE_WRITE"),"A cancelled initial draft cannot reappear");
  const unpublished=Buffer.from("published before metadata"),pendingPhoto={...asset("pending-photo"),size:unpublished.length};
  const prepare=gc.media.prepare.bind(gc.media);gc.media.prepare=async(...args)=>{const prepared=await prepare(...args);peer.collectGarbage();assert.deepEqual(await readFile(gc.media.filePath(prepared.sha256)),unpublished);return prepared;};
  await gc.commit({ideas:[withMedia("published",pendingPhoto)]},1,[{id:pendingPhoto.id,size:unpublished.length,mime:pendingPhoto.mime,data:unpublished}]);gc.media.prepare=prepare;
  const snapshotProcess=child(`(async()=>{const {DiskLibraryStore}=require(process.argv[1]);const db=await DiskLibraryStore.open({IDEA_BANK_DATA_DIR:process.argv[2]});console.log(JSON.stringify({token:db.beginBackup().token}));db.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`,workerModule,gcDirectory);
  assert.equal(snapshotProcess.status,0,snapshotProcess.stderr);
  const backup=JSON.parse(snapshotProcess.stdout),beforeReset=gc.readSnapshot(),instanceBefore=gc.readDraftContext("gc").instance;
  const resetOp={id:crypto.randomUUID(),fingerprint:"a".repeat(64)};
  gc.db.exec("CREATE TRIGGER reject_reset BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'fixture reset failure');END");
  assert.throws(()=>gc.clear(beforeReset.revision,resetOp));assert.deepEqual(gc.readSnapshot(),beforeReset);gc.db.exec("DROP TRIGGER reject_reset");
  assert.equal(gc.clear(beforeReset.revision,resetOp),beforeReset.revision+1);assert.equal(gc.clear(beforeReset.revision,resetOp),beforeReset.revision+1);
  gc.collectGarbage();assert.deepEqual(await readFile(originalPath),picture,"An active ZIP snapshot survives a reset");assert.ok(gc.readMedia(photo.id));
  gc.releaseBackup(backup.token);gc.collectGarbage();await assert.rejects(readFile(originalPath),code("ENOENT"));assert.deepEqual(gc.readSnapshot().library,{version:1,sections:[],projects:[]});
  await gc.commit({sections:[section],ideas:[idea("gc")]},gc.readState().revision);
  await assert.rejects(gc.saveDraft(originalIdea,changedIdea,null,[],{instance:instanceBefore,next:crypto.randomUUID()}),code("STALE_WRITE"),"Old editor sessions cannot write into a recreated idea");
  await writeFile(path.join(gc.settings.media,"unowned.txt"),"keep");gc.collectGarbage();assert.equal(await readFile(path.join(gc.settings.media,"unowned.txt"),"utf8"),"keep");
  close(gc);close(peer);checked("safe GC, shared references, draft tombstones, in-flight publication, pinned ZIP, reset rollback and old editor fencing");

  const schemaDirectory=path.join(fixture,"schema-upgrade"),schemaStore=await open(schemaDirectory);
  await schemaStore.commit({sections:[section],ideas:[idea()]},0);
  schemaStore.db.exec("DROP TABLE operations;DROP TABLE draft_heads;DROP TABLE media_leases;ALTER TABLE ideas DROP COLUMN incarnation;PRAGMA user_version=1");close(schemaStore);
  const upgraded=await open(schemaDirectory);assert.equal(upgraded.db.pragma("user_version",{simple:true}),3);assert.deepEqual(upgraded.readIdea("first").idea,idea());close(upgraded);
  checked("schema 1 upgrades to durable operation receipts without changing the library");

  const foreignDir=path.join(fixture,"foreign");await mkdir(foreignDir);const foreignFile=path.join(foreignDir,"library.sqlite"),foreignDb=new Database(foreignFile);
  foreignDb.exec("CREATE TABLE other_app (text TEXT); INSERT INTO other_app VALUES ('keep');");foreignDb.close();
  const original=await readFile(foreignFile);await assert.rejects(open(foreignDir),code("INVALID_DATABASE"));assert.deepEqual(await readFile(foreignFile),original);
  const futureDir=path.join(fixture,"future"),future=await open(futureDir);future.db.pragma("user_version=999");close(future);
  await assert.rejects(open(futureDir),code("INVALID_DATABASE"));
  const corruptDir=path.join(fixture,"corrupt");await mkdir(corruptDir);await writeFile(path.join(corruptDir,"library.sqlite"),"not a database");
  await assert.rejects(open(corruptDir));assert.equal(await readFile(path.join(corruptDir,"library.sqlite"),"utf8"),"not a database");
  checked("foreign, future and corrupt databases are rejected without replacement");

  const linkDir=path.join(fixture,"linked"),targetDir=path.join(fixture,"link-target");await mkdir(targetDir);
  try{
    await symlink(targetDir,linkDir,process.platform==="win32"?"junction":"dir");
    await assert.rejects(open(linkDir));checked("symlink/junction storage directory rejected");
  }catch(error){if(!["EPERM","EACCES","ENOTSUP"].includes(error.code))throw error;console.log("Disk storage: symlink creation unavailable on this host; check skipped.");}
  console.log(`Disk storage checks passed (${checks} groups). All data was synthetic and outside user storage.`);
}finally{
  for(const store of stores)store.close();
  const relative=path.relative(cache,path.resolve(fixture));
  if(!relative || relative.startsWith("..") || path.isAbsolute(relative))throw new Error("Unsafe test cleanup path");
  await rm(fixture,{recursive:true,force:true});
}
