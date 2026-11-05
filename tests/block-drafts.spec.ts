import {test,expect} from "@playwright/test";
import {exposeLibraryStore,readStoredLibrary,setStoredLibrary} from "./local-fixture";

test("block draft survives reload with new media, stays outside the library and clears after save",async({page})=>{
  await page.goto("/#/project/example");await expect(page.getByRole("button",{name:"Редактировать блок 1",exact:true})).toBeVisible();
  const original=await page.evaluate(readStoredLibrary);
  await page.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();
  await page.getByLabel("Заголовок блока",{exact:true}).first().fill("Recovered heading");
  await page.getByLabel("Текст",{exact:true}).first().fill("My unfinished thought");
  const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=","base64");
  await page.getByLabel("Медиа блока 1",{exact:true}).setInputFiles({name:"draft-image.png",mimeType:"image/png",buffer:pixel});
  await expect(page.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");
  expect(await page.evaluate(readStoredLibrary)).toEqual(original);
  await page.reload();await expect(page.getByRole("button",{name:"Восстановить черновик",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Восстановить черновик",exact:true}).click();
  await expect(page.getByLabel("Заголовок блока",{exact:true}).first()).toHaveValue("Recovered heading");
  await expect(page.getByLabel("Текст",{exact:true}).first()).toHaveText("My unfinished thought");
  await expect(page.locator("#project-editor").getByText("draft-image.png",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Сохранить идею",exact:true}).click();await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();await expect(page.getByRole("heading",{name:"Recovered heading",exact:true})).toBeVisible();await expect(page.locator(".draft-recovery")).toHaveCount(0);
  const saved=(await page.evaluate(readStoredLibrary)).projects[0];expect(saved.blocks[0].text).toBe("My unfinished thought");expect(saved.blocks[0].media?.some(file=>file.name==="draft-image.png")).toBe(true);
});

test("cancel and explicit discard clear a draft without changing the saved idea",async({page})=>{
  await page.goto("/#/project/example");await page.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();
  const original=await page.evaluate(readStoredLibrary);
  await page.getByLabel("Заголовок блока",{exact:true}).first().fill("Cancel me");await expect(page.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");
  page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"Отмена",exact:true}).click();
  await page.reload();await expect(page.getByRole("button",{name:"Редактировать блок 1",exact:true})).toBeVisible();await expect(page.locator(".draft-recovery")).toHaveCount(0);
  await page.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();await page.getByLabel("Заголовок блока",{exact:true}).first().fill("Discard me");await expect(page.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");
  await page.reload();await page.getByRole("button",{name:"Удалить черновик",exact:true}).click();await expect(page.locator(".draft-recovery")).toHaveCount(0);expect(await page.evaluate(readStoredLibrary)).toEqual(original);
});

test("changed blocks require comparison before restoring and preserve latest idea metadata",async({page})=>{
  await page.goto("/#/project/example");await page.getByRole("button",{name:"Редактировать блок 1",exact:true}).click();
  await page.getByLabel("Заголовок блока",{exact:true}).first().fill("My draft version");await expect(page.locator(".draft-status")).toHaveText("Черновик сохранён на устройстве");
  const latest=await page.evaluate(readStoredLibrary);latest.projects[0].name="Latest title";latest.projects[0].blocks[0].heading="Changed elsewhere";
  await setStoredLibrary(page,latest);await page.reload();await page.getByRole("button",{name:"Восстановить черновик",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Идея изменилась после создания черновика",exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText("Changed elsewhere");await expect(dialog).toContainText("My draft version");
  expect(await page.evaluate(readStoredLibrary)).toEqual(latest);
  await dialog.getByRole("button",{name:"Отмена",exact:true}).click();await expect(page.locator(".draft-recovery")).toBeVisible();
  await page.getByRole("button",{name:"Восстановить черновик",exact:true}).click();await dialog.getByRole("button",{name:"Восстановить черновик",exact:true}).click();
  await expect(page.getByLabel("Заголовок блока",{exact:true}).first()).toHaveValue("My draft version");await expect(page.getByRole("heading",{name:"Latest title",exact:true})).toBeVisible();expect(await page.evaluate(readStoredLibrary)).toEqual(latest);
});

test("draft writes are atomic, scoped, protected against stale tabs and excluded from cache eviction",async({page})=>{
  await page.goto("/#/project/example");await expect(page.getByRole("button",{name:"Редактировать блок 1",exact:true})).toBeVisible();await exposeLibraryStore(page);await page.goto("/__storage_probe__");
  const result=await page.evaluate(async()=>{
    const root="/__local_fixture__/",drafts=await import(root+"block-drafts.js"),store=await import(root+"library-store.js"),cache=await import(root+"reader-cache.js");
    const library=await store.readLocalLibrary(),base=library.projects[0],project=structuredClone(base),before=await store.readOutbox();project.blocks[0].heading="Stored draft";
    const first=await drafts.writeBlockDraft("account-a",base,project,new Map(),null);let stale=false,remove=false,failed=false;
    try{await drafts.writeBlockDraft("account-a",base,project,new Map(),null);}catch{stale=true;}
    try{await drafts.removeBlockDraft("account-a",base.id,"other-revision");}catch{remove=true;}
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(String(key).startsWith("block-draft:"))throw new DOMException("Disk full","QuotaExceededError");return put.call(this,value,key);};
    try{project.blocks[0].heading="Do not commit";await drafts.writeBlockDraft("account-a",base,project,new Map(),first.revision);}catch{failed=true;}finally{IDBObjectStore.prototype.put=put;}
    for(let n=0;n<25;n++)await cache.writeReaderCache("account-a","idea",String(n),{text:"Evict me"});
    return {stale,remove,failed,first,saved:await drafts.readBlockDraft("account-a",base.id),other:await drafts.readBlockDraft("account-b",base.id),before,after:await store.readOutbox(),library,final:await store.readLocalLibrary()};
  });
  expect(result.stale&&result.remove&&result.failed).toBe(true);expect(result.saved.revision).toBe(result.first.revision);expect(result.saved.project.blocks[0].heading).toBe("Stored draft");expect(result.other).toBeUndefined();expect(result.after).toEqual(result.before);expect(result.final).toEqual(result.library);
});
