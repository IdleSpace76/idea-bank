import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {unzipSync,strFromU8,zipSync} from "fflate";
import ts from "typescript";
import {chromium,expect} from "@playwright/test";
import {encode} from "next-auth/jwt";
import {memoryStorage,schema} from "./entity-fixture.mjs";
const directory=new URL("../.cache/migration-browser/",import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL("local-fixture.mjs",directory),ts.transpileModule(await readFile(new URL("./local-fixture.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
const {exposeLibraryStore}=await import(new URL("local-fixture.mjs",directory));
const seed={version:1,sections:[{id:"s",name:"Saved section",description:"",icon:"folder"}],projects:[{id:"saved",sectionId:"s",name:"Saved idea",description:"Original",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"body",heading:"Saved heading",text:"Keep this text"}]}]};
const probe=createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://127.0.0.1:${port}`,secret="isolated-migration-fixture-secret-at-least-32-characters",endpoint="https://s3.eu-central-003.backblazeb2.com";
const scope=createHash("sha256").update(`12345:${endpoint}:fixture-bucket`).digest("hex");
const server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,IDEA_BANK_AUTH_MODE:"github",AUTH_URL:origin,AUTH_SECRET:secret,AUTH_GITHUB_ID:"fixture",AUTH_GITHUB_SECRET:"fixture",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:endpoint,B2_REGION:"eu-central-003",B2_BUCKET_NAME:"fixture-bucket",B2_KEY_ID:"fixture",B2_APPLICATION_KEY:"fixture",ABLY_API_KEY:""}});
server.stdout.resume();server.stderr.resume();let browser;const fixtures=[];
const cloud=()=>{const fixture=memoryStorage();fixtures.push(fixture);return fixture;};
const phase=(page,value)=>expect(page.locator(".local-status[data-sync-phase]")).toHaveAttribute("data-sync-phase",value,{timeout:20000});
async function state(page){return page.evaluate(async()=>{const {readMeta,readOutbox}=await import("/__local_fixture__/library-store.js");return {layout:await readMeta("layout"),marker:await readMeta("cloud-reader"),checkpoint:await readMeta("sync-v2"),pending:await readOutbox()};});}
try {
  for(let n=0;;n++){try{await fetch(origin);break;}catch{if(n>100||server.exitCode!==null)throw new Error("Migration fixture did not start");await delay(100);}}
  browser=await chromium.launch({channel:"msedge",headless:true});
  const cookie="authjs.session-token",token=await encode({secret,salt:cookie,token:{sub:"12345",name:"Migration fixture"},maxAge:1800});
  async function device(fixture,viewport,local){
    const context=await browser.newContext({viewport,isMobile:viewport.width<540,hasTouch:viewport.width<540}),calls=[],network={failFull:false,hold:null,entered:null};
    await context.addCookies([{name:cookie,value:token,url:origin,httpOnly:true,sameSite:"Lax"}]);
    await context.addInitScript(({local})=>{localStorage.setItem("idea-bank.language","ru");if(local&&!localStorage.getItem("migration-fixture-seeded")){localStorage.setItem("idea-bank.library.v1",JSON.stringify(local));localStorage.setItem("migration-fixture-seeded","yes");}},{local});
    await context.route("**/api/**",async route=>{
      const request=route.request(),url=new URL(request.url()),method=request.method();calls.push({path:url.pathname,method,body:method==="POST"||method==="PUT"?request.postDataJSON():undefined});
      const reply=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      try{
        const entities=fixture.entities();
        if(url.pathname==="/api/sync/events/token")return reply({enabled:false});
        if(url.pathname==="/api/reader/batch")return reply(await entities.readReaderBatch(request.postDataJSON()));
        if(url.pathname==="/api/catalog")return reply(await entities.catalog().readPage({limit:Number(url.searchParams.get("limit")||24),cursor:url.searchParams.get("cursor")||undefined,sectionId:url.searchParams.get("sectionId")||undefined,query:url.searchParams.get("q")||undefined}));
        if(url.pathname==="/api/catalog/media")return reply(await entities.catalog().readMedia(url.searchParams.get("id")));
        if(url.pathname.startsWith("/api/ideas/")){const result=await entities.catalog().readIdea(decodeURIComponent(url.pathname.split("/").pop()),request.headers()["if-none-match"]?.replaceAll('"',""));return result.notModified?route.fulfill({status:304,body:""}):reply(result);}
        if(url.pathname==="/api/sync/scoped"){
          const body=request.postDataJSON();
          if(method==="POST" && body.target.kind==="library"){
            if(network.failFull)return reply({error:{message:"Full download unavailable"}},503);
            if(network.hold){network.entered?.();await network.hold;network.hold=null;}
          }
          return reply(method==="POST"?await entities.readScoped(body.target,body.includeIdeas,body.includeMedia):await entities.saveScoped(body));
        }
        if(url.pathname==="/api/sync"){
          if(method==="GET")return reply(await entities.status());
          if(method==="POST"){if(network.failFull)return reply({error:{message:"Full download unavailable"}},503);const body=request.postDataJSON();if((await entities.status()).requiresMigration&&!body.activate)return reply({error:{code:"MIGRATION_REQUIRED",message:"Требуется переход на новую синхронизацию."}},409);return reply(await entities.read(body.known));}
          return reply(await entities.save(request.postDataJSON()));
        }
        if(url.pathname==="/api/storage/media/upload")return reply(await fixture.storage.createUpload(request.postDataJSON()));
        if(url.pathname==="/api/storage/library")return reply(await fixture.storage.readLibrary(url.searchParams.get("revision")||undefined));
        if(url.pathname==="/api/sync/media")return reply(await entities.download(url.searchParams.get("key"),url.searchParams.get("revision")));
        throw new Error(`Unexpected migration route ${url.pathname}`);
      }catch(error){return reply({error:{code:error.code,message:error.message}},error.status||502);}
    });
    await context.route(endpoint+"/**",async route=>{
      const request=route.request(),key=decodeURIComponent(new URL(request.url()).pathname).replace(/^\/fixture-bucket\//,""),headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,PUT,OPTIONS","Access-Control-Allow-Headers":"*"};
      if(request.method()==="OPTIONS")return route.fulfill({status:204,headers});
      if(request.method()==="PUT"){const body=request.postDataBuffer();fixture.objects.set(key,{body,type:request.headers()["content-type"],metadata:{sha256:request.headers()["x-amz-meta-sha256"]},md5:createHash("md5").update(body).digest("hex")});return route.fulfill({status:200,headers});}
      const object=fixture.objects.get(key);return route.fulfill({status:object?200:404,headers,body:object?.body||""});
    });
    const page=await context.newPage();await exposeLibraryStore(page);await page.goto(origin);return {page,context,calls,network};
  }
  const open=async page=>{await page.locator(".local-status").click();await expect(page.locator(".cloud-sync-controls")).toBeVisible();};
  const close=page=>page.getByRole("button",{name:"Понятно",exact:true}).click();
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const blank=cloud(),initial=await device(blank,viewport);await expect(initial.page.locator(".project-card > strong")).toHaveText("Example");await phase(initial.page,"synced");
    await expect.poll(async()=>(await state(initial.page)).layout).toBeUndefined();
    const initialWrites=initial.calls.filter(call=>call.method==="PUT").length;assert.equal(initialWrites,1,"An uninitialized cloud receives Example exactly once");
    await initial.page.reload();await expect(initial.page.locator(".project-card > strong")).toHaveText("Example");await phase(initial.page,"synced");assert.equal(initial.calls.filter(call=>call.method==="PUT").length,initialWrites);await initial.context.close();
    // Old cloud snapshots must wait for explicit migration, then retire their complete local replica.
    const old=cloud();await old.storage.saveLibrary({baseRevisions:[],library:seed,media:[]});
    const {page,context,calls,network}=await device(old,viewport);await phase(page,"migration");await open(page);
    assert.equal((await old.entities().status()).active,false,"No migration before owner approval");
    await page.getByRole("button",{name:"Перейти на новую синхронизацию",exact:true}).click();
    await expect(page.locator(".sync-phase")).toHaveText("Сохранено в облаке",{timeout:20000});await close(page);
    await expect(page.locator(".project-card > strong")).toHaveText("Saved idea");
    await expect.poll(async()=>(await state(page)).layout).toBeUndefined();assert.equal((await state(page)).marker.scope,scope);
    assert.ok([...old.objects.keys()].some(key=>key.includes("/revisions/")),"Original snapshots retained");
    const migratedCalls=calls.filter(call=>call.path==="/api/sync").length;await page.reload();await expect(page.locator(".project-card > strong")).toHaveText("Saved idea");
    assert.equal(calls.filter(call=>call.path==="/api/sync").length,migratedCalls,"Reload uses catalog only");
    // An unsuccessful full read cannot export the partial catalog or a newly seeded Example.
    await open(page);network.failFull=true;let unexpectedDownload=false;const downloaded=()=>{unexpectedDownload=true;};page.on("download",downloaded);
    await page.getByRole("button",{name:"Экспортировать ZIP",exact:true}).click();await expect(page.locator(".backup-controls:not(.cloud-sync-controls) .backup-error")).toBeVisible({timeout:20000});
    assert.equal(unexpectedDownload,false);page.off("download",downloaded);network.failFull=false;await close(page);
    // Export is deliberately complete even though ordinary reads no longer materialize all ideas.
    await open(page);const beforeExport=calls.length,download=page.waitForEvent("download");
    void download.catch(()=>{});
    let release,entered;network.hold=new Promise(resolve=>release=resolve);const waiting=new Promise(resolve=>entered=resolve);network.entered=entered;
    await page.getByRole("button",{name:"Экспортировать ZIP",exact:true}).click();await waiting;
    await expect(page.locator(".project-card > strong")).toHaveText("Saved idea");await expect(page.locator('main .library-loading,main .reader-state:has-text("Загружаем")')).toHaveCount(0);
    assert.equal((await state(page)).layout,undefined,"Export does not initialize a full local replica or seed Example");release();
    const zipBytes=await readFile(await (await download).path()),zip=unzipSync(zipBytes),archived=JSON.parse(strFromU8(zip["library.json"]));
    assert.deepEqual(calls.slice(beforeExport).map(call=>`${call.method} ${call.path}`),["POST /api/sync/scoped"],"Export of text-only library is a single read, without sync mode/token/catalog reloads");
    assert.equal(archived.projects[0].blocks[0].text,"Keep this text");await close(page);
    await expect.poll(async()=>(await state(page)).layout).toBeUndefined();
    // Previewing ZIP and Example also leaves the current reader mounted and makes no cloud writes.
    await open(page);
    for(const action of ["zip","example"]){
      const start=calls.length;let releasePreview,enteredPreview;
      network.hold=new Promise(resolve=>releasePreview=resolve);const prepared=new Promise(resolve=>enteredPreview=resolve);network.entered=enteredPreview;
      if(action==="zip")await page.getByLabel("Выбрать архив библиотеки",{exact:true}).setInputFiles({name:"library.zip",mimeType:"application/zip",buffer:zipBytes});
      else await page.getByRole("button",{name:"Загрузить Example",exact:true}).click();
      await prepared;await expect(page.locator(".project-card > strong")).toHaveText("Saved idea");await expect(page.locator('main .library-loading,main .reader-state:has-text("Загружаем")')).toHaveCount(0);releasePreview();
      await expect(page.locator(".backup-preview")).toBeVisible();
      assert.deepEqual(calls.slice(start).map(call=>`${call.method} ${call.path}`),["POST /api/sync/scoped"]);
      assert.equal((await state(page)).layout,undefined,"Preview never switches to a full replica");
      await page.getByRole("button",{name:action==="zip"?"Отмена импорта":"Отмена",exact:true}).click();
    }
    await close(page);
    // A metadata form opens from its visible card without fetching the idea's blocks.
    const beforeForm=calls.length;
    await page.getByRole("button",{name:"Действия с идеей Saved idea",exact:true}).first().click();await page.getByRole("menuitem",{name:"Изменить",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Изменить идею",exact:true})).toBeVisible();assert.equal(calls.length,beforeForm);
    await page.getByRole("button",{name:"Сохранить",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);assert.equal(calls.length,beforeForm,"Unchanged metadata closes without preparing or saving a cloud domain");
    await page.getByRole("button",{name:"Действия с идеей Saved idea",exact:true}).first().click();await page.getByRole("menuitem",{name:"Изменить",exact:true}).click();
    await page.getByLabel("Краткое описание",{exact:false}).fill("Edited from an uncached card");await page.getByRole("button",{name:"Сохранить",exact:true}).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);await expect.poll(async()=>(await old.entities().catalog().readIdea("saved")).idea.description).toBe("Edited from an uncached card");
    assert.equal((await old.entities().catalog().readIdea("saved")).idea.blocks[0].text,"Keep this text","Cold metadata editing preserves the idea's unloaded blocks");await phase(page,"synced");
    // Preview keeps the read checkpoint until an explicit import, even without a full local replica.
    const importLibrary=structuredClone(archived);importLibrary.projects[0].blocks[0].text="Imported copy text";
    const importJson=Buffer.from(JSON.stringify(importLibrary)),importManifest=JSON.parse(strFromU8(zip["manifest.json"]));importManifest.librarySha256=createHash("sha256").update(importJson).digest("hex");
    const changedZip=Buffer.from(zipSync({...zip,"library.json":importJson,"manifest.json":Buffer.from(JSON.stringify(importManifest))}));
    await open(page);await page.getByLabel("Выбрать архив библиотеки",{exact:true}).setInputFiles({name:"changed.zip",mimeType:"application/zip",buffer:changedZip});
    await expect(page.locator(".backup-import-conflict")).toHaveCount(1);await page.getByRole("button",{name:"Сохранить обе",exact:true}).click();
    await page.getByRole("button",{name:"Импортировать идеи",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async()=>(await old.entities().catalog().readPage()).total).toBe(2);await phase(page,"synced");
    const imported=(await old.entities().catalog().readPage()).ideas.find(idea=>idea.variants[0]?.name==="Saved idea imported");
    assert.ok(imported,"The imported copy receives its suffix in the cloud too");assert.equal((await old.entities().catalog().readIdea(imported.id)).idea.blocks[0].text,"Imported copy text");
    await expect.poll(async()=>(await state(page)).layout).toBeUndefined();
    // Reset is an explicit whole-library change; reload never resurrects the old backup.
    await open(page);const beforeReset=calls.length,resetRequests=[];
    const trackReset=request=>resetRequests.push(new URL(request.url()).pathname);page.on("request",trackReset);
    await page.getByRole("button",{name:"Очистить голову",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"Очистить голову?",exact:true})).toBeVisible();
    assert.equal(calls.length,beforeReset,"Reset confirmation opens immediately without preparing the full library");
    await page.locator(".reset-library-confirm").click();
    await expect(page.locator(".project-card")).toHaveCount(0);await phase(page,"synced");
    await page.reload();await expect(page.locator(".project-card")).toHaveCount(0);
    page.off("request",trackReset);
    assert.ok(!resetRequests.some(path=>path.startsWith("/examples/") || path.includes("/media/") || path.includes("/sync/media")),"Confirmed reset never prepares Example or downloads media originals");
    await context.close();

    // Reset includes unloaded ideas and needs no original file or generated Example media.
    const many=cloud(),bulk=structuredClone(seed),bytes=Buffer.from("Reset metadata-only attachment");
    const file={id:"",sha256:createHash("sha256").update(bytes).digest("hex"),md5:createHash("md5").update(bytes).digest("hex"),size:bytes.length,mime:"image/png"};file.id=schema.contentId(file);
    many.objects.set(`${many.storage.prefix}/media/${file.id}`,{body:bytes,type:file.mime,metadata:{sha256:file.sha256},md5:file.md5});
    bulk.projects=Array.from({length:40},(_,n)=>({...structuredClone(seed.projects[0]),id:`bulk-${n}`,name:`Bulk ${n}`}));
    bulk.projects.at(-1).blocks[0].media=[{id:file.id,name:"never-download.png",kind:"image",mime:file.mime,size:file.size}];
    await many.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(schema.flattenLibrary(bulk,[file])).map(([key,value])=>({key,value,base:[]}))});
    const bulkClient=await device(many,viewport);await phase(bulkClient.page,"synced");await open(bulkClient.page);
    const beforeBulkExport=bulkClient.calls.length,bulkDownload=bulkClient.page.waitForEvent("download");
    void bulkDownload.catch(()=>{});
    await bulkClient.page.getByRole("button",{name:"Экспортировать ZIP",exact:true}).click();
    const bulkZip=unzipSync(await readFile(await (await bulkDownload).path())),bulkManifest=JSON.parse(strFromU8(bulkZip["manifest.json"]));
    assert.equal(JSON.parse(strFromU8(bulkZip["library.json"])).projects.length,40,"Export includes ideas absent from the visible first page");
    assert.equal(Buffer.compare(Buffer.from(bulkZip[bulkManifest.media[0].path]),bytes),0,"Export downloads missing originals and preserves their bytes");
    assert.deepEqual(bulkClient.calls.slice(beforeBulkExport).map(call=>`${call.method} ${call.path}`),["POST /api/sync/scoped","POST /api/reader/batch"],"Export reads one full snapshot and one missing-media ticket packet");
    await bulkClient.page.evaluate(async id=>{const {removeMediaFiles}=await import("/__local_fixture__/media-store.js");await removeMediaFiles([id]);},file.id);
    const bulkRequests=[],track=request=>bulkRequests.push(new URL(request.url()).pathname);bulkClient.page.on("request",track);
    const beforeBulkReset=bulkClient.calls.length;
    await bulkClient.page.getByRole("button",{name:"Очистить голову",exact:true}).click();
    await expect(bulkClient.page.locator(".reset-library-confirm")).toBeVisible();assert.equal(bulkClient.calls.length,beforeBulkReset);
    await bulkClient.page.locator(".reset-library-confirm").click();
    await expect.poll(()=>bulkClient.calls.slice(beforeBulkReset).filter(call=>call.method==="PUT").length).toBe(1);
    await phase(bulkClient.page,"synced");
    const resetCalls=bulkClient.calls.slice(beforeBulkReset);
    assert.deepEqual(resetCalls.map(call=>`${call.method} ${call.path}`),["POST /api/sync/scoped","PUT /api/sync/scoped"],"Reset of 40 ideas has one authoritative read and one resumable write, without status/token/catalog reloads");
    await expect.poll(async()=>(await many.entities().catalog().readPage()).total).toBe(0);
    assert.equal((await many.entities().catalog().readPage()).sections.length,0);
    assert.ok(!bulkRequests.some(path=>path.startsWith("/examples/") || path.includes("/media/") || path.includes("/sync/media")),"Reset never downloads an unloaded attachment");
    await bulkClient.page.reload();await expect(bulkClient.page.locator(".section-open")).toHaveCount(0);await bulkClient.context.close();

    // A local personal library never overwrites an existing cloud without the owner choosing a source.
    const modern=cloud();await modern.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(schema.flattenLibrary(seed)).map(([key,value])=>({key,value,base:[]}))});
    const local=structuredClone(seed);local.projects[0].name="Local personal idea";
    const owner=await device(modern,viewport,local);await phase(owner.page,"review");await open(owner.page);
    assert.equal(owner.calls.filter(call=>call.method==="PUT").length,0);owner.page.once("dialog",dialog=>dialog.accept());
    await owner.page.getByRole("button",{name:"Загрузить облачную на устройство",exact:true}).click();await expect(owner.page.locator(".sync-phase")).toHaveText("Сохранено в облаке",{timeout:20000});await close(owner.page);
    await expect(owner.page.locator(".project-card > strong")).toHaveText("Saved idea");await expect.poll(async()=>(await state(owner.page)).layout).toBeUndefined();
    await owner.page.reload();await expect(owner.page.locator(".project-card > strong")).toHaveText("Saved idea");assert.equal(await owner.page.evaluate(()=>JSON.parse(localStorage.getItem("idea-bank.library.v1")).projects[0].name),"Local personal idea");
    await owner.context.close();
    // Fresh clients respect an intentionally empty cloud; no Example upload follows cache clearing.
    const read=await modern.entities().read();await modern.entities().save({operationId:randomUUID(),heads:read.heads,changes:Object.keys(read.index).map(key=>({key,value:null,base:read.index[key]}))});
    const fresh=await device(modern,viewport);await expect(fresh.page.locator(".library-loading")).toHaveCount(0);await phase(fresh.page,"synced");
    assert.equal(fresh.calls.filter(call=>call.method==="PUT").length,0);assert.equal((await state(fresh.page)).layout,undefined);await fresh.context.close();
    console.log(`Migration checks passed at ${viewport.width}px: explicit legacy transition, owner choice, bounded replica retirement, reload, complete ZIP, reset and intentionally empty cloud.`);
  }
}finally{if(browser)await browser.close();for(const fixture of fixtures)fixture.storage.client.destroy();server.kill("SIGKILL");await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once("exit",resolve);});}
