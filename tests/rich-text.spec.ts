import { expect, test } from "@playwright/test";
import { demoLibrary, parseLibrary, STORAGE_KEY } from "../lib/ideas";
import { normalizeRichText, plainTextDocument, richTextToPlain, safeLink } from "../lib/rich-text";

test("rich text normalization preserves plain text and rejects unsafe content", () => {
  const text = "Строка\nПродолжение\n\nАбзац\n";
  expect(richTextToPlain(plainTextDocument(text))).toBe(text);
  expect(safeLink("javascript:alert(1)")).toBeNull();
  const doc = normalizeRichText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Безопасный текст", marks: [
    { type: "link", attrs: { href: "javascript:alert(1)" } }, { type: "textStyle", attrs: { color: "red; background: url(x)", fontSize: "999px" } },
  ] }] }] });
  expect(doc.content[0].content[0]).toEqual({ type: "text", text: "Безопасный текст", marks: [{ type: "textStyle", attrs: { fontSize: "48px" } }] });
  expect(parseLibrary(JSON.stringify(demoLibrary))).toEqual(demoLibrary);
  const invalid = structuredClone(demoLibrary);
  invalid.projects[0].blocks[0].richText = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] };
  expect(() => parseLibrary(JSON.stringify(invalid))).toThrow();
});

test("formatting and links survive save, reload and reopening the editor", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  const block = page.locator(".editor-block").first();
  const input = block.getByRole("textbox", { name: "Текст", exact: true });
  await input.fill("Форматированный текст");
  await input.press("ControlOrMeta+a");
  await expect(input).toHaveCSS("outline-style", "none");
  for (const name of ["Жирный", "Подчёркнутый", "Курсив", "Зачёркнутый"]) await block.getByRole("button", { name, exact: true }).click();
  await block.getByLabel("Размер шрифта", { exact: true }).selectOption("24px");
  await block.getByLabel("Цвет текста", { exact: true }).fill("#b03050");
  await block.getByRole("button", { name: "Гиперссылка", exact: true }).click();
  await block.getByLabel("Адрес ссылки").fill("javascript:alert(1)");
  await block.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(block.getByRole("alert")).toContainText("полный адрес");
  await block.getByLabel("Адрес ссылки").fill("https://example.com/idea");
  await block.getByRole("button", { name: "Применить", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  const prose = page.locator(".content-block").first().locator(".block-prose");
  for (const tag of ["strong", "u", "em", "s"]) await expect(prose.locator(tag)).toHaveText("Форматированный текст");
  await expect(prose.getByRole("link")).toHaveAttribute("href", "https://example.com/idea");
  await expect(prose.locator("span[style]")).toHaveCSS("font-size", "24px");
  await expect(prose.locator("span[style]")).toHaveCSS("color", "rgb(176, 48, 80)");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await input.click(); await input.press("ControlOrMeta+a");
  await expect(block.getByRole("button", { name: "Жирный", exact: true })).toHaveAttribute("aria-pressed", "true");
  await block.getByRole("button", { name: "Сбросить форматирование", exact: true }).click();
  await expect(input.locator("strong,em,u,s,a,[style]")).toHaveCount(0);
  await expect(input).toHaveCSS("font-size", "16px");
  await page.screenshot({ path: info.outputPath("text-editor.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(prose.locator("strong")).toHaveText("Форматированный текст");
  expect(errors).toEqual([]);
});

test("text position, inline code and old unedited text persist", async ({ page }) => {
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  const block = page.locator(".editor-block").first();
  await block.getByLabel("Медиа блока 1", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64") });
  await block.getByLabel("Положение текста блока 1").selectOption("above");
  const input = block.getByRole("textbox", { name: "Текст", exact: true });
  await input.fill("const idea = 1;"); await input.press("ControlOrMeta+a");
  await block.getByRole("button", { name: "Код", exact: true }).click();
  const editorElement = await input.elementHandle();
  await block.getByLabel("Положение текста блока 1").selectOption("below");
  expect(await editorElement!.evaluate(el => el.isConnected)).toBe(true);
  await block.getByLabel("Положение текста блока 1").selectOption("above");
  await expect(input.locator("code")).toHaveText("const idea = 1;");
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  const card = page.locator(".content-block").first();
  await expect(card.locator(".block-prose code")).toHaveText("const idea = 1;");
  expect(await card.evaluate(el => !!(el.querySelector(".block-prose")!.compareDocumentPosition(el.querySelector(".media-gallery")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
  expect(saved.projects[0].blocks[1]).toEqual(demoLibrary.projects[0].blocks[1]);
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await block.getByLabel("Положение текста блока 1").selectOption("below");
  await expect(input.locator("code")).toHaveText("const idea = 1;");
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  await expect(card.locator(".media-gallery + .block-prose code")).toHaveText("const idea = 1;");
});
