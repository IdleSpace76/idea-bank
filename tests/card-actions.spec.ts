import { expect, test } from "@playwright/test";

test("idea card actions confirm deletion and the trailing add card works on home and section", async ({ page, isMobile }) => {
  await page.goto("/");
  const homeAction = await page.getByRole("button", { name: "Идея", exact: true }).boundingBox();
  if (isMobile) await expect(page.getByRole("button", { name: "Новая идея", exact: true })).toBeHidden();
  else await expect(page.getByRole("button", { name: "Новая идея", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Действия с идеей Example", exact: true }).click();
  await page.getByRole("menuitem", { name: "Удалить идею", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(new URL(page.url()).hash).not.toContain("project");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.goto("/#/section/examples");
  await expect(page.getByRole("heading", { name: "Примеры", exact: true })).toBeVisible();
  const sectionAction = await page.getByRole("button", { name: "Идея", exact: true }).boundingBox();
  expect(sectionAction!.x).toBeCloseTo(homeAction!.x, 0);
  expect(sectionAction!.y).toBeCloseTo(homeAction!.y, 0);
  await expect(page.locator('.section-back-toolbar button[aria-haspopup="menu"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Новая идея", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Действия с идеей Example", exact: true }).click();
  await page.getByRole("menuitem", { name: "Удалить идею", exact: true }).click();
  await page.getByRole("button", { name: "Удалить идею", exact: true }).click();
  await expect(page.locator(".project-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Библиотека", exact: true }).filter({ has: page.locator("svg") }).click();
  await page.getByRole("button", { name: isMobile ? "Идея" : "Новая идея", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Идея из карточки");
  await page.getByRole("button", { name: "Создать идею", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Идея из карточки", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("card menu moves an idea and the section add button uses the current section", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Создать раздел", exact: true }).last().click();
  await page.getByLabel("Название", { exact: true }).fill("Архив");
  await page.getByRole("dialog").getByRole("button", { name: "Создать раздел", exact: true }).click();
  await page.getByRole("button", { name: "Действия с идеей Example", exact: true }).click();
  await page.getByRole("menuitem", { name: "Перенести в раздел", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Архив", exact: true }).click();
  expect(new URL(page.url()).hash).not.toContain("project");
  await page.getByRole("button", { name: "Архив Идей: 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Архив", exact: true })).toBeVisible();
  await expect(page.locator(".project-card").filter({ hasText: "Example" })).toBeVisible();
  await page.getByRole("button", { name: "Идея", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Вторая идея в архиве");
  await page.getByRole("button", { name: "Создать идею", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Вторая идея в архиве", exact: true })).toBeVisible();
  const sectionName = await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem("idea-bank.library.v1")!);
    const idea = library.projects.find((idea: { name: string }) => idea.name === "Вторая идея в архиве");
    return library.sections.find((section: { id: string }) => section.id === idea.sectionId).name;
  });
  expect(sectionName).toBe("Архив");
});
