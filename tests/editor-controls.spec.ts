import { expect, test } from "@playwright/test";
import { demoLibrary, STORAGE_KEY } from "../lib/ideas";

test("editor has one add action and a single compact save/cancel pair", async ({ page }) => {
  await page.goto("/#/project/example");
  await expect(page.getByRole("button", { name: "Добавить блок", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.mouse.move(0, 0);
  const saves = page.getByRole("button", { name: "Сохранить идею", exact: true });
  const cancels = page.getByRole("button", { name: "Отмена", exact: true });
  await expect(saves).toHaveCount(1); await expect(cancels).toHaveCount(1);
  for (const buttons of [saves, cancels]) {
    const styles = await buttons.evaluateAll(elements => elements.map(el => {
      const css = getComputedStyle(el);
      return { text: el.textContent, radius: css.borderRadius, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
    }));
    expect(styles[0].text).toBe(""); expect(styles[0].width).toBe(styles[0].height); expect(styles[0].radius).toBe("50%");
  }
  await expect(page.getByRole("button", { name: "Добавить блок", exact: true })).toHaveCount(1);
  await page.getByLabel("Заголовок блока", { exact: true }).first().fill("Отменённая правка");
  page.once("dialog", dialog => dialog.accept());
  await cancels.last().click();
  await expect(page.getByRole("heading", { name: "Example", exact: true })).toBeVisible();
});

test("dragging a block changes its order and persists it", async ({ page, isMobile }) => {
  test.skip(isMobile, "Mouse drag is for desktop; arrow buttons remain available on touch screens.");
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByRole("button", { name: "Перетащить блок 1", exact: true }).dragTo(page.locator(".editor-block").nth(1));
  await expect(page.getByLabel("Заголовок блока").first()).toHaveValue("Медиа и расположение");
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).last().click();
  await page.reload();
  await expect(page.locator(".content-block h2").first()).toHaveText("Медиа и расположение");
});

test("section actions open beside the trigger and close on Escape/outside click", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".section-grid .new-section-card")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Действия с разделом Примеры", exact: true });
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator("main h1").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Изменить раздел", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Примеры");
});

test("a custom cover survives on project cards while project pages omit cover controls", async ({ page }) => {
  await page.goto("/#/section/examples");
  await page.getByRole("button", { name: "Новая идея", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".cover-picker > button")).toHaveCount(5);
  await dialog.getByLabel("Название", { exact: true }).fill("Идея со своей обложкой");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#aaba9c"; ctx.fillRect(0, 0, 320, 180);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await dialog.getByLabel("Загрузить свою обложку", { exact: true }).setInputFiles({ name: "my-cover.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
  await expect(dialog.locator(".cover-file-name")).toHaveText("my-cover.png");
  await dialog.getByRole("button", { name: "Создать идею", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Идея со своей обложкой", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".project-hero, .document-meta")).toHaveCount(0);
  await page.getByRole("button", { name: "Действия с идеей", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Название и обложка", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Примеры", exact: true }).last().click();
  await page.reload();
  const card = page.locator(".project-card").filter({ hasText: "Идея со своей обложкой" });
  await expect.poll(() => card.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
});

test("adding and editing blocks scroll to the target and actions dock at the editor end", async ({ page }) => {
  const library = structuredClone(demoLibrary);
  library.projects[0].blocks = Array.from({ length: 15 }, (_, index) => ({ id: `long-${index}`, heading: `Карточка ${index + 1}`, text: "Строка заметки.\n".repeat(10), width: "full" }));
  await page.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, { key: STORAGE_KEY, value: JSON.stringify(library) });
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Добавить блок", exact: true }).click();
  const last = page.locator(".editor-block").last();
  await expect(last).toBeInViewport();
  await expect(page.getByLabel("Заголовок блока").last()).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(200);
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await page.getByRole("button", { name: "Редактировать блок 9", exact: true }).click();
  const selected = page.locator(".editor-block").nth(8);
  await expect(selected).toBeInViewport();
  await expect(page.getByLabel("Заголовок блока").nth(8)).toBeFocused();
  const dock = page.locator(".editor-save");
  for (const scroll of [0, 1800, 3200]) {
    await page.evaluate(y => window.scrollTo(0, y), scroll);
    await expect(dock).toBeInViewport();
    const rect = (await dock.boundingBox())!;
    expect(rect.y + rect.height).toBeLessThanOrEqual(page.viewportSize()!.height - 10);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(dock).toBeInViewport();
  const formEnd = await page.locator("#project-editor").evaluate(el => el.getBoundingClientRect().bottom);
  const rect = (await dock.boundingBox())!;
  expect(Math.abs(rect.y + rect.height - formEnd)).toBeLessThan(2);
});
