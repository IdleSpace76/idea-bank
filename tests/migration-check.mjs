import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {unzipSync,strFromU8} from "fflate";
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
    const context=await browser.newContext({viewport,isMobile:viewport.width<540,hasTouch:viewport.width<540}),calls=[],network={failFull:false};
    await context.addCookies([{name:cookie,value:token,url:origin,httpOnly:true,sameSite:"Lax"}]);
    await context.addInitScript(({local})=>{localStorage.setItem("idea-bank.language","ru");if(local&&!localStorage.getItem("migration-fixture-seeded")){localStorage.setItem("idea-bank.library.v1",JSON.stringify(local));localStorage.setItem("migration-fixture-seeded","yes");}},{local});
    await context.route("**/api/**",async route=>{
      const request=route.request(),url=new URL(request.url()),method=request.method();calls.push({path:url.pathname,method,body:method==="POST"||method==="PUT"?request.postDataJSON():undefined});
      const reply=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      try{
        const entities=fixture.entities();
        if(url.pathname==="/api/sync/events/token")return reply({enabled:false});
        if(url.pathname==="/api/catalog")return reply(await entities.catalog().readPage({limit:Number(url.searchParams.get("limit")||24),cursor:url.searchParams.get("cursor")||undefined,sectionId:url.searchParams.get("sectionId")||undefined,query:url.searchParams.get("q")||undefined}));
        if(url.pathname==="/api/catalog/media")return reply(await entities.catalog().readMedia(url.searchParams.get("id")));
        if(url.pathname.startsWith("/api/ideas/")){const result=await entities.catalog().readIdea(decodeURIComponent(url.pathname.split("/").pop()),request.headers()["if-none-match"]?.replaceAll('"',""));return result.notModified?route.fulfill({status:304,body:""}):reply(result);}
        if(url.pathname==="/api/sync/scoped"){const body=request.postDataJSON();return reply(method==="POST"?await entities.readScoped(body.target,body.includeIdeas,body.includeMedia):await entities.save(body));}
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
    await open(page);const download=page.waitForEvent("download");await page.getByRole("button",{name:"Экспортировать ZIP",exact:true}).click();
    const zip=unzipSync(await readFile(await (await download).path())),archived=JSON.parse(strFromU8(zip["library.json"]));
    assert.equal(archived.projects[0].blocks[0].text,"Keep this text");await close(page);
    await expect.poll(async()=>(await state(page)).layout).toBeUndefined();
    // Reset is an explicit whole-library change; reload never resurrects the old backup.
    await open(page);await page.getByRole("button",{name:"Очистить голову",exact:true}).click();await page.locator(".reset-library-confirm").click();
    await expect(page.locator(".project-card > strong")).toHaveText("Example");await phase(page,"synced");
    await page.reload();await expect(page.locator(".project-card > strong")).toHaveText("Example");
    await context.close();

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
