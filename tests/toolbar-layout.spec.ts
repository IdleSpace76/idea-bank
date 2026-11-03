import { expect, test } from "@playwright/test";

test("idea action matches the edit/menu pair and follows the header's right edge", async ({ page }) => {
  for (const width of [320, 390, 760, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const idea = page.getByRole("button", { name: "Идея", exact: true });
    await expect(idea).toBeVisible();
    const header = (await page.locator(".topbar-actions").boundingBox())!;
    const home = (await idea.boundingBox())!;
    expect(home.x + home.width).toBeCloseTo(header.x + header.width, 0);
    expect(home.height).toBe(48);
    await page.goto("/#/section/examples");
    await expect(page.getByRole("heading", { name: "Examples", exact: true })).toBeVisible();
    const section = (await idea.boundingBox())!;
    expect(section.width).toBeCloseTo(home.width, 0);
    expect(section.x + section.width).toBeCloseTo(header.x + header.width, 0);
    await page.goto("/#/project/example");
    await expect(page.getByRole("button", { name: "Изменить", exact: true })).toBeVisible();
    const pair = (await page.locator(".project-toolbar > .project-actions").boundingBox())!;
    expect(pair.width).toBeCloseTo(home.width, 0);
    expect(pair.x + pair.width).toBeCloseTo(header.x + header.width, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
