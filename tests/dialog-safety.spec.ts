import {test,expect} from "@playwright/test";

test("creation dialogs remain open when the backdrop is clicked",async({page})=>{
  await page.goto("/");
  for(const kind of ["section","idea"]) {
    if(kind==="section")await page.getByRole("button",{name:"Создать раздел",exact:true}).last().click();
    else await page.locator(".page-action-button").click();
    const dialog=page.getByRole("dialog");await expect(dialog).toBeVisible();
    await dialog.getByLabel("Название",{exact:true}).fill(`Unsaved ${kind}`);
    await dialog.getByLabel(/Описание|Краткое описание/i).fill("Do not close this dialog");
    await page.mouse.click(2,2);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Название",{exact:true})).toHaveValue(`Unsaved ${kind}`);
    await expect(dialog.getByLabel(/Описание|Краткое описание/i)).toHaveValue("Do not close this dialog");
    await dialog.getByRole("button",{name:"Отмена",exact:true}).click();await expect(dialog).toHaveCount(0);
  }
});
