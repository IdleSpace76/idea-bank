import { expect, test } from "@playwright/test";

test("sidebar width changes by dragging and survives reload", async ({ page, isMobile }) => {
  test.skip(isMobile, "The sidebar is hidden in the narrow layout.");
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  const search = sidebar.locator(".idea-search");
  const originalSearchHeight = (await search.boundingBox())!.height;
  const handle = page.getByRole("separator", { name: "Ширина боковой панели" });
  const rect = (await handle.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, 300);
  await page.mouse.down(); await page.mouse.move(390, 300, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => sidebar.evaluate(el => el.getBoundingClientRect().width)).toBe(390);
  expect((await search.boundingBox())!.height).toBe(originalSearchHeight);
  await page.reload();
  await expect.poll(() => sidebar.evaluate(el => el.getBoundingClientRect().width)).toBe(390);
  await handle.focus(); await page.keyboard.press("ArrowLeft");
  await expect.poll(() => sidebar.evaluate(el => el.getBoundingClientRect().width)).toBe(370);
  await handle.dblclick();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("idea-bank.sidebar-width"))).toBeNull();
});

test("drag ghost follows the mouse, previews order, cancels and saves", async ({ page, isMobile }) => {
  test.skip(isMobile, "This check uses a mouse; touch and keyboard alternatives remain available.");
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Ширина блока 1", { exact: true }).selectOption("half");
  await page.getByLabel("Ширина блока 2", { exact: true }).selectOption("half");
  const grid = page.locator(".editor-blocks");
  async function drag() {
    const handle = page.getByRole("button", { name: "Перетащить блок 1", exact: true });
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    const to = (await grid.locator("fieldset").nth(1).boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + 20); await page.mouse.down();
    await page.mouse.move(from.x + 35, from.y + 30, { steps: 3 });
    await expect(page.locator(".block-drag-ghost")).toBeVisible();
    const before = (await page.locator(".block-drag-ghost").boundingBox())!;
    await page.mouse.move(to.x + to.width * .8, to.y + 80, { steps: 15 });
    const after = (await page.locator(".block-drag-ghost").boundingBox())!;
    expect(after.x).toBeGreaterThan(before.x + 50);
    await expect(grid.getByLabel("Заголовок блока").first()).toHaveValue("Медиа и расположение");
  }
  await drag();
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.locator(".block-drag-ghost")).toHaveCount(0);
  await expect(grid.getByLabel("Заголовок блока").first()).toHaveValue("Начни с идеи");
  await drag(); await page.mouse.up();
  await expect(page.locator(".block-drag-ghost")).toHaveCount(0);
  await expect(grid.getByLabel("Заголовок блока").first()).toHaveValue("Медиа и расположение");
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".content-block h2").first()).toHaveText("Медиа и расположение");
});

test("neighboring cards glide through intermediate positions while dragging", async ({ page, isMobile }) => {
  test.skip(isMobile, "Mouse animation check.");
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Ширина блока 1", { exact: true }).selectOption("half");
  await page.getByLabel("Ширина блока 2", { exact: true }).selectOption("half");
  const handle = page.getByRole("button", { name: "Перетащить блок 1", exact: true });
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const target = (await page.locator(".editor-blocks > fieldset").nth(1).boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 20); await page.mouse.down();
  await page.mouse.move(from.x + 35, from.y + 25);
  // Sample the real browser animation on successive frames, independently of test-driver latency.
  const sample = page.evaluate(() => new Promise<{ first: number; middle: number; last: number; duration: number }>(resolve => {
    function watch() {
      const card = document.querySelector<HTMLElement>('[data-block-id="example-media"]')!;
      const animation = card.getAnimations()[0];
      if (!animation) { requestAnimationFrame(watch); return; }
      const duration = Number(animation.effect!.getTiming().duration);
      animation.pause(); animation.currentTime = 0;
      const first = card.getBoundingClientRect().left;
      animation.currentTime = duration * .35;
      const middle = card.getBoundingClientRect().left;
      animation.currentTime = duration;
      const last = card.getBoundingClientRect().left;
      animation.play();
      resolve({ first, middle, last, duration });
    }
    watch();
  }));
  await page.mouse.move(target.x + target.width * .8, target.y + 80);
  const positions = await sample;
  expect(positions.duration).toBeGreaterThanOrEqual(300);
  expect(positions.first - positions.last).toBeGreaterThan(100);
  expect(positions.middle).toBeLessThan(positions.first - 1);
  expect(positions.middle).toBeGreaterThan(positions.last + 1);
  await expect(page.locator(".editor-block.is-dragging")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".block-drag-ghost")).toHaveCount(0);
});
