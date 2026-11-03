import { demoLibrary } from "../lib/ideas";
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test.beforeEach(async ({ page }) => {
  const library = structuredClone(demoLibrary);
  for (const idea of library.projects) for (const block of idea.blocks) delete block.media;
  await page.addInitScript(library => { if (localStorage.getItem("idea-bank.library.v1") === null) localStorage.setItem("idea-bank.library.v1", JSON.stringify(library)); }, library);
});

function fixture() {
  const binary = Buffer.alloc(60);
  [-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, 0, 1, 0, .5, 1].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const doc = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [.15, .6, 1, 1], metallicFactor: 0, roughnessFactor: .8 } }],
    buffers: [{ byteLength: 60 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" }],
  };
  const text = JSON.stringify(doc), json = Buffer.from(text + " ".repeat((4 - Buffer.byteLength(text) % 4) % 4));
  const glb = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + json.length); glb.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(glb, 28 + json.length);
  return { doc, binary, glb };
}

test("GLB renders, rotates, resizes and survives reload", async ({ page, isMobile }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Медиа блока 1", { exact: true }).setInputFiles({ name: "triangle.glb", mimeType: "application/octet-stream", buffer: fixture().glb });
  const model = page.locator(".model-preview");
  await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  const canvas = page.getByRole("img", { name: "3D-модель triangle.glb", exact: true });
  const initial = await canvas.screenshot();
  if (!isMobile) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 15, { steps: 8 }); await page.mouse.up();
    expect(await canvas.screenshot()).not.toEqual(initial);
  }
  await page.getByRole("button", { name: "Сбросить ракурс triangle.glb", exact: true }).click();
  const handle = page.getByRole("button", { name: "Изменить размер triangle.glb", exact: true });
  await handle.press("Shift+ArrowUp");
  await expect(page.locator(".media-model .media-viewport")).toHaveCSS("height", "280px");
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload(); await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  await expect(page.locator(".media-model .media-viewport")).toHaveCSS("height", "280px");
  await expect(page.getByRole("link", { name: "Скачать triangle.glb", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("model-project.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("glTF resources embed locally and missing resources have a useful error", async ({ page }) => {
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  const { doc, binary } = fixture();
  const gltf = { ...doc, buffers: [{ uri: "mesh.bin", byteLength: binary.length }] };
  const upload = page.getByLabel("Медиа блока 1", { exact: true });
  await upload.setInputFiles({ name: "scene.gltf", mimeType: "", buffer: Buffer.from(JSON.stringify(gltf)) });
  await expect(page.getByText(/не хватает файла: mesh.bin/)).toBeVisible();
  await expect(page.locator(".media-model")).toHaveCount(0);
  await upload.setInputFiles([{ name: "scene.gltf", mimeType: "", buffer: Buffer.from(JSON.stringify(gltf)) }, { name: "mesh.bin", mimeType: "application/octet-stream", buffer: binary }]);
  const model = page.locator(".model-preview"); await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  await expect(page.locator(".media-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload(); await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  const href = await page.getByRole("link", { name: "Скачать scene.gltf", exact: true }).getAttribute("href");
  const packed = await page.evaluate(async url => JSON.parse(await (await fetch(url!)).text()), href);
  expect(packed.buffers[0].uri).toMatch(/^data:/);
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await upload.setInputFiles({ name: "broken.glb", mimeType: "", buffer: Buffer.from("broken model") });
  await page.locator(".model-preview").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".model-preview").last()).toHaveAttribute("data-state", "error", { timeout: 30000 });
  await expect(page.locator(".model-preview").last().getByRole("alert")).toContainText("Не удалось показать модель");
  await expect(page.getByRole("link", { name: "Скачать broken.glb", exact: true })).toBeVisible();
});

test("a glTF folder keeps nested textures after reload", async ({ page }, info) => {
  const folder = info.outputPath("model-bundle");
  await mkdir(path.join(folder, "textures"), { recursive: true });
  const { doc, binary } = fixture();
  const gltf = { ...doc, buffers: [{ uri: "mesh.bin", byteLength: binary.length }], images: [{ uri: "textures/color.png" }], textures: [{ source: 0 }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: .8 } }] };
  await Promise.all([
    writeFile(path.join(folder, "scene.gltf"), JSON.stringify(gltf)), writeFile(path.join(folder, "mesh.bin"), binary),
    writeFile(path.join(folder, "textures", "color.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64")),
    writeFile(path.join(folder, "README.txt"), "Model documentation"),
  ]);
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Редактировать блок 1", exact: true }).click();
  await page.getByLabel("Папка 3D-модели блока 1", { exact: true }).setInputFiles(folder);
  const model = page.locator(".model-preview"); await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  await expect(page.locator(".media-item")).toHaveCount(1);
  await expect(page.locator(".media-save-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).click();
  await expect(page.locator("#project-editor")).toHaveCount(0);
  await page.reload(); await model.scrollIntoViewIfNeeded();
  await expect(model).toHaveAttribute("data-state", "ready", { timeout: 30000 });
  const href = await page.getByRole("link", { name: "Скачать scene.gltf", exact: true }).getAttribute("href");
  const packed = await page.evaluate(async url => JSON.parse(await (await fetch(url!)).text()), href);
  expect(packed.images[0].uri).toMatch(/^data:image\/png/);
});
