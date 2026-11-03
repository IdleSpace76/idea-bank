import { demoLibrary } from "../lib/ideas";
import { expect, test } from "@playwright/test";
import { STORAGE_KEY } from "../lib/ideas";

test.beforeEach(async ({ page }) => {
  const library = structuredClone(demoLibrary);
  for (const idea of library.projects) for (const block of idea.blocks) delete block.media;
  await page.addInitScript(library => { if (localStorage.getItem("idea-bank.library.v1") === null) localStorage.setItem("idea-bank.library.v1", JSON.stringify(library)); }, library);
});

function soundFixture() {
  const samples = 8000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 3000), 44 + i * 2);
  return wav;
}

test("breadcrumbs navigate and wide windows add project columns", async ({ page, isMobile }) => {
  if (isMobile) return;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/project/example");
  const path = page.getByRole("navigation", { name: "Путь к идее" });
  await path.getByRole("button", { name: "Examples", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Examples", exact: true })).toBeVisible();
  await path.getByRole("button", { name: "Библиотека", exact: true }).click();
  await expect(page.locator(".project-card").filter({ hasText: "Example" })).toBeVisible();
  const columns = () => page.locator(".project-grid").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  const normal = await columns();
  await page.setViewportSize({ width: 2560, height: 1440 });
  expect(await columns()).toBeGreaterThan(normal);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("photos, audio, video and block widths survive reload", async ({ page }, testInfo) => {
  await page.goto("/#/project/example");
  await expect(page.getByRole("heading", { name: "Example", exact: true })).toBeVisible();
  const fixtures = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#4e6542"; context.fillRect(0, 0, 320, 180);
    context.fillStyle = "#ffffff"; context.font = "24px sans-serif"; context.fillText("Forest reference", 50, 95);
    const image = canvas.toDataURL("image/png").split(",")[1];
    const chunks: BlobPart[] = [];
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const done = new Promise<Blob>(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 350));
    context.fillStyle = "#aaba9c"; context.fillRect(0, 0, 80, 180);
    await new Promise(resolve => setTimeout(resolve, 350));
    recorder.stop();
    const video = Array.from(new Uint8Array(await (await done).arrayBuffer()));
    stream.getTracks().forEach(track => track.stop());
    return { image, video };
  });
  await page.getByRole("button", { name: "Добавить блок", exact: true }).click();
  await page.getByRole("combobox", { name: "Ширина блока 2", exact: true }).selectOption("half");
  await page.getByRole("combobox", { name: "Ширина блока 3", exact: true }).selectOption("half");
  await page.getByLabel("Заголовок блока").nth(2).fill("Визуальные и звуковые референсы");
  await page.getByLabel("Медиа блока 3", { exact: true }).setInputFiles([
    { name: "reference.png", mimeType: "image/png", buffer: Buffer.from(fixtures.image, "base64") },
    { name: "forest.wav", mimeType: "audio/wav", buffer: soundFixture() },
    { name: "motion.webm", mimeType: "video/webm", buffer: Buffer.from(fixtures.video) },
  ]);
  await expect(page.getByRole("img", { name: "reference.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).last().click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Визуальные и звуковые референсы" })).toBeVisible();
  await expect(page.locator(".media-item")).toHaveCount(3);
  await page.getByRole("img", { name: "reference.png", exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.getByRole("img", { name: "reference.png", exact: true }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  for (const tag of ["audio", "video"]) {
    const player = page.locator(tag);
    await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(1);
    await player.evaluate((el: HTMLMediaElement) => el.play());
    await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
    await player.evaluate((el: HTMLMediaElement) => el.pause());
  }
  const cards = page.locator(".content-block");
  const second = (await cards.nth(1).boundingBox())!;
  const third = (await cards.nth(2).boundingBox())!;
  if (testInfo.project.name === "desktop") expect(Math.abs(second.y - third.y)).toBeLessThan(2);
  else expect(third.y).toBeGreaterThan(second.y + second.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("media-project.png"), fullPage: true });

  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByRole("button", { name: "Переместить forest.wav влево", exact: true }).click();
  await expect(page.locator(".editor-block .media-item figcaption strong")).toHaveText(["forest.wav", "reference.png", "motion.webm"]);
  await expect(page.getByRole("button", { name: "Переместить forest.wav влево", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".media-item figcaption strong")).toHaveText(["forest.wav", "reference.png", "motion.webm"]);
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByRole("button", { name: "Убрать reference.png", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).last().click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".media-item")).toHaveCount(2);
  expect(await page.evaluate(async () => {
    const library = JSON.parse(localStorage.getItem("idea-bank.library.v1")!);
    return library.projects.find((p: { id: string }) => p.id === "example").blocks[2].width;
  })).toBe("half");
});

test("cancelling a media draft leaves the saved project unchanged", async ({ page }) => {
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Добавить блок", exact: true }).click();
  await page.getByLabel("Медиа блока 3", { exact: true }).setInputFiles({ name: "cancelled.wav", mimeType: "audio/wav", buffer: soundFixture() });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Отмена", exact: true }).last().click();
  await expect(page.locator(".media-item")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".content-block")).toHaveCount(2);
  const expected = structuredClone(demoLibrary);
  for (const idea of expected.projects) for (const block of idea.blocks) delete block.media;
  expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY))!)).toEqual(expected);
});
