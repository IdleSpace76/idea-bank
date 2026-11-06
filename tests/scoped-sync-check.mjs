import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {setTimeout as delay} from "node:timers/promises";
import {chromium,expect} from "@playwright/test";
import {encode} from "next-auth/jwt";
import {memoryStorage,schema} from "./entity-fixture.mjs";
const {entityKey,flattenLibrary}=schema,fixture=memoryStorage();
const library={version:1,sections:[{id:"s",name:"Section",description:"",icon:"folder"}],projects:[
  {id:"a",sectionId:"s",name:"Idea A",description:"Base",cover:"forest",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"one",heading:"One",text:"First"},{id:"two",heading:"Two",text:"Second"}]},
  {id:"b",sectionId:"s",name:"Closed idea",description:"Not opened",cover:"orbit",updatedAt:"2026-01-01T00:00:00Z",blocks:[{id:"secret",heading:"Closed",text:"Never download me"}]}
]};
await fixture.entities().save({operationId:randomUUID(),heads:[],changes:Object.entries(flattenLibrary(library)).map(([key,value])=>({key,value,base:[]}))});
const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`,secret="scoped-synthetic-session-secret-at-least-32-characters";
const server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,IDEA_BANK_AUTH_MODE:"github",AUTH_URL:origin,AUTH_SECRET:secret,AUTH_GITHUB_ID:"fixture",AUTH_GITHUB_SECRET:"fixture",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:"https://s3.eu-central-003.backblazeb2.com",B2_REGION:"eu-central-003",B2_BUCKET_NAME:"fixture-bucket",B2_KEY_ID:"fixture",B2_APPLICATION_KEY:"fixture",ABLY_API_KEY:""}});
server.stdout.resume();server.stderr.resume();let browser;
const sockets=new Set(),channel="idea-bank:sync:"+"a".repeat(64);let serial=0;
const broadcast=(revision,keys=[])=>{for(const socket of sockets)if(socket.attached)socket.ws.send(JSON.stringify({action:15,channel,messages:[{name:"library-changed",data:{version:2,revision,keys},id:`scoped:${serial++}:0`,timestamp:Date.now()}]}));};
const calls=[],batches=[],errors=[],packets=[];
async function scopedState(){return fixture.entities().readScoped({kind:"idea",id:"a"});}
const blockText=async id=>(await scopedState()).records.find(record=>record.key===entityKey("block","a",id)).value?.text;
try {
  for(let n=0;;n++){try{await fetch(origin);break;}catch{if(n>100||server.exitCode!==null)throw new Error("Fixture did not start");await delay(100);}}
  browser=await chromium.launch({channel:"msedge",headless:true});
  const cookie="authjs.session-token",token=await encode({secret,salt:cookie,token:{sub:"12345",name:"Scoped fixture"},maxAge:1800});
  async function device(viewport){
    const context=await browser.newContext({viewport});await context.addCookies([{name:cookie,value:token,url:origin,httpOnly:true,sameSite:"Lax"}]);await context.addInitScript(()=>localStorage.setItem("idea-bank.language","ru"));
    const state={offline:false,drop:false,hold:null,entered:null};
    await context.routeWebSocket(/.*/,ws=>{
      const socket={ws,attached:false};sockets.add(socket);ws.onClose(()=>sockets.delete(socket));
      ws.onMessage(raw=>{const frames=JSON.parse(String(raw));for(const frame of Array.isArray(frames)?frames:[frames]){
        if(frame.action===10){socket.attached=true;ws.send(JSON.stringify({action:11,channel:frame.channel}));}
        if(frame.action===12){socket.attached=false;ws.send(JSON.stringify({action:13,channel:frame.channel}));}
        if(frame.action===5){sockets.delete(socket);ws.send(JSON.stringify({action:7}));ws.close();}
        if(frame.action===0)ws.send(JSON.stringify({action:0}));
      }});
      ws.send(JSON.stringify({action:4,connectionId:randomUUID(),connectionKey:randomUUID(),connectionDetails:{connectionStateTtl:120000,maxIdleInterval:3600000}}));
    });
    await context.route("**/api/**",async route=>{
      const request=route.request(),url=new URL(request.url());calls.push({url:url.pathname,method:request.method(),state});
      if(state.offline)return route.abort("failed");
      const reply=(value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
      try{
        if(url.pathname==="/api/sync/events/token")return reply({enabled:true,channel,token:"synthetic",expiresAt:Date.now()+900000});
        if(url.pathname==="/api/reader/batch"){const input=request.postDataJSON(),value=await fixture.entities().readReaderBatch(input);packets.push({state,input,value});return reply(value);}
        if(url.pathname==="/api/catalog")return reply(await fixture.entities().catalog().readPage({limit:Number(url.searchParams.get("limit") || 24),cursor:url.searchParams.get("cursor") || undefined,sectionId:url.searchParams.get("sectionId") || undefined,query:url.searchParams.get("q") || undefined}));
        if(url.pathname.startsWith("/api/ideas/")){
          const result=await fixture.entities().catalog().readIdea(decodeURIComponent(url.pathname.split("/").pop()),request.headers()["if-none-match"]?.replaceAll('"',""));
          return result.notModified?route.fulfill({status:304,body:""}):reply(result);
        }
        if(url.pathname==="/api/sync/scoped"){
          const body=request.postDataJSON();
          if(request.method()==="POST"){
            const read=await fixture.entities().readScoped(body.target,body.includeIdeas,body.includeMedia);
            if(body.target.kind==="idea" && body.target.id==="a")assert.ok(!read.records.some(record=>schema.keyParts(record.key).kind==="block" && schema.keyParts(record.key).ids[0]==="b"));
            return reply(read);
          }
          batches.push(body);const result=await fixture.entities().save(body);broadcast(result.revision,body.changes.map(change=>change.key));
          if(state.hold){state.entered?.();await state.hold;state.hold=null;}
          if(state.drop){state.drop=false;return route.abort("failed");}
          return reply(result);
        }
        throw new Error(`Unexpected full-library request: ${url.pathname}`);
      }catch(error){return reply({error:{code:error.code,message:error.message}},error.status || 502);}
    });
    const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));await page.goto(origin+"/#/project/a");await expect(page.getByRole("heading",{name:"One",exact:true})).toBeVisible();return {page,context,state};
  }
  const a=await device({width:1440,height:1000}),b=await device({width:390,height:844});
  await expect.poll(()=>[...sockets].filter(socket=>socket.attached).length).toBe(2);
  const phase=(page,value)=>expect(page.locator(".local-status")).toHaveAttribute("data-sync-phase",value,{timeout:15000});
  const edit=async page=>{await page.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();await expect(page.locator("#project-editor")).toBeVisible();};
  const save=page=>page.getByRole("button",{name:"Сохранить идею",exact:true}).click();
  const setOffline=async(device,value)=>{device.state.offline=value;await device.page.evaluate(value=>{Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>!value});window.dispatchEvent(new Event(value?"offline":"online"));},value);};
  await a.page.getByRole("button",{name:"Изменить",exact:true}).click();await a.page.getByLabel("Краткое описание",{exact:false}).fill("Live description");await a.page.getByRole("dialog").getByRole("button",{name:"Сохранить",exact:true}).click();
  await expect(b.page.locator(".page-subtitle")).toHaveText("Live description");
  assert.equal(calls.filter(call=>call.url==="/api/ideas/b").length,0);
  await edit(b.page);await b.page.getByLabel("Заголовок блока",{exact:true}).first().fill("Unsaved heading");
  await edit(a.page);await a.page.getByLabel("Текст",{exact:true}).nth(1).fill("Incoming second block");await save(a.page);
  await expect.poll(()=>blockText("two")).toBe("Incoming second block");await delay(600);
  await expect(b.page.getByLabel("Заголовок блока",{exact:true}).first()).toHaveValue("Unsaved heading");
  await expect(b.page.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");
  await b.page.reload();await b.page.getByRole("button",{name:"Восстановить черновик",exact:true}).click();
  const recovery=b.page.getByRole("dialog",{name:"Идея изменилась после создания черновика",exact:true});
  await expect(recovery).toContainText("Incoming second block");await recovery.getByRole("button",{name:"Восстановить черновик",exact:true}).click();
  await expect(b.page.getByLabel("Заголовок блока",{exact:true}).first()).toHaveValue("Unsaved heading");
  assert.equal(await blockText("two"),"Incoming second block","Recovering a draft never writes to the cloud");
  b.page.once("dialog",dialog=>dialog.accept());await b.page.getByRole("button",{name:"Отмена",exact:true}).click();await expect(b.page.getByText("Incoming second block",{exact:true})).toBeVisible();
  // Prepare both base versions online, then save independent edits while offline.
  await edit(a.page);await edit(b.page);await setOffline(a,true);await setOffline(b,true);
  await a.page.getByLabel("Текст",{exact:true}).first().fill("Offline first");await b.page.getByLabel("Текст",{exact:true}).nth(1).fill("Offline second");await save(a.page);await save(b.page);
  await b.page.reload();await setOffline(b,true);await expect(b.page.getByText("Offline second",{exact:true})).toBeVisible();
  await setOffline(a,false);await expect.poll(()=>blockText("one")).toBe("Offline first");await phase(a.page,"synced");
  await setOffline(b,false);await expect.poll(()=>blockText("two")).toBe("Offline second");await phase(b.page,"synced");
  await expect(a.page.getByText("Offline second",{exact:true})).toBeVisible();assert.equal(await blockText("one"),"Offline first");
  // Same-field edits require an explicit owner choice.
  await edit(a.page);await edit(b.page);await setOffline(a,true);await setOffline(b,true);
  await a.page.getByLabel("Текст",{exact:true}).first().fill("Left version");await b.page.getByLabel("Текст",{exact:true}).first().fill("Right version");await save(a.page);await save(b.page);
  await setOffline(a,false);await expect.poll(()=>blockText("one")).toBe("Left version");await phase(a.page,"synced");await setOffline(b,false);await phase(b.page,"conflict");
  await b.page.locator(".local-status").click();await b.page.locator("[data-conflict-key]").getByRole("button",{name:/На этом устройстве/}).click();await b.page.getByRole("button",{name:"Применить выбранные варианты",exact:true}).click();
  await expect.poll(()=>blockText("one")).toBe("Right version");await phase(b.page,"synced");await b.page.getByRole("button",{name:"Понятно",exact:true}).click();
  // A lost response retries the exact persisted operation.
  await a.page.getByRole("button",{name:"Изменить",exact:true}).click();await a.page.getByLabel("Краткое описание",{exact:false}).fill("Lost response");a.state.drop=true;const before=batches.length;
  await a.page.getByRole("dialog").getByRole("button",{name:"Сохранить",exact:true}).click();
  await expect.poll(()=>batches.length,{timeout:15000}).toBeGreaterThan(before+1);assert.equal(batches[before].operationId,batches[before+1].operationId);await phase(a.page,"synced");
  // A second edit during an in-flight upload cannot be acknowledged by the first upload.
  await a.page.getByRole("button",{name:"Изменить",exact:true}).click();await a.page.getByLabel("Краткое описание",{exact:false}).fill("In flight");
  let release,entered;a.state.hold=new Promise(resolve=>release=resolve);const waiting=new Promise(resolve=>entered=resolve);a.state.entered=entered;
  await a.page.getByRole("dialog").getByRole("button",{name:"Сохранить",exact:true}).click();await waiting;
  await a.page.getByRole("button",{name:"Изменить",exact:true}).click();await a.page.getByLabel("Краткое описание",{exact:false}).fill("New generation");release();
  await a.page.getByRole("dialog").getByRole("button",{name:"Сохранить",exact:true}).click();
  await expect(b.page.locator(".page-subtitle")).toHaveText("New generation",{timeout:20000});await phase(a.page,"synced");
  await delay(800);const stable=calls.length;await delay(2700);assert.equal(calls.length,stable,"Healthy notifications do not poll constantly");
  // Missing broker messages are recovered by the same incremental checkpoint request.
  const missingBase=await fixture.entities().catalogIndex(),missingKey=entityKey("block","a","two");
  await fixture.entities().save({operationId:randomUUID(),heads:missingBase.heads,changes:[{key:missingKey,base:missingBase.index[missingKey],value:{...library.projects[0].blocks[1],text:"Missed notification recovered"}}]});
  const beforeRecovery=packets.filter(packet=>packet.state===b.state).length;
  await b.page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await expect(b.page.getByText("Missed notification recovered",{exact:true})).toBeVisible();
  assert.equal(packets.filter(packet=>packet.state===b.state).length,beforeRecovery+1,"Reconnect recovers a missed event in one packet");
  const recovered=packets.filter(packet=>packet.state===b.state).at(-1).value;
  assert.equal(recovered.pages.length,0);assert.equal(recovered.bodies.length,0);
  assert.ok(!JSON.stringify(recovered).includes("Never download me"));
  // A newly created idea changes the other device's count without fetching its body.
  await a.page.locator(".breadcrumbs button").first().click();await a.page.locator(".page-action-button").click();
  await a.page.getByRole("dialog").getByLabel("Название",{exact:true}).fill("Metadata-only incoming idea");
  await a.page.getByRole("dialog").getByRole("button",{name:"Создать идею",exact:true}).click();
  const createdId=decodeURIComponent(new URL(a.page.url()).hash.split("/").pop());
  await expect(b.page.locator(".sidebar .nav-item").filter({hasText:"Section"}).locator("small")).toHaveText("3");
  assert.ok(!packets.some(packet=>packet.state===b.state && packet.input.bodies?.includes(createdId)),"Incoming new ideas are metadata-only until opened");
  await a.page.getByRole("button",{name:"Действия с идеей",exact:true}).click();await a.page.getByRole("menuitem",{name:"Удалить идею",exact:true}).click();
  await a.page.getByRole("dialog").getByRole("button",{name:"Удалить идею",exact:true}).click();
  await expect(b.page.locator(".sidebar .nav-item").filter({hasText:"Section"}).locator("small")).toHaveText("2");
  assert.equal(calls.filter(call=>call.url==="/api/sync").length,0);assert.equal(calls.filter(call=>call.url==="/api/ideas/b").length,0);
  assert.ok(!batches.some(batch=>batch.changes.some(change=>schema.keyParts(change.key).ids[0]==="b")),"Closed ideas are never rewritten");
  assert.equal(errors.length,0,errors.join("\n"));for(const device of [a,b]){assert.ok(await device.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await device.context.close();}
  console.log("Scoped sync checks passed: real Ably SDK events, two devices, no full snapshots, closed-body isolation, draft protection, offline merging, explicit conflicts, lost responses, queue generations and no frequent polling.");
}finally{if(browser)await browser.close();server.kill("SIGKILL");await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once("exit",resolve);});fixture.storage.client.destroy();}
