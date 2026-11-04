import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { readFile,mkdir,writeFile } from "node:fs/promises";
import ts from "typescript";
import { unzipSync, strFromU8 } from "fflate";
import { chromium,expect } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { memoryStorage } from "./entity-fixture.mjs";
await import("./entity-storage-check.mjs");
await import("./entity-merge-check.mjs");
const directory=new URL("../.cache/entity-browser/",import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL("local-fixture.mjs",directory),ts.transpileModule(await readFile(new URL("./local-fixture.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
const { readStoredLibrary,setStoredLibrary }=await import(new URL("local-fixture.mjs",directory));
const probe=createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://127.0.0.1:${port}`,secret="isolated-entity-sync-fixture-at-least-32-characters";
const server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,IDEA_BANK_AUTH_MODE:"github",AUTH_URL:origin,AUTH_SECRET:secret,AUTH_GITHUB_ID:"fixture",AUTH_GITHUB_SECRET:"fixture",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:"https://s3.eu-central-003.backblazeb2.com",B2_REGION:"eu-central-003",B2_BUCKET_NAME:"fixture-bucket",B2_KEY_ID:"fixture",B2_APPLICATION_KEY:"fixture"}});
server.stdout.resume();server.stderr.resume();let browser;
const hash=(bytes,kind="sha256")=>createHash(kind).update(bytes).digest("hex");
try {
  for(let n=0;;n++){try{await fetch(origin);break;}catch{if(n>100||server.exitCode!==null)throw new Error("Fixture server startup failed");await delay(100);}}
  browser=await chromium.launch({channel:"msedge",headless:true});
  const cookie="authjs.session-token",token=await encode({secret,salt:cookie,token:{sub:"12345",name:"Entity sync fixture"},maxAge:1800});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const fixture=memoryStorage(),contexts=[];let offline=false,corrupt=false,dropReply=false,failRead=false;const batches=[],reads=[],downloads=[];
    async function device(backend=fixture) {
      const context=await browser.newContext({viewport,isMobile:viewport.width<540,hasTouch:viewport.width<540});contexts.push(context);await context.addInitScript(()=>{localStorage.setItem("idea-bank.language","ru");Object.defineProperty(document,"visibilityState",{get:()=>"hidden"});});
      await context.addCookies([{name:cookie,value:token,url:origin,httpOnly:true,sameSite:"Lax"}]);
      await context.route("**/api/**",async route=>{
        if(offline)return route.abort("failed");
        const request=route.request(),url=new URL(request.url());
        const reply=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
        try {
          if(url.pathname==="/api/sync") {
            if(request.method()==="GET")return reply(await backend.entities().status());
            if(request.method()==="PUT") {const body=request.postDataJSON();batches.push(body);const result=await backend.entities().save(body);if(dropReply){dropReply=false;return route.abort("failed");}return reply(result);}
            if(failRead)return reply({error:{message:"Incomplete fixture response"}},502);
            const result=await backend.entities().read(request.method()==="POST"?request.postDataJSON().known:{});reads.push(result.records.length);return reply(result);
          }
          if(url.pathname==="/api/sync/media")return reply(await backend.entities().download(url.searchParams.get("key"),url.searchParams.get("revision")));
          if(url.pathname==="/api/storage/media/upload")return reply(await backend.storage.createUpload(request.postDataJSON()));
          if(url.pathname==="/api/storage/library")return reply(await backend.storage.readLibrary(url.searchParams.get("revision")||undefined));
          return reply({error:{message:"Unexpected fixture path"}},500);
        }catch(error){return reply({error:{code:error.code,message:error.message}},error.status||502);}
      });
      await context.route("https://s3.eu-central-003.backblazeb2.com/**",async route=>{
        const request=route.request(),url=new URL(request.url()),key=decodeURIComponent(url.pathname).split("/").slice(2).join("/");
        const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, PUT, OPTIONS","Access-Control-Allow-Headers":"*"};
        if(request.method()==="OPTIONS")return route.fulfill({status:204,headers});
        if(request.method()==="PUT") {
          const body=request.postDataBuffer();assert.equal(hash(body,"md5"),Buffer.from(request.headers()["content-md5"],"base64").toString("hex"));
          backend.objects.set(key,{body,type:request.headers()["content-type"],metadata:{sha256:request.headers()["x-amz-meta-sha256"]},md5:hash(body,"md5")});return route.fulfill({status:200,headers});
        }
        downloads.push(key);const object=backend.objects.get(key);if(!object)return route.fulfill({status:404,headers});
        return route.fulfill({status:200,headers,body:corrupt?Buffer.from("corrupt"):object.body});
      });
      const page=await context.newPage();await page.goto(origin);await expect(page.locator(".project-card")).toHaveCount(1);return page;
    }
    const open=async page=>{await page.locator(".local-status").click();await expect(page.locator(".cloud-sync-controls")).toBeVisible();};
    const close=page=>page.getByRole("button",{name:"Понятно",exact:true}).click();
    const check=async page=>{await page.getByRole("button",{name:/^(Синхронизировать|Проверить ещё раз)$/}).click();await expect(page.locator(".cloud-sync-controls .primary-button").first()).toBeEnabled({timeout:15000});};
    const success=page=>expect(page.locator(".cloud-sync-controls .backup-status")).toHaveText("Изменения идей синхронизированы.",{timeout:15000});
    const change=async(page,edit)=>{const library=await page.evaluate(readStoredLibrary);edit(library);await setStoredLibrary(page,library);await page.reload();await expect(page.locator(".project-card")).toHaveCount(library.projects.length);};
    const a=await device(),own=await a.evaluate(readStoredLibrary);
    own.projects[0].name="Personal idea";own.projects[0].blocks[0].text="Base one";delete own.projects[0].blocks[0].richText;own.projects[0].blocks[1].text="Base two";
    const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=","base64"),pixelId=randomUUID();
    own.projects[0].blocks[0].media=[{id:pixelId,name:"pixel.png",kind:"image",mime:"image/png",size:pixel.length}];own.projects[0].coverImage={...own.projects[0].blocks[0].media[0]};
    await a.evaluate(async({id,bytes})=>{const db=await new Promise(r=>{const q=indexedDB.open("idea-bank.local",1);q.onsuccess=()=>r(q.result);});await new Promise(r=>{const tx=db.transaction("media","readwrite");tx.objectStore("media").put(new Blob([new Uint8Array(bytes)],{type:"image/png"}),id);tx.oncomplete=r;});db.close();},{id:pixelId,bytes:[...pixel]});
    const hiddenPixel=Buffer.concat([pixel,Buffer.from([1])]),hiddenId=randomUUID();
    own.projects[0].blocks[1].media=[{id:hiddenId,name:"hidden.png",kind:"image",mime:"image/png",size:hiddenPixel.length}];
    await a.evaluate(async({id,bytes})=>{const db=await new Promise(r=>{const q=indexedDB.open("idea-bank.local",1);q.onsuccess=()=>r(q.result);});await new Promise(r=>{const tx=db.transaction("media","readwrite");tx.objectStore("media").put(new Blob([new Uint8Array(bytes)],{type:"image/png"}),id);tx.oncomplete=r;});db.close();},{id:hiddenId,bytes:[...hiddenPixel]});
    await setStoredLibrary(a,own);await a.reload();await expect(a.locator(".project-card > strong")).toHaveText("Personal idea");await open(a);await check(a);
    assert.equal(batches.length,0,"First transfer waits for owner choice");await a.getByRole("button",{name:"Сохранить локальную в облаке",exact:true}).click();await success(a);
    const b=await device();await open(b);await check(b);b.once("dialog",d=>d.accept());await b.getByRole("button",{name:"Загрузить облачную на устройство",exact:true}).click();await success(b);
    const received=await b.evaluate(readStoredLibrary);assert.equal(received.projects[0].name,"Personal idea");assert.equal(received.projects[0].coverImage.id,`${hash(pixel)}-${hash(pixel,"md5")}`);
    const before=fixture.objects.size;await check(b);await success(b);assert.equal(fixture.objects.size,before,"A no-op sync does not create snapshots");assert.equal(reads.at(-1),0,"A no-op sync sends no record contents");
    const hiddenContent=`${hash(hiddenPixel)}-${hash(hiddenPixel,"md5")}`;
    assert.ok(!downloads.some(key=>key.includes(hash(hiddenPixel))),"Sync and the home page do not fetch media inside unopened ideas");
    // Evict downloaded copies. Metadata checks still work; ZIP deliberately fetches all originals.
    await b.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open("idea-bank.local",1);q.onsuccess=()=>r(q.result);});await new Promise(r=>{const tx=db.transaction(["meta","media"],"readwrite");tx.objectStore("media").clear();tx.objectStore("meta").put({},"media-cache");tx.oncomplete=r;});db.close();});
    const beforeColdCheck=downloads.length;await check(b);await success(b);assert.equal(downloads.length,beforeColdCheck,"Sync does not re-download evicted files");
    const zipEvent=b.waitForEvent("download");await b.getByRole("button",{name:"Экспортировать ZIP",exact:true}).click();
    const zip=unzipSync(await readFile(await (await zipEvent).path())),manifest=JSON.parse(strFromU8(zip["manifest.json"]));assert.equal(manifest.media.length,2);
    const hiddenEntry=manifest.media.find(file=>file.id===hiddenContent);assert.equal(hash(zip[hiddenEntry.path]),hash(hiddenPixel));assert.ok(downloads.some(key=>key.includes(hash(hiddenPixel))));
    await close(a);await close(b);
    const newIdea=(library,id,name)=>library.projects.push({...structuredClone(library.projects[0]),id,name,coverImage:undefined,blocks:[{id:randomUUID(),heading:"New",text:name}]});
    await change(a,l=>newIdea(l,"idea-a","From A"));await change(b,l=>newIdea(l,"idea-b","From B"));
    await open(a);await check(a);await success(a);await open(b);await check(b);await success(b);
    assert.deepEqual((await b.evaluate(readStoredLibrary)).projects.map(p=>p.name).sort(),["From A","From B","Personal idea"]);
    const sent=batches.at(-1).changes.filter(c=>c.key.startsWith("idea:"));assert.ok(sent.every(c=>c.value?.id==="idea-b"),"Only the new idea is uploaded");
    await check(a);await success(a);await close(a);await close(b);
    await change(a,l=>l.projects.find(p=>p.id==="example").blocks[0].text="A block");await change(b,l=>l.projects.find(p=>p.id==="example").blocks[1].text="B block");
    await open(a);await check(a);await success(a);await open(b);await check(b);await success(b);await check(a);await success(a);
    assert.deepEqual((await b.evaluate(readStoredLibrary)).projects.find(p=>p.id==="example").blocks.map(x=>x.text),["A block","B block"]);
    await close(a);await close(b);
    await change(a,l=>l.projects.find(p=>p.id==="example").blocks[0].text="A conflict");await change(b,l=>l.projects.find(p=>p.id==="example").blocks[0].text="B conflict");
    await open(a);await check(a);await success(a);await open(b);await check(b);await expect(b.locator("[data-conflict-key]")).toHaveCount(1);
    await b.getByText("Сравнить версии",{exact:true}).click();await expect(b.locator(".sync-version-body").first()).toContainText("B conflict");await expect(b.locator(".sync-version-body").nth(1)).toContainText("A conflict");
    const conflict=b.locator("[data-conflict-key]"),localChoice=conflict.getByRole("button",{name:/На этом устройстве/}),cloudChoice=conflict.getByRole("button",{name:/В облаке/});
    const apply=b.getByRole("button",{name:"Применить выбранные варианты",exact:true});
    await expect(apply).toBeDisabled();
    const choose=async button=>{await button.scrollIntoViewIfNeeded();if(viewport.width<540)await button.tap();else await button.click();};
    await choose(cloudChoice);await expect(cloudChoice).toHaveAttribute("aria-pressed","true");await expect(localChoice).toHaveAttribute("aria-pressed","false");
    await choose(localChoice);await expect(localChoice).toHaveAttribute("aria-pressed","true");await expect(cloudChoice).toHaveAttribute("aria-pressed","false");
    assert.notEqual(await localChoice.evaluate(el=>getComputedStyle(el).backgroundColor),await cloudChoice.evaluate(el=>getComputedStyle(el).backgroundColor),"A selected version stays visibly highlighted after a touch");
    await expect(conflict.locator(".sync-conflict-details button, .sync-conflict-details [aria-pressed], .sync-conflict-details [data-selected]")).toHaveCount(0);
    await expect(conflict.locator(".menu-options .conflict-option")).toHaveCount(2);
    await expect(apply).toBeEnabled();await apply.scrollIntoViewIfNeeded();if(viewport.width<540)await apply.tap();else await apply.click();await success(b);
    await check(a);await success(a);assert.equal((await a.evaluate(readStoredLibrary)).projects.find(p=>p.id==="example").blocks[0].text,"B conflict");
    await close(a);await close(b);
    // Lost HTTP response: retry the persisted operation without a second commit.
    await change(a,l=>l.projects.find(p=>p.id==="idea-a").description="Retry exactly once");await open(a);dropReply=true;await check(a);await expect(a.locator(".backup-error").first()).toBeVisible();
    const afterLost=[...fixture.objects.keys()].filter(k=>k.includes("/indexes/")).length;await check(a);await success(a);assert.equal([...fixture.objects.keys()].filter(k=>k.includes("/indexes/")).length,afterLost);
    // An offline edit remains on disk until a later successful sync.
    await close(a);await change(a,l=>l.projects.find(p=>p.id==="idea-a").description="Offline edit");await open(a);offline=true;await check(a);await expect(a.locator(".backup-error").first()).toBeVisible();offline=false;
    assert.equal((await a.evaluate(readStoredLibrary)).projects.find(p=>p.id==="idea-a").description,"Offline edit");await check(a);await success(a);
    // Valid metadata sync completes even when an on-demand preview is corrupt.
    const c=await device();await open(c);await check(c);corrupt=true;c.once("dialog",d=>d.accept());await c.getByRole("button",{name:"Загрузить облачную на устройство",exact:true}).click();await success(c);
    assert.equal((await c.evaluate(readStoredLibrary)).projects.find(p=>p.id==="example").name,"Personal idea");
    await close(c);await c.goto(origin+"/#/project/example");await expect(c.locator(".media-error").first()).toBeVisible({timeout:15000});
    corrupt=false;await c.getByRole("button",{name:"Повторить загрузку",exact:true}).first().click();await expect(c.locator(".image-preview img").first()).toBeVisible({timeout:15000});
    // Deletion versus an offline block edit requires a choice at idea level.
    await open(b);await check(b);await success(b);await close(a);await close(b);
    await change(a,l=>{l.projects=l.projects.filter(p=>p.id!=="idea-b");});await change(b,l=>{l.projects.find(p=>p.id==="idea-b").blocks[0].text="Keep edited idea";});
    await open(a);await check(a);await success(a);await open(b);await check(b);
    const parentConflict=b.locator("[data-conflict-key]").filter({has:b.getByRole("heading",{name:"Идея: From B",exact:true})});
    await expect(parentConflict).toBeVisible();await parentConflict.getByRole("button",{name:/На этом устройстве/}).click();
    await b.getByRole("button",{name:"Применить выбранные варианты",exact:true}).click();await success(b);await check(a);await success(a);
    assert.equal((await a.evaluate(readStoredLibrary)).projects.find(p=>p.id==="idea-b").blocks[0].text,"Keep edited idea");
    // An unchanged device accepts a deletion and cannot resurrect it on the next sync.
    await close(a);await change(a,l=>{l.projects=l.projects.filter(p=>p.id!=="idea-a");});await open(a);await check(a);await success(a);await check(b);await success(b);await check(b);await success(b);
    assert.ok(!(await b.evaluate(readStoredLibrary)).projects.some(p=>p.id==="idea-a"));
    // Metadata/quota failure after cloud publication keeps the local queue and retries the same operation.
    await close(a);await change(a,l=>{l.projects.find(p=>p.id==="idea-b").description="Atomic checkpoint";});await open(a);
    const beforeQuota=await a.evaluate(readStoredLibrary);
    await a.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restorePut=()=>{IDBObjectStore.prototype.put=put;};IDBObjectStore.prototype.put=function(...args){if(this.name==="meta"&&args[1]==="sync-v2")throw new DOMException("fixture full","QuotaExceededError");return put.apply(this,args);};});
    await check(a);await expect(a.locator(".cloud-sync-controls .backup-error")).toBeVisible();assert.deepEqual(await a.evaluate(readStoredLibrary),beforeQuota);
    const committed=[...fixture.objects.keys()].filter(k=>k.includes("/indexes/")).length;await a.evaluate(()=>window.restorePut());await close(a);
    await change(a,l=>{l.projects.find(p=>p.id==="idea-b").description="Edited after checkpoint failure";});await open(a);await check(a);await success(a);
    assert.equal([...fixture.objects.keys()].filter(k=>k.includes("/indexes/")).length,committed+1,"The retry reuses the first operation and publishes only the newer edit");
    assert.equal((await a.evaluate(readStoredLibrary)).projects.find(p=>p.id==="idea-b").description,"Edited after checkpoint failure");
    // A legacy installation asks for an explicit protocol upgrade before touching its history.
    const legacy=memoryStorage(),legacyLibrary={...structuredClone(own),projects:[{...structuredClone(own.projects[0]),name:"Legacy idea",coverImage:undefined,blocks:[{id:"legacy-block",heading:"Legacy",text:"Old data"}]}]};
    await legacy.storage.saveLibrary({baseRevisions:[],library:legacyLibrary,media:[]});
    const d=await device(legacy);await open(d);await check(d);await expect(d.getByRole("button",{name:"Перейти на новую синхронизацию",exact:true})).toBeVisible();assert.equal([...legacy.objects.keys()].filter(k=>k.includes("/indexes/")).length,0);
    await d.getByRole("button",{name:"Перейти на новую синхронизацию",exact:true}).click();await expect(d.getByRole("button",{name:"Загрузить облачную на устройство",exact:true})).toBeVisible();d.once("dialog",dialog=>dialog.accept());await d.getByRole("button",{name:"Загрузить облачную на устройство",exact:true}).click();await success(d);
    assert.equal((await d.evaluate(readStoredLibrary)).projects[0].name,"Legacy idea");legacy.storage.client.destroy();
    await b.screenshot({path:new URL(`sync-${viewport.width}.png`,directory).pathname.replace(/^\/([A-Za-z]:)/,"$1")});
    for(const page of [a,b,c])assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    for(const context of contexts)await context.close();fixture.storage.client.destroy();
    console.log(`Entity sync browser checks passed at ${viewport.width}px: first transfer, delta sync, independent ideas/blocks, conflict choice, deletion/edit resolution, lost-response retry, offline edits, quota rollback, lazy previews, cold-cache ZIP and corrupt media rejection.`);
  }
} finally {
  if(browser)await browser.close();server.kill();await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once("exit",resolve);});
}
