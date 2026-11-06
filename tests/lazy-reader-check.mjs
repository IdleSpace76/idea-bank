import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium,expect } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { memoryStorage,schema } from "./entity-fixture.mjs";
const fixture=memoryStorage(), {entityKey,flattenLibrary}=schema;
const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=","base64");
const sha256=createHash("sha256").update(image).digest("hex"),md5=createHash("md5").update(image).digest("hex");
const file={id:`${sha256}-${md5}`,sha256,md5,size:image.length,mime:"image/png"};
const asset={id:file.id,name:"sample.png",kind:"image",mime:file.mime,size:file.size};
fixture.objects.set(`${fixture.storage.prefix}/media/${file.id}`,{body:image,type:file.mime,metadata:{sha256},md5});
const library={version:1,sections:[{id:"s",name:"Section",description:"A thousand ideas",icon:"folder"}],projects:Array.from({length:1000},(_,n)=>({
  id:`idea-${String(n).padStart(4,"0")}`,sectionId:"s",name:`Idea ${n}`,description:n===900?"Distant search target":"Description",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",
  ...(n===0?{coverImage:asset}:{}),blocks:[{id:"body",heading:`Document ${n}`,text:`Body ${n}`,media:n===0?[asset]:[]}],
}))};
await fixture.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(library,[file])).map(([key,value])=>({key,value,base:[]}))});
const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`,secret="isolated-reader-fixture-session-at-least-32-characters";
const server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,IDEA_BANK_AUTH_MODE:"github",AUTH_URL:origin,AUTH_SECRET:secret,AUTH_GITHUB_ID:"fixture",AUTH_GITHUB_SECRET:"fixture",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:"https://s3.eu-central-003.backblazeb2.com",B2_REGION:"eu-central-003",B2_BUCKET_NAME:"fixture-bucket",B2_KEY_ID:"fixture",B2_APPLICATION_KEY:"fixture"}});
server.stdout.resume();server.stderr.resume();let browser;
try {
  for(let n=0;;n++){try{await fetch(origin);break;}catch{if(n>100||server.exitCode!==null)throw new Error("Fixture server did not start");await delay(100);}}
  browser=await chromium.launch({channel:"msedge",headless:true});
  const cookie="authjs.session-token",token=await encode({secret,salt:cookie,token:{sub:"12345",name:"Reader fixture"},maxAge:1800});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const baseline=await fixture.entities().read(), desired=flattenLibrary(library,[file]);
    const resetKeys=[entityKey("idea","idea-0900"),entityKey("block","idea-0000","body")];
    const resetChanges=resetKeys.filter(key=>!schema.equal(baseline.records.find(record=>record.key===key)?.value,desired[key])).map(key=>({key,value:desired[key],base:baseline.index[key]}));
    if(resetChanges.length)await fixture.entities().save({operationId:randomUUID(),heads:baseline.heads,changes:resetChanges});
    const context=await browser.newContext({viewport,isMobile:viewport.width<540,hasTouch:viewport.width<540});
    await context.addCookies([{name:cookie,value:token,url:origin,httpOnly:true,sameSite:"Lax"}]);
    await context.addInitScript(()=>localStorage.setItem("idea-bank.language","ru"));
    await context.addInitScript(()=>{const native=indexedDB.open.bind(indexedDB);window.__databaseOpens=0;indexedDB.open=(name,version)=>{if(name==="idea-bank.local")window.__databaseOpens++;return native(name,version);};});
    const calls=[],batches=[],errors=[];let offline=false,denied=false,heldIdeaRead=null;
    await context.route("https://s3.eu-central-003.backblazeb2.com/**",async route=>{
      if(offline)return route.abort("failed");
      const request=route.request(),key=decodeURIComponent(new URL(request.url()).pathname).replace(/^\/fixture-bucket\//,""),headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,PUT,OPTIONS","Access-Control-Allow-Headers":"content-type,content-md5,x-amz-meta-sha256"};
      if(request.method()==="OPTIONS")return route.fulfill({status:204,headers});
      if(request.method()==="PUT") {
        const body=request.postDataBuffer(),md5=createHash("md5").update(body).digest("hex");
        fixture.objects.set(key,{body,type:request.headers()["content-type"],metadata:{sha256:request.headers()["x-amz-meta-sha256"]},md5});
        return route.fulfill({status:200,headers});
      }
      const object=fixture.objects.get(key);if(!object)return route.fulfill({status:404,headers});
      return route.fulfill({status:200,contentType:object.type,headers:{...headers,"Content-Length":String(object.body.length)},body:object.body});
    });
    await context.route("**/api/**",async route=>{
      const request=route.request(),url=new URL(request.url());calls.push({path:url.pathname,query:url.search,method:request.method(),etag:request.headers()["if-none-match"]});
      if(offline)return route.abort("failed");
      const reply=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      if(denied && (url.pathname==="/api/catalog" || url.pathname.startsWith("/api/ideas/") || url.pathname==="/api/sync/scoped"))return reply({error:{code:"STORAGE_ACCESS_DENIED",message:"B2 отклонил запрос: проверьте лимиты операций и права ключа. Автоматические запросы приостановлены на пять минут."}},503);
      try {
        if(url.pathname==="/api/sync/scoped") {
          const body=request.postDataJSON();
          if(request.method()==="POST")return reply(await fixture.entities().readScoped(body.target,body.includeIdeas,body.includeMedia));
          batches.push(body);return reply(await fixture.entities().save(body));
        }
        if(url.pathname==="/api/catalog")return reply(await fixture.entities().catalog().readPage({limit:Number(url.searchParams.get("limit")||24),cursor:url.searchParams.get("cursor")||undefined,query:url.searchParams.get("q")||undefined,sectionId:url.searchParams.get("sectionId")||undefined}));
        if(url.pathname==="/api/catalog/media")return reply(await fixture.entities().catalog().readMedia(url.searchParams.get("id")));
        if(url.pathname==="/api/storage/media/upload")return reply(await fixture.storage.createUpload(request.postDataJSON()));
        if(url.pathname.startsWith("/api/ideas/")) {
          if(heldIdeaRead)await heldIdeaRead;
          const result=await fixture.entities().catalog().readIdea(decodeURIComponent(url.pathname.split("/").pop()),request.headers()["if-none-match"]?.replaceAll('"',""));
          if(result.notModified)return route.fulfill({status:304,body:""});
          return reply(result);
        }
        if(url.pathname==="/api/sync/events/token")return reply({enabled:false});
        if(url.pathname==="/api/sync") {
          if(request.method()==="GET")return reply(await fixture.entities().status());
          if(request.method()==="POST")return reply(await fixture.entities().read(request.postDataJSON().known));
          const body=request.postDataJSON();batches.push(body);return reply(await fixture.entities().save(body));
        }
        if(url.pathname==="/api/sync/media")return reply(await fixture.entities().download(url.searchParams.get("key"),url.searchParams.get("revision")));
        throw new Error(`Unexpected fixture request: ${url.pathname}`);
      } catch(error){return reply({error:{code:error.code,message:error.message}},error.status||502);}
    });
    const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
    await page.goto(origin);await expect(page.locator(".section-open")).toContainText("Идей: 1000");
    await expect(page.locator(viewport.width<540?".recent-project-item":".project-card-shell")).toHaveCount(viewport.width<540?4:24);
    assert.equal(calls.filter(call=>call.path==="/api/sync").length,0,"Browsing never downloads a full synchronization snapshot");
    assert.equal(calls.filter(call=>call.path.startsWith("/api/ideas/")).length,0,"Cards do not request document bodies");
    await delay(1200);
    assert.equal(await page.evaluate(()=>window.__databaseOpens),1,"Initial cloud reading reuses one IndexedDB connection");
    const sidebarCalls=()=>calls.filter(call=>call.path==="/api/catalog" && new URLSearchParams(call.query).get("sectionId")==="s" && new URLSearchParams(call.query).get("limit")==="4").length;
    const initialSidebar=sidebarCalls();assert.equal(initialSidebar,1);
    const readCalls=()=>calls.filter(call=>call.path==="/api/catalog" || call.path.startsWith("/api/ideas/")).length;
    const beforeFocus=readCalls();
    await page.evaluate(()=>{for(let n=0;n<20;n++){window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"));}});
    await delay(800);
    assert.equal(readCalls(),beforeFocus,"Repeated focus/visibility signals do not reread a freshly loaded library");
    const firstCard=page.locator(viewport.width<540?".recent-project-item > button":".project-card").filter({has:page.locator("strong").filter({hasText:/^Idea 0$/})}).first();
    const home=()=>page.locator(viewport.width<540?".mobile-brand":".breadcrumbs button").first().click();
    await firstCard.click();
    await expect(page.getByRole("heading",{name:"Document 0",exact:true})).toBeVisible();
    await expect(page.locator(".image-preview img")).toHaveAttribute("src",/^blob:/);
    assert.equal(calls.filter(call=>call.path==="/api/ideas/idea-0000").length,1);
    await home();await firstCard.click();
    await expect(page.getByRole("heading",{name:"Document 0",exact:true})).toBeVisible();
    await expect.poll(()=>calls.filter(call=>call.path==="/api/ideas/idea-0000").at(-1)?.etag).toBeTruthy();
    // The viewed body already carries its causal versions: adding a block needs no cloud read.
    const beforeEdit=calls.filter(call=>call.path==="/api/sync/scoped" && call.method==="POST").length;
    await page.getByRole("button",{name:"Добавить блок",exact:true}).click();await expect(page.locator("#project-editor")).toBeVisible();
    assert.equal(calls.filter(call=>call.path==="/api/sync/scoped" && call.method==="POST").length,beforeEdit,"Opening a cached block editor does not await the cloud");
    page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"Отмена",exact:true}).click();await expect(page.locator("#project-editor")).toHaveCount(0);
    const source=await fixture.entities().catalogIndex(),key=entityKey("block","idea-0000","body");
    await fixture.entities().save({operationId:randomUUID(),heads:source.heads,changes:[{key,base:source.index[key],value:{...library.projects[0].blocks[0],text:`Updated ${viewport.width}`}}]});
    // A delayed version check must leave the existing document mounted and readable.
    let releaseRead;heldIdeaRead=new Promise(resolve=>releaseRead=resolve);
    const beforeRefresh=calls.filter(call=>call.path==="/api/ideas/idea-0000").length;
    await page.getByRole("heading",{name:"Document 0",exact:true}).evaluate(element=>element.dataset.continuity="kept");
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect.poll(()=>calls.filter(call=>call.path==="/api/ideas/idea-0000").length).toBeGreaterThan(beforeRefresh);
    await expect(page.getByRole("heading",{name:"Document 0",exact:true})).toHaveAttribute("data-continuity","kept");
    await expect(page.getByText("Body 0",{exact:true})).toBeVisible();
    await expect(page.getByText("Загружаем идею…",{exact:true})).toHaveCount(0);
    releaseRead();heldIdeaRead=null;
    await expect(page.getByText(`Updated ${viewport.width}`,{exact:true})).toBeVisible();
    // Reload has no in-memory document: show the persisted cache before the cloud responds.
    const beforeReload=calls.filter(call=>call.path==="/api/ideas/idea-0000").length;
    heldIdeaRead=new Promise(resolve=>releaseRead=resolve);await page.reload();
    await expect.poll(()=>calls.filter(call=>call.path==="/api/ideas/idea-0000").length).toBeGreaterThan(beforeReload);
    await expect(page.getByText(`Updated ${viewport.width}`,{exact:true})).toBeVisible();
    await expect(page.getByText("Загружаем идею…",{exact:true})).toHaveCount(0);
    releaseRead();heldIdeaRead=null;
    offline=true;await page.evaluate(()=>{Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>false});window.dispatchEvent(new Event("offline"));});
    await expect(page.getByText("Офлайн · сохранённая версия",{exact:true})).toBeVisible();
    await expect(page.getByText(`Updated ${viewport.width}`,{exact:true})).toBeVisible();
    await page.evaluate(()=>{location.hash="#/project/idea-0900";});
    await expect(page.getByText("Для открытия этой идеи нужно подключение к интернету",{exact:true})).toBeVisible();
    await expect(page.getByRole("heading",{name:"Document 0",exact:true})).toHaveCount(0);
    offline=false;await page.evaluate(()=>{Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>true});window.dispatchEvent(new Event("online"));});
    await expect(page.getByRole("heading",{name:"Document 900",exact:true})).toBeVisible();
    await expect(page.getByText("Офлайн · сохранённая версия",{exact:true})).toHaveCount(0);
    assert.equal(calls.filter(call=>call.path==="/api/sync").length,0);
    await home();
    await delay(350);const beforeBrowsingSidebar=sidebarCalls();
    await page.locator(".projects-toolbar input").fill("distant");
    await expect(page.locator(".project-card > strong")).toHaveText("Idea 900");
    await page.locator(".projects-toolbar input").fill("");await page.locator(".section-open").click();
    await expect(page.locator(".project-card")).toHaveCount(24);
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    await expect.poll(()=>page.locator(".project-card").count()).toBeGreaterThan(24);
    assert.ok(calls.some(call=>call.path==="/api/catalog" && call.query.includes("cursor=")));
    await delay(350);
    assert.equal(sidebarCalls(),beforeBrowsingSidebar,"Search, route changes and pagination do not reload an unchanged sidebar");
    // The compatibility write path must not interpret the remaining 976 ideas as deletions.
    await page.evaluate(()=>{location.hash="#/project/idea-0900";});await expect(page.getByRole("heading",{name:"Document 900",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Изменить",exact:true}).click();
    const form=page.getByRole("dialog");await expect(form).toBeVisible({timeout:45000});
    await form.getByLabel("Краткое описание",{exact:false}).fill(`Edited ${viewport.width}`);
    await form.getByRole("button",{name:"Сохранить",exact:true}).click();
    await expect.poll(()=>batches.some(batch=>batch.changes.some(change=>change.value?.description===`Edited ${viewport.width}`)),{timeout:20000}).toBe(true);
    const actual=await fixture.entities().read();
    assert.equal(actual.records.filter(record=>record.key.startsWith("idea:") && record.value).length,1000);
    assert.ok(batches.every(batch=>batch.changes.every(change=>change.value!==null)),"A partial view cannot delete unloaded cloud records");
    assert.equal(calls.filter(call=>call.path==="/api/sync").length,0,"Editing also avoids full-library synchronization");
    await home();
    await page.getByRole("button",{name:"Создать раздел",exact:true}).last().click();
    await page.getByRole("dialog").getByLabel("Название",{exact:true}).fill(`Temporary ${viewport.width}`);
    await page.getByRole("dialog").getByRole("button",{name:"Создать раздел",exact:true}).click();
    await expect.poll(async()=> (await fixture.entities().catalog().readPage()).sections.some(section=>section.variants[0]?.name===`Temporary ${viewport.width}`)).toBe(true);
    await page.locator(".section-open").filter({hasText:`Temporary ${viewport.width}`}).click();
    await page.locator(".page-action-button").click();
    await page.getByRole("dialog").getByLabel("Название",{exact:true}).fill("Temporary idea");
    const cover=await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=8;canvas.height=8;canvas.getContext("2d").fillRect(0,0,8,8);return canvas.toDataURL().split(",")[1];});
    await page.getByRole("dialog").getByLabel("Загрузить свою обложку",{exact:true}).setInputFiles({name:"new-cover.png",mimeType:"image/png",buffer:Buffer.from(cover,"base64")});
    await page.getByRole("dialog").getByRole("button",{name:"Создать идею",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Temporary idea",exact:true})).toBeVisible();
    const temporary=decodeURIComponent(new URL(page.url()).hash.split("/").pop());
    await expect.poll(async()=>{try{return (await fixture.entities().catalog().readIdea(temporary)).idea.name;}catch{return "";}},{timeout:15000}).toBe("Temporary idea");
    await expect(page.locator(".local-status")).toHaveAttribute("data-sync-phase","synced");
    await page.getByRole("button",{name:"Добавить блок",exact:true}).click();
    await page.getByLabel("Заголовок блока",{exact:true}).fill("Temporary block");await page.getByLabel("Текст",{exact:true}).fill("Temporary text");
    await page.getByRole("button",{name:"Сохранить идею",exact:true}).click();
    await expect.poll(async()=> (await fixture.entities().catalog().readIdea(temporary)).idea.blocks.length).toBe(1);
    await page.getByRole("button",{name:"Действия с идеей",exact:true}).click();await page.getByRole("menuitem",{name:"Перенести в раздел",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Section",exact:true}).click();
    await expect.poll(async()=> (await fixture.entities().catalog().readIdea(temporary)).idea.sectionId).toBe("s");
    await page.getByRole("button",{name:"Действия с идеей",exact:true}).click();await page.getByRole("menuitem",{name:"Удалить идею",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Удалить идею",exact:true}).click();
    await expect.poll(async()=> (await fixture.entities().catalog().readPage()).total).toBe(1000);
    await home();await page.getByRole("button",{name:`Действия с разделом Temporary ${viewport.width}`,exact:true}).click();await page.getByRole("menuitem",{name:"Удалить раздел",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Удалить раздел",exact:true}).click();
    await expect.poll(async()=> (await fixture.entities().catalog().readPage()).sections.length).toBe(1);
    // A B2 denial keeps cached bodies visible and suspends reads and queued writes together.
    await page.evaluate(()=>{location.hash="#/project/idea-0000";});
    await expect(page.getByRole("heading",{name:"Document 0",exact:true})).toBeVisible();
    await expect(page.locator(".local-status")).toHaveAttribute("data-sync-phase","synced");
    denied=true;await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect(page.getByText("Облако недоступно · сохранённая версия",{exact:true})).toBeVisible();
    await expect(page.getByText("Офлайн · сохранённая версия",{exact:true})).toHaveCount(0);
    await expect(page.getByRole("heading",{name:"Document 0",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Добавить блок",exact:true}).click();
    const queuedHeading=`Queued during B2 pause ${viewport.width}`;
    await page.getByLabel("Заголовок блока",{exact:true}).last().fill(queuedHeading);
    await page.getByRole("button",{name:"Сохранить идею",exact:true}).click();
    await delay(1500);
    await expect(page.getByText("Облако недоступно · сохранённая версия",{exact:true})).toBeVisible();
    const pausedCalls=calls.filter(call=>call.path==="/api/catalog" || call.path.startsWith("/api/ideas/") || call.path==="/api/sync/scoped").length;
    await page.evaluate(()=>{for(let n=0;n<10;n++){window.dispatchEvent(new Event("focus"));window.dispatchEvent(new Event("online"));}});
    await delay(1800);
    assert.equal(calls.filter(call=>call.path==="/api/catalog" || call.path.startsWith("/api/ideas/") || call.path==="/api/sync/scoped").length,pausedCalls,"Focus, reconnect and a pending edit cannot bypass the B2 cooldown");
    assert.ok(!(await fixture.entities().catalog().readIdea("idea-0000")).idea.blocks.some(block=>block.heading===queuedHeading));
    denied=false;await page.locator(".local-status").click();
    await page.getByRole("button",{name:"Синхронизировать",exact:true}).click();
    await expect.poll(async()=> (await fixture.entities().catalog().readIdea("idea-0000")).idea.blocks.some(block=>block.heading===queuedHeading),{timeout:20000}).toBe(true);
    await expect(page.getByText("Облако недоступно · сохранённая версия",{exact:true})).toHaveCount(0);
    assert.equal(calls.filter(call=>call.path==="/api/sync").length,0,"All CRUD operations use scoped synchronization");
    assert.equal(errors.length,0,errors.join("\n"));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await context.close();console.log(`Lazy reader checks passed at ${viewport.width}px: 1000 cards, body-on-open, conditional reads, media, offline cache, uncached documents, reconnect, search, scrolling and safe partial editing.`);
  }
} finally {if(browser)await browser.close();server.kill("SIGKILL");await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once("exit",resolve);});fixture.storage.client.destroy();}
