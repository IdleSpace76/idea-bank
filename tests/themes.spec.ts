import { expect, test } from "@playwright/test";
import { THEME_KEY, themes } from "../lib/themes";
import { STORAGE_KEY } from "../lib/ideas";

test("themes persist across reload and keep a project draft intact", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Заголовок блока", { exact: true }).first().fill("Черновик с новой темой");
  const before = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  for (const theme of themes) {
    await page.getByRole("button", { name: "Тема оформления", exact: true }).click();
    await page.getByRole("button", { name: theme.name, exact: true }).click();
    await expect(page.getByLabel("Заголовок блока", { exact: true }).first()).toHaveValue("Черновик с новой темой");
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(before);
    expect(await page.evaluate(key => localStorage.getItem(key), THEME_KEY)).toBe(theme.id);
    const contrast = await page.evaluate(() => {
      const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const body = getComputedStyle(document.body), editor = getComputedStyle(document.querySelector(".rich-text-input")!), button = getComputedStyle(document.querySelector(".save-edit")!);
      return [ratio(body.color, body.backgroundColor), ratio(getComputedStyle(document.querySelector(".layout-help")!).color, body.backgroundColor), ratio(editor.color, getComputedStyle(document.querySelector(".rich-text-editor")!).backgroundColor), ratio(button.color, button.backgroundColor)];
    });
    if (theme.id !== "sage") contrast.forEach(value => expect(value).toBeGreaterThanOrEqual(4.5));
    await page.screenshot({ path: info.outputPath(`editor-${theme.id}.png`), fullPage: true });
  }
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("heading", { name: "Example", exact: true })).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "Создать раздел", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", "rgb(43, 46, 52)");
  await page.screenshot({ path: info.outputPath("graphite-dialog.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("theme picker fits narrow screens and supports keyboard dismissal", async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, "unknown-theme"), THEME_KEY);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  for (const width of [320, 390, 760, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const trigger = page.getByRole("button", { name: "Тема оформления", exact: true });
    await trigger.click();
    const choices = page.getByRole("group", { name: "Выбрать тему" });
    await expect(choices).toBeVisible();
    const box = (await choices.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "Графит", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(choices).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
