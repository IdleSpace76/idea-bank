// Production Next server, loopback only, temporary SQLite and fresh browser profiles.
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,readdir,rm,stat} from "node:fs/promises";
import {unzipSync} from "fflate";
import {createServer} from "node:net";
import {request as httpRequest} from "node:http";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {chromium,expect} from "@playwright/test";

const workspace=fileURLToPath(new URL("../",import.meta.url)),cache=path.join(workspace,".cache");await mkdir(cache,{recursive:true});
const directory=await mkdtemp(path.join(cache,"disk-api-check-")),data=path.join(directory,"data");
const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;let server,browser,lastPage;const logs=[],errors=[],calls=[];
const dataCalls=()=>calls.filter(call=>!call.path.startsWith("/api/local/media/")).length;
async function start(mode="local",folder=data){
  server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{cwd:workspace,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,VERCEL:"",IDEA_BANK_AUTH_MODE:mode,IDEA_BANK_DATA_DIR:folder,AUTH_URL:origin,AUTH_SECRET:"disk-test-secret-at-least-thirty-two-characters",AUTH_GITHUB_ID:"fixture",AUTH_GITHUB_SECRET:"fixture",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:"",B2_REGION:"",B2_BUCKET_NAME:"",B2_KEY_ID:"",B2_APPLICATION_KEY:"",ABLY_API_KEY:""}});
  server.stdout.on("data",line=>logs.push(String(line)));server.stderr.on("data",line=>logs.push(String(line)));
  for(let n=0;;n++){try{await fetch(origin);break;}catch{if(n>100 || server.exitCode!==null)throw new Error("Disk fixture server did not start");await delay(100);}}
}
async function stop(){if(!server)return;const process=server;server=null;process.kill("SIGTERM");await new Promise(resolve=>{if(process.exitCode!==null)resolve();else process.once("exit",resolve);});}
async function get(url){const response=await fetch(origin+url);assert.equal(response.status,200,await response.clone().text());return response.json();}
async function action(url,body,method="POST"){const response=await fetch(origin+url,{method,headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});return response;}
function request(patch,revision){return {operationId:randomUUID(),revision,patch:{sections:[],ideas:[],deleteSections:[],deleteIdeas:[],...patch}};}
async function write(body,files=[]){
  let init={method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)};
  if(files.length){const form=new FormData();form.set("manifest",JSON.stringify(body));for(const file of files)form.set(`file:${file.id}`,new Blob([file.data],{type:file.mime}),"file");init={method:"POST",headers:{Origin:origin},body:form};}
  return fetch(`${origin}/api/local/library`,init);
}
const section={id:"s",name:"API section",description:"",icon:"book"},png=await readFile(path.join(workspace,"public","examples","little-robot.png"));
const model=await readFile(path.join(workspace,"public","examples","little-robot.glb"));
const idea={id:"api-idea",sectionId:"s",name:"Disk idea",description:"Local description",cover:"forest",updatedAt:"2026-11-08T12:00:00Z",blocks:[{id:"block",heading:"Stored block",text:"Body on disk",width:"half",media:[{id:"image",name:"robot.png",kind:"image",mime:"image/png",size:png.length}]}]};
try{
  await start();
  for(const init of [{headers:{Origin:"https://other.example"}},{headers:{"Sec-Fetch-Site":"cross-site"}}])assert.equal((await fetch(`${origin}/api/local/library?state=1`,init)).status,403,JSON.stringify(init));
  const rebinding=await new Promise((resolve,reject)=>{const request=httpRequest({hostname:"127.0.0.1",port,path:"/api/local/library?state=1",headers:{Host:`evil.example:${port}`}},response=>{response.resume();resolve(response.statusCode);});request.on("error",reject);request.end();});assert.equal(rebinding,403);
  assert.equal((await fetch(`${origin}/api/local/library`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,403);
  await assert.rejects(stat(data),error=>error.code==="ENOENT");
  assert.deepEqual(await get("/api/local/library?state=1"),{revision:0,initialized:false});
  const first=request({sections:[section],ideas:[{idea,blocks:true,create:true}]},0),response=await write(first,[{id:"image",data:png,mime:"image/png"}]);
  assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.page.total,1);assert.equal(result.page.counts.s,1);
  assert.ok(!Object.hasOwn(result.page.ideas[0],"blocks"));
  assert.deepEqual((await get("/api/local/ideas/api-idea")).idea,idea);
  assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/local/media/image`)).arrayBuffer()),png);
  const range=await fetch(`${origin}/api/local/media/image`,{headers:{Range:"bytes=2-8"}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),png.subarray(2,9));
  const head=await fetch(`${origin}/api/local/media/image`,{method:"HEAD"});assert.equal(Number(head.headers.get("content-length")),png.length);assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal((await fetch(`${origin}/api/local/media/image`,{headers:{Range:"bytes=999999-"}})).status,416);
  const edit=request({ideas:[{idea:{...idea,name:"Renamed on disk",blocks:[]},base:{...idea,blocks:[]},blocks:false,create:false}]},1);
  assert.equal((await write(edit)).status,200);assert.equal((await get("/api/local/ideas/api-idea")).idea.blocks.length,1);
  assert.equal((await write(first,[{id:"image",data:png,mime:"image/png"}])).status,200);assert.equal((await get("/api/local/library?state=1")).revision,2);
  assert.equal((await write({...edit,patch:{...edit.patch,deleteIdeas:["api-idea"]}})).status,400);
  assert.equal((await write(request({deleteIdeas:["api-idea"]},1))).status,409);
  const staleBody=request({ideas:[{idea:{...idea,name:"Must not overwrite",blocks:[]},base:{...idea,blocks:[]},blocks:false,create:false}]},2);assert.equal((await write(staleBody)).status,409,"Even a fresh catalog revision cannot authorize an edit based on stale idea data");
  const missing=request({ideas:[{idea:{...idea,id:"missing",blocks:[{...idea.blocks[0],media:[{...idea.blocks[0].media[0],id:"missing-file"}]}]},blocks:true,create:true}]},2);
  assert.equal((await write(missing)).status,400);assert.equal((await get("/api/local/library?state=1")).revision,2);
  await stop();await start();assert.equal((await write(edit)).status,200);assert.equal((await get("/api/local/library?state=1")).revision,2);
  console.log("Disk API: loopback/origin gates before filesystem access, SQL persistence, metadata patches, media/range/HEAD, stale writes, missing files and durable replay passed.");

  browser=await chromium.launch({channel:"msedge",headless:true});
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}});await context.addInitScript(()=>localStorage.setItem("idea-bank.language","ru"));
    const page=await context.newPage();lastPage=page;page.on("pageerror",error=>errors.push(error.message));page.on("request",request=>{const url=new URL(request.url());if(url.pathname.startsWith("/api/"))calls.push({path:url.pathname,query:url.search,method:request.method()});});
    let tracking="",dropNext=false;const attempts={creation:[],metadata:[]};
    if(width===1440)await context.route("**/api/local/library",async route=>{if(route.request().method()==="POST" && tracking){attempts[tracking].push(route.request().postDataJSON().operationId);if(dropNext){dropNext=false;await route.fetch();return route.abort("failed");}}return route.continue();});
    await page.goto(origin);await expect(page.locator(width<600?".recent-project strong":".project-card strong").filter({hasText:"Renamed on disk"})).toBeVisible();
    const formsStart=dataCalls();
    await page.locator(".new-section-card").click();
    let dialog=page.getByRole("dialog");await dialog.getByLabel("Название",{exact:true}).fill(`UI section ${width}`);
    await page.mouse.click(1,1);await expect(dialog).toBeVisible();assert.equal(dataCalls(),formsStart,"Opening and filling a section form makes no data API call");
    await dialog.getByRole("button",{name:"Создать раздел",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(page.locator(".section-card").filter({hasText:`UI section ${width}`})).toContainText("Идей: 0");
    const creationStart=dataCalls();await page.getByRole("button",{name:"Идея",exact:true}).click();dialog=page.getByRole("dialog");
    await dialog.getByLabel("Название",{exact:true}).fill(`UI idea ${width}`);await dialog.getByLabel("Раздел",{exact:true}).selectOption({label:`UI section ${width}`});
    assert.equal(dataCalls(),creationStart,"Idea form uses the already loaded sections");
    if(width===1440){tracking="creation";dropNext=true;await dialog.getByRole("button",{name:"Создать идею",exact:true}).click();await expect(dialog.locator(".media-save-error")).toBeVisible();}
    await dialog.getByRole("button",{name:"Создать идею",exact:true}).click();await expect(page.getByRole("heading",{name:`UI idea ${width}`,exact:true})).toBeVisible();
    if(width===1440){tracking="";assert.equal(attempts.creation.length,2);assert.equal(attempts.creation[0],attempts.creation[1],"New idea retries use one operation and never create a duplicate");}
    const id=decodeURIComponent(new URL(page.url()).hash.split("/").pop());
    const sectionId=(await get(`/api/local/ideas/${id}`)).idea.sectionId;assert.equal((await get("/api/local/catalog")).counts[sectionId],1);
    await page.getByRole("button",{name:"Добавить блок",exact:true}).click();await page.getByLabel("Заголовок блока",{exact:true}).fill(`UI heading ${width}`);
    await page.locator(".tiptap").fill(`UI body ${width}`);
    await page.getByLabel("Медиа блока 1",{exact:true}).setInputFiles({name:"robot.png",mimeType:"image/png",buffer:png});
    await page.getByRole("button",{name:"Сохранить идею",exact:true}).click();await expect(page.locator("#project-editor")).toHaveCount(0);
    await expect(page.getByRole("heading",{name:`UI heading ${width}`,exact:true})).toBeVisible();
    const saved=(await get(`/api/local/ideas/${id}`)).idea;assert.equal(saved.blocks[0].text,`UI body ${width}`);assert.equal(saved.blocks[0].media.length,1);
    const reads=dataCalls();await page.getByRole("button",{name:"Изменить",exact:true}).click();dialog=page.getByRole("dialog");
    await dialog.getByLabel("Название",{exact:true}).fill(`Renamed UI ${width}`);assert.equal(dataCalls(),reads,"Opening metadata editing makes no data request");
    if(width===1440){tracking="metadata";dropNext=true;await dialog.getByRole("button",{name:"Сохранить",exact:true}).click();await expect(dialog.locator(".media-save-error")).toBeVisible();}
    await dialog.getByRole("button",{name:"Сохранить",exact:true}).click();await expect(page.getByRole("heading",{name:`Renamed UI ${width}`,exact:true})).toBeVisible();
    if(width===1440){tracking="";assert.equal(attempts.metadata.length,2);assert.equal(attempts.metadata[0],attempts.metadata[1],"A lost response retries the same durable operation");}
    assert.deepEqual((await get(`/api/local/ideas/${id}`)).idea.blocks,saved.blocks);
    assert.equal(calls.filter(call=>call.path==="/api/local/library" && call.method==="GET" && !call.query).length,0,"Ordinary browsing/editing never downloads a full snapshot");
    const restored=await browser.newContext({viewport:{width,height:1000}});await restored.addInitScript(()=>localStorage.setItem("idea-bank.language","ru"));const fresh=await restored.newPage();lastPage=fresh;
    await fresh.goto(`${origin}/#/project/${id}`);await expect(fresh.getByRole("heading",{name:`Renamed UI ${width}`,exact:true})).toBeVisible();await expect(fresh.getByRole("heading",{name:`UI heading ${width}`,exact:true})).toBeVisible();
    await context.close();
    await fresh.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();await fresh.getByLabel("Заголовок блока",{exact:true}).fill(`Recovered draft ${width}`);
    await fresh.getByLabel("Медиа блока 1",{exact:true}).setInputFiles([{name:"draft-picture.png",mimeType:"image/png",buffer:png},{name:"draft-model.glb",mimeType:"application/octet-stream",buffer:model}]);
    await expect(fresh.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");
    const contextBefore=await get(`/api/local/drafts/${id}`);assert.equal(contextBefore.draft.project.blocks[0].heading,`Recovered draft ${width}`);
    assert.ok(contextBefore.draft.project.blocks[0].media.some(asset=>asset.kind==="model" && asset.mime==="model/gltf-binary"));
    assert.equal((await fresh.evaluate(()=>indexedDB.databases())).some(db=>db.name==="idea-bank.local"),false,"Local drafts do not open the browser library database");
    fresh.on("dialog",dialog=>dialog.accept());await stop();await start();await fresh.reload();
    await expect(fresh.getByRole("button",{name:"Восстановить черновик",exact:true})).toBeVisible();await fresh.getByRole("button",{name:"Восстановить черновик",exact:true}).click();
    await expect(fresh.getByLabel("Заголовок блока",{exact:true})).toHaveValue(`Recovered draft ${width}`);
    await fresh.getByRole("button",{name:"Сохранить идею",exact:true}).click();await expect(fresh.locator("#project-editor")).toHaveCount(0);
    assert.equal((await get(`/api/local/drafts/${id}`)).draft,null,"Saving an idea settles its draft");
    await fresh.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();await fresh.getByLabel("Заголовок блока",{exact:true}).fill(`Discarded ${width}`);
    await expect(fresh.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");await fresh.locator(".editor-actions").getByRole("button",{name:"Отмена",exact:true}).click();
    await expect(fresh.locator("#project-editor")).toHaveCount(0);assert.equal((await get(`/api/local/drafts/${id}`)).draft,null);
    await expect(fresh.getByRole("heading",{name:`Recovered draft ${width}`,exact:true})).toBeVisible();
    if(width===1440){
      await fresh.getByRole("button",{name:"На этом устройстве",exact:true}).click();let backupDialog=fresh.getByRole("dialog",{name:"Где хранятся идеи",exact:true});
      const download=await Promise.all([fresh.waitForEvent("download"),backupDialog.getByRole("button",{name:"Экспортировать ZIP",exact:true}).click()]);
      const zip=await readFile(await download[0].path()),entries=unzipSync(zip);assert.ok(entries["library.json"]);const exported=JSON.parse(Buffer.from(entries["library.json"]).toString("utf8"));
      assert.equal(exported.projects.find(row=>row.id===id).blocks[0].heading,`Recovered draft ${width}`);
      const current=(await get(`/api/local/ideas/${id}`)).idea,changed=structuredClone(current);changed.blocks[0].heading="Changed after export";
      assert.equal((await write(request({ideas:[{idea:changed,base:current,blocks:true,create:false}]},(await get("/api/local/library?state=1")).revision))).status,200);
      await backupDialog.getByLabel("Выбрать архив библиотеки",{exact:true}).setInputFiles({name:"saved.zip",mimeType:"application/zip",buffer:zip});
      await backupDialog.getByRole("button",{name:"Сохранить обе",exact:true}).click();await backupDialog.getByRole("button",{name:"Импортировать идеи",exact:true}).click();await expect(backupDialog).toHaveCount(0);
      const merged=(await get("/api/local/library")).library;assert.equal(merged.projects.find(row=>row.id===id).blocks[0].heading,"Changed after export");
      assert.ok(merged.projects.some(row=>row.id!==id && row.name===`Renamed UI ${width} imported` && row.blocks[0].heading===`Recovered draft ${width}`));
      const copy=merged.projects.find(row=>row.name===`Renamed UI ${width} imported`);assert.equal(copy.blocks[0].media.length,3);assert.equal(new Set(copy.blocks[0].media.map(asset=>asset.id)).size,3);
      await fresh.getByRole("button",{name:"На этом устройстве",exact:true}).click();backupDialog=fresh.getByRole("dialog",{name:"Где хранятся идеи",exact:true});
      await backupDialog.getByRole("button",{name:"Загрузить Example",exact:true}).click();await expect(backupDialog).toHaveCount(0);
      assert.equal((await get("/api/local/catalog")).ideas.filter(row=>row.id==="example").length,1);
      const revision=(await get("/api/local/library?state=1")).revision;
      await fresh.getByRole("button",{name:"На этом устройстве",exact:true}).click();backupDialog=fresh.getByRole("dialog",{name:"Где хранятся идеи",exact:true});await backupDialog.getByRole("button",{name:"Загрузить Example",exact:true}).click();
      await expect(backupDialog.locator(".backup-status")).toHaveText("Example уже есть в библиотеке.");assert.equal((await get("/api/local/library?state=1")).revision,revision);await backupDialog.getByRole("button",{name:"Понятно",exact:true}).click();
    }
    await restored.close();console.log(`Disk UI ${width}px: CRUD, persistent drafts/files after server restart, restore/save/discard, fresh browser profile and no browser library writes passed.`);
  }
  assert.equal(calls.filter(call=>!call.path.startsWith("/api/local/")).length,0,"Local mode never calls cloud/auth endpoints");assert.deepEqual(errors,[]);
  const cleanup=await browser.newContext();await cleanup.addInitScript(()=>localStorage.setItem("idea-bank.language","ru"));const page=await cleanup.newPage();lastPage=page;
  await page.goto(origin);await expect(page.locator(".section-card").first()).toBeVisible();
  const oldIdea=(await get("/api/local/ideas/api-idea")).idea,oldDraft=await get("/api/local/drafts/api-idea");
  await page.getByRole("button",{name:"На этом устройстве",exact:true}).click();const storage=page.getByRole("dialog",{name:"Где хранятся идеи",exact:true});
  const resetCalls=[];page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/local/"))resetCalls.push({url:request.url(),method:request.method()});});
  await storage.getByRole("button",{name:"Очистить голову",exact:true}).click();const confirm=page.getByRole("dialog",{name:"Очистить голову?",exact:true});await expect(confirm).toBeVisible();assert.equal(resetCalls.length,0,"Reset confirmation does not prepare or download media");
  await confirm.getByRole("button",{name:"Очистить голову",exact:true}).click();await expect(storage).toHaveCount(0);
  assert.deepEqual((await get("/api/local/library")).library,{version:1,sections:[],projects:[]});
  assert.equal((await action("/api/local/drafts/api-idea",{instance:oldDraft.instance,expected:oldDraft.head,next:randomUUID(),base:oldIdea,project:oldIdea})).status,409,"Delayed drafts cannot undo a reset");
  await expect.poll(async()=> (await readdir(path.join(data,"media"))).length).toBe(0);await page.reload();await expect(page.locator(".new-section-card")).toBeVisible();await expect(page.locator(".section-card")).toHaveCount(0);assert.equal((await get("/api/local/catalog")).total,0,"An intentionally empty library never reseeds Example");
  await cleanup.close();console.log("Disk workspace: ZIP keep-both merge, Example presence check, reset without media downloads, stale draft rejection and physical cleanup passed.");
  await browser.close();browser=null;await stop();
  const cloudData=path.join(directory,"forbidden-cloud");await start("github",cloudData);
  for(const url of ["/api/local/library?state=1","/api/local/catalog","/api/local/ideas/api-idea","/api/local/media/image","/api/local/drafts/api-idea","/api/local/backup"])assert.equal((await fetch(origin+url)).status,404);
  for(const url of ["/api/local/reset","/api/local/example"])assert.equal((await action(url,{})).status,404);
  await assert.rejects(stat(cloudData),error=>error.code==="ENOENT");console.log("Disk isolation: GitHub mode cannot open local storage; no B2, Ably or cloud sync requests in local mode.");
}catch(error){console.error("Disk fixture browser errors:",errors);console.error("Disk fixture server:",logs.slice(-8).join(""));if(lastPage && !lastPage.isClosed())console.error("Disk fixture visible alerts:",await lastPage.locator('[role="alert"],.notice,.reader-state').allTextContents());throw error;}
finally{if(browser)await browser.close();await stop();const relative=path.relative(cache,path.resolve(directory));if(!relative || relative.startsWith("..") || path.isAbsolute(relative))throw new Error("Unsafe fixture cleanup");await rm(directory,{recursive:true,force:true});}
