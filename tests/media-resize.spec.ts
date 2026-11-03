import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_KEY } from "../lib/ideas";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
function wav() {
  const data = Buffer.alloc(204);
  data.write("RIFF"); data.writeUInt32LE(196, 4); data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(160, 40); return data;
}
async function resize(page: Page, card: Locator, width: number, height: number) {
  const handle = card.getByRole("button", { name: /^Изменить размер/ });
  await handle.scrollIntoViewIfNeeded();
  const frame = (await card.locator(".media-viewport").boundingBox())!;
  const box = (await card.boundingBox())!, grip = (await handle.boundingBox())!;
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + width - box.width, y + height - frame.height, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await card.locator(".media-viewport").boundingBox())!.height)).toBe(height);
}

test("individual media sizes persist and rows follow the tallest item", async ({ page, isMobile }, info) => {
  test.skip(isMobile, "Multiple media columns require a wide viewport");
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Медиа блока 1", { exact: true }).setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: image },
    { name: "sound.wav", mimeType: "audio/wav", buffer: wav() },
    { name: "third.png", mimeType: "image/png", buffer: image },
    { name: "fourth.png", mimeType: "image/png", buffer: image },
  ]);
  const gallery = page.locator(".media-gallery").first(), cards = gallery.locator(".media-item");
  await expect(cards).toHaveCount(4);
  await expect.poll(() => cards.first().locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  const width = Math.floor((await gallery.evaluate(el => el.clientWidth) - 60) / 3);
  const heights = [300, 140, 220, 100];
  for (let i = 0; i < 4; i++) await resize(page, cards.nth(i), width, heights[i]);
  async function checkRows() {
    const boxes = await Promise.all([0, 1, 2, 3].map(async i => (await cards.nth(i).boundingBox())!));
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
    expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThan(2);
    expect(boxes[0].height).toBeGreaterThan(boxes[1].height + 100);
    expect(Math.abs(boxes[3].y - Math.max(...boxes.slice(0, 3).map(box => box.y + box.height)) - 14)).toBeLessThan(2);
  }
  await checkRows();
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload(); await expect(cards).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(cards.nth(i).locator(".media-viewport")).toHaveCSS("height", `${heights[i]}px`);
  await checkRows();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
  expect(saved.projects[0].blocks[0].media.map((asset: { displaySize: unknown }) => asset.displaySize)).toEqual(heights.map(height => ({ width, height })));
  await page.screenshot({ path: info.outputPath("independent-sizes.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(cards.first().locator(".media-viewport")).toHaveCSS("height", "300px");
});

test("media resize supports keyboard, drag cancellation and automatic reset", async ({ page }, info) => {
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Медиа блока 1", { exact: true }).setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: image });
  const card = page.locator(".media-item"), handle = page.getByRole("button", { name: "Изменить размер reference.png", exact: true });
  await expect.poll(() => card.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  await handle.focus(); await handle.press("ArrowUp");
  await expect(card).toHaveClass(/is-sized/);
  const initial = (await card.locator(".media-viewport").boundingBox())!.height;
  await handle.press("Shift+ArrowDown");
  await expect(card.locator(".media-viewport")).toHaveCSS("height", `${initial + 40}px`);
  await handle.scrollIntoViewIfNeeded();
  const before = await card.getAttribute("style"), grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + 10, grip.y + 10); await page.mouse.down();
  await page.mouse.move(grip.x - 20, grip.y - 50, { steps: 3 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(card).toHaveAttribute("style", before!);
  await page.getByRole("button", { name: "Сбросить размер reference.png", exact: true }).click();
  await expect(card).not.toHaveClass(/is-sized/);
  await expect(page.getByRole("button", { name: "Сбросить размер reference.png", exact: true })).toBeDisabled();
  await handle.press("ArrowUp");
  await page.screenshot({ path: info.outputPath("media-size-editor.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.reload();
  await expect(page.locator(".media-item")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});
