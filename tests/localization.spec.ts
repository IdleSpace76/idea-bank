import { expect, test, type Page } from "@playwright/test";
import { STORAGE_KEY } from "../lib/ideas";
import { translate } from "../lib/i18n";

async function chooseLanguage(page: Page, language: "EN" | "RU") {
  await page.locator(".language-trigger").click();
  await page.getByRole("menuitemradio", { name: new RegExp("^" + language) }).click();
}

test.use({ storageState: { cookies: [], origins: [] } });

test("messages preserve filenames and counts in either language", () => {
  const ru = "Не найден исходный файл «Фото.png». Облако не обновлено.";
  const en = 'Original file “Фото.png” not found. The cloud has not been updated.';
  expect(translate(ru, {}, "en")).toBe(en);
  expect(translate(en, {}, "ru")).toBe(ru);
  expect(translate("Развернуть раздел (+{0})", { 0: 3 }, "en")).toBe("Expand section (+3)");
  expect(translate("Expand section (+3)", {}, "ru")).toBe("Развернуть раздел (+3)");
});

test("English is the default; language persists without changing ideas or an open draft", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/project/example");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "Edit block 1", exact: true }).click();
  await page.getByLabel("Block heading", { exact: true }).first().fill("Моя идея / My idea");
  await page.locator(".rich-text-input").first().fill("Пользовательский текст / Personal text");
  const original = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  await chooseLanguage(page, "RU");
  await expect(page.getByLabel("Заголовок блока", { exact: true }).first()).toHaveValue("Моя идея / My idea");
  await expect(page.locator(".rich-text-input").first()).toHaveText("Пользовательский текст / Personal text");
  await expect(page.getByRole("button", { name: "Сохранить идею", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(original);
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  const saved = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByRole("heading", { name: "Моя идея / My idea", exact: true })).toBeVisible();
  await chooseLanguage(page, "EN");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(saved);
  await expect(page.getByRole("heading", { name: "Моя идея / My idea", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("English forms, themes, backups and Russian search are usable at narrow widths", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Interface language", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Graphite", exact: true }).click();
  await page.getByRole("button", { name: "Idea", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New idea", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Русская идея");
  await dialog.getByLabel("Short description", { exact: false }).fill("Не переводить описание");
  await dialog.getByRole("button", { name: "Space", exact: true }).click();
  await dialog.getByRole("button", { name: "Create idea", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Русская идея", exact: true })).toBeVisible();
  await page.locator(".brand:visible").first().click();
  await page.locator(".projects-toolbar").getByRole("searchbox", { name: "Find an idea", exact: true }).fill("Русская");
  await expect(page.locator(".project-card > strong")).toHaveText("Русская идея");
  await page.locator(".local-status").click();
  await expect(page.getByRole("dialog", { name: "Where your ideas are stored", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export ZIP", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("invalid preferences fall back to English and changes reach other tabs", async ({ page, context }) => {
  await page.addInitScript(() => { if (!localStorage.getItem("idea-bank.language")) localStorage.setItem("idea-bank.language", "invalid"); });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const other = await context.newPage();
  await other.goto("/");
  await chooseLanguage(page, "RU");
  await expect(other.locator("html")).toHaveAttribute("lang", "ru");
  await other.close();
});
