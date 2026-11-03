import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { demoLibrary } from "../lib/ideas";

test.use({ storageState: { cookies: [], origins: [] } });

test("planet menu shows flags, current language and keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Interface language", exact: true });
  await trigger.click();
  await expect(page.getByRole("menuitemradio", { name: "EN · English", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".language-flag")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  const russianTrigger = page.getByRole("button", { name: "Язык интерфейса", exact: true });
  await russianTrigger.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "RU · Русский", exact: true })).toHaveAttribute("aria-checked", "true");
  const menu = (await page.getByRole("menu").boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await expect(russianTrigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("English Example renders robot image and GLB and exports their original bytes", async ({ page }) => {
  await page.goto("/#/project/example");
  await expect(page.getByRole("heading", { name: "Start with an idea", exact: true })).toBeVisible();
  expect(demoLibrary.sections[0].name).toBe("Examples");
  await expect.poll(() => page.locator(".media-image img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
  const model = page.locator(".model-preview");
  await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  await page.getByRole("button", { name: "Local version", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export ZIP", exact: true }).click();
  const archive = unzipSync(await readFile((await (await downloaded).path())!));
  const library = JSON.parse(strFromU8(archive["library.json"]));
  expect(library).toEqual(demoLibrary);
  const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
  expect(manifest.media).toHaveLength(2);
  for (const asset of demoLibrary.projects[0].blocks[1].media!) {
    const bytes = await readFile(`public/examples/${asset.name}`);
    const entry = manifest.media.find((file: { id: string }) => file.id === asset.id);
    expect(Buffer.from(archive[entry.path])).toEqual(bytes);
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});
