import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { readFile,mkdir,writeFile } from "node:fs/promises";
import ts from "typescript";
import { chromium,expect } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { memoryStorage } from "./entity-fixture.mjs";


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

  const fixture=memoryStorage(),contexts=[],states=new Map(),batches=[];
  const seed={version:1,sections:[{id:"section",name:"Test",description:"",icon:"folder"}],projects:[{id:"idea",sectionId:"section",name:"Auto idea",description:"Base",cover:"forest",updatedAt:"2026-11-01T00:00:00Z",blocks:[{id:"block",heading:"Block",text:"Base text"}]}]};
  async function device(viewport={width:1440,height:1000}) {
    const context=await browser.newContext({viewport});contexts.push(context);
    await context.addInitScript(seed=>{localStorage.setItem("idea-bank.language","ru");localStorage.setItem("idea-bank.library.v1",JSON.stringify(seed));},seed);
    await context.addCookies([{name:cookie,value:token,url:origin,httpOnly:true,sameSite:"Lax"}]);
    const state={offline:false,unauth:false,hold:null,entered:null,calls:0,active:0,maxActive:0};
    await context.route("**/api/sync**",async route=>{
      const req=route.request();state.calls++;
      if(state.offline)return route.abort("failed");
      const reply=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      if(state.unauth)return reply({error:{message:"Session expired"}},401);
      state.active++;state.maxActive=Math.max(state.maxActive,state.active);
      try {
        if(state.hold&&req.method()==="POST"){state.entered?.();await state.hold;}
        if(req.method()==="GET")return await reply(await fixture.entities().status());
        if(req.method()==="PUT"){const body=req.postDataJSON();batches.push(body);return await reply(await fixture.entities().save(body));}
        return await reply(await fixture.entities().read(req.postDataJSON().known));
      }catch(error){return await reply({error:{code:error.code,message:error.message}},error.status||502);}
      finally{state.active--;}
    });
    const page=await context.newPage();states.set(page,state);await page.goto(origin);await expect(page.locator(".project-card > strong")).toHaveText("Auto idea");return page;
  }
  const phase=(page,name)=>expect(page.locator(".local-status")).toHaveAttribute("data-sync-phase",name,{timeout:15000});
  const open=page=>page.locator(".local-status").click();
  const close=page=>page.getByRole("button",{name:"Понятно",exact:true}).click();
  const wake=page=>page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  const library=page=>page.evaluate(readStoredLibrary);
  const edit=async(page,mutate)=>{const value=await library(page);mutate(value);await setStoredLibrary(page,value);};
  const readDescription=async page=>(await library(page)).projects[0].description;
  const a=await device();await phase(a,"review");await open(a);await a.getByRole("button",{name:"Сохранить локальную в облаке",exact:true}).click();await phase(a,"synced");await close(a);
  const b=await device({width:390,height:844});await phase(b,"review");await open(b);b.once("dialog",d=>d.accept());await b.getByRole("button",{name:"Загрузить облачную на устройство",exact:true}).click();await phase(b,"synced");await close(b);
  // Save through the real metadata form. Sync continues with its dialog closed.
  await a.goto(origin+"/#/project/idea");await a.getByRole("button",{name:"Изменить",exact:true}).click();
  const form=a.getByRole("dialog");await form.getByLabel("Краткое описание",{exact:false}).fill("Saved without sync button");await form.getByRole("button",{name:"Сохранить",exact:true}).click();
  await phase(a,"synced");assert.ok(batches.at(-1).changes.some(c=>c.value?.description==="Saved without sync button"));
  await b.reload();await phase(b,"synced");assert.equal(await readDescription(b),"Saved without sync button","Startup automatically pulls changes");
  const stableCalls=states.get(a).calls;await delay(2700);assert.equal(states.get(a).calls,stableCalls,"Remote notifications must not cause a feedback loop");
  // A transient failure leaves a durable queue; online resumes without a manual action.
  states.get(a).offline=true;await edit(a,l=>l.projects[0].description="Offline queue");await phase(a,"retry");
  assert.equal(await readDescription(a),"Offline queue");const failedCalls=states.get(a).calls;await delay(2400);assert.ok(states.get(a).calls>failedCalls,"Failed requests are retried automatically");
  states.get(a).offline=false;await a.evaluate(()=>window.dispatchEvent(new Event("online")));await phase(a,"synced");
  await wake(b);await phase(b,"synced");await expect.poll(()=>readDescription(b)).toBe("Offline queue");
  // Hold a read in flight, then open a block draft before its response arrives.
  await edit(a,l=>{l.projects[0].blocks[0].text="Incoming remote text";});await phase(a,"synced");
  await b.goto(origin+"/#/project/idea");let release;const held=new Promise(r=>release=r);let entered;
  const reading=new Promise(r=>entered=r);states.get(b).hold=held;states.get(b).entered=entered;await wake(b);await Promise.race([reading,delay(15000).then(()=>{throw new Error("Read did not start");})]);
  await b.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();await b.getByLabel("Заголовок блока",{exact:true}).fill("Unsaved draft");
  states.get(b).hold=null;release();await phase(b,"waiting");await delay(1300);
  await expect(b.getByLabel("Заголовок блока",{exact:true})).toHaveValue("Unsaved draft");assert.equal((await library(b)).projects[0].blocks[0].text,"Base text","Incoming changes wait while editing");
  b.once("dialog",d=>d.accept());await b.getByRole("button",{name:"Отмена",exact:true}).click();await phase(b,"synced");assert.equal((await library(b)).projects[0].blocks[0].text,"Incoming remote text");
  // Automatic remote updates preserve the current idea route.
  assert.equal(new URL(b.url()).hash,"#/project/idea");
  // Session expiry pauses retries until sign-in/focus; local edits remain untouched.
  states.get(a).unauth=true;await edit(a,l=>l.projects[0].description="Waiting for sign-in");await phase(a,"auth");
  const authCalls=states.get(a).calls;await delay(2400);assert.equal(states.get(a).calls,authCalls);await open(a);await expect(a.getByRole("button",{name:"Войти снова",exact:true})).toBeVisible();await close(a);
  states.get(a).unauth=false;await wake(a);await phase(a,"synced");
  // Two devices edit the same block. Nothing chooses a winner automatically.
  states.get(a).offline=true;states.get(b).offline=true;
  await edit(a,l=>l.projects[0].blocks[0].text="Version A");await edit(b,l=>l.projects[0].blocks[0].text="Version B");
  await phase(a,"retry");await phase(b,"retry");states.get(a).offline=false;await wake(a);await phase(a,"synced");states.get(b).offline=false;await wake(b);await phase(b,"conflict");
  const conflictCalls=states.get(b).calls;await delay(2400);assert.equal(states.get(b).calls,conflictCalls);assert.equal((await library(b)).projects[0].blocks[0].text,"Version B");
  await open(b);await b.locator("[data-conflict-key]").getByRole("button",{name:/На этом устройстве/}).click();await b.getByRole("button",{name:"Применить выбранные варианты",exact:true}).click();await phase(b,"synced");await close(b);
  // Same browser, second tab: the exclusive lock prevents overlapping requests.
  await wake(a);await phase(a,"synced");
  const second=await a.context().newPage();await second.goto(origin);await phase(second,"synced");
  states.get(a).maxActive=0;let unlock;states.get(a).hold=new Promise(r=>unlock=r);let startRead;const inRead=new Promise(r=>startRead=r);states.get(a).entered=startRead;
  await wake(a);await Promise.race([inRead,delay(15000).then(()=>{throw new Error("Tab read did not start");})]);await wake(second);await delay(600);assert.equal(states.get(a).maxActive,1,"One tab owns the sync lock");states.get(a).hold=null;unlock();await phase(a,"synced");await phase(second,"synced");
  // Periodic polling discovers remote changes without a focus event.
  await second.close();await edit(a,l=>l.projects[0].description="Periodic pull");await phase(a,"synced");
  await expect.poll(()=>readDescription(b),{timeout:27000,intervals:[500]}).toBe("Periodic pull");

  // Browsers without Web Locks use the same transactional IndexedDB lease across tabs.
  const fallback=await browser.newContext();contexts.push(fallback);
  await fallback.addInitScript(()=>Object.defineProperty(navigator,"locks",{value:undefined}));
  const first=await fallback.newPage(),other=await fallback.newPage();await first.goto(origin);await other.goto(origin);
  const modules=new Set(["sync-lock","local-database","i18n","translations"]);
  await fallback.route("**/__lock_fixture__/*.js",async route=>{
    const name=new URL(route.request().url()).pathname.split("/").pop().replace(/\.js$/,"");if(!modules.has(name))return route.abort();
    const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),"utf8");
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from "\.\/([\w-]+)"/g,'from "./$1.js"');
    await route.fulfill({contentType:"text/javascript",body:code});
  });
  await first.evaluate(async()=>{const {withSyncLock}=await import("/__lock_fixture__/sync-lock.js");window.entered=false;window.holding=withSyncLock(async valid=>{window.entered=true;window.isValid=valid;await new Promise(r=>window.release=r);});});
  await expect.poll(()=>first.evaluate(()=>window.entered)).toBe(true);
  assert.equal(await other.evaluate(async()=>{const {withSyncLock}=await import("/__lock_fixture__/sync-lock.js");return withSyncLock(async()=>{throw new Error("Overlapping lease");});}),false);
  await first.evaluate(async()=>{window.release();await window.holding;});
  assert.equal(await other.evaluate(async()=>{const {withSyncLock}=await import("/__lock_fixture__/sync-lock.js");return withSyncLock(async valid=>{if(!valid())throw new Error("Invalid lease");});}),true);
  // A crashed tab's expired lease is recoverable, and a replaced lease invalidates its old owner.
  await first.evaluate(async()=>{const {transaction}=await import("/__lock_fixture__/local-database.js");await transaction(["meta"],"readwrite",async tx=>{tx.objectStore("meta").put({owner:"crashed",expires:Date.now()-1},"sync-lease");});});
  assert.equal(await other.evaluate(async()=>{const {withSyncLock}=await import("/__lock_fixture__/sync-lock.js");return withSyncLock(async()=>{});}),true);
  await first.clock.install();
  await first.evaluate(async()=>{const {withSyncLock}=await import("/__lock_fixture__/sync-lock.js");window.release=null;window.holding=withSyncLock(async valid=>{window.isValid=valid;await new Promise(r=>window.release=r);});});
  await expect.poll(()=>first.evaluate(()=>typeof window.release)).toBe("function");
  await other.evaluate(async()=>{const {transaction}=await import("/__lock_fixture__/local-database.js");await transaction(["meta"],"readwrite",async tx=>{tx.objectStore("meta").put({owner:"replacement",expires:Date.now()+180000},"sync-lease");});});
  await first.clock.runFor(10050);await expect.poll(()=>first.evaluate(()=>window.isValid())).toBe(false);await first.evaluate(async()=>{window.release();await window.holding;});
  for(const page of [a,b])assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const context of contexts)await context.close();fixture.storage.client.destroy();
  console.log("Automatic sync checks passed: one-time setup, UI save, startup pull, debounce, retry/online, draft protection, auth pause, conflicts, cross-tab lock and fallback lease recovery, no feedback loop, route preservation and periodic mobile pull.");
} finally {
  if(browser)await browser.close();server.kill();await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once("exit",resolve);});
}
