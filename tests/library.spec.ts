import { expect, test } from "@playwright/test";
import { STORAGE_KEY } from "../lib/ideas";

test("a project survives reload; cancelled deletion preserves it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Создать раздел", exact: true }).last().click();
  await page.getByLabel("Название", { exact: true }).fill("Полевые заметки");
  await page.getByRole("button", { name: "Создать раздел", exact: true }).last().click();
  await page.getByRole("button", { name: "Полевые заметки Идей: 0" }).click();
  await page.getByRole("button", { name: "Новая идея", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Первая идея");
  await page.getByRole("button", { name: "Создать идею", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Первая идея", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Добавить блок", exact: true }).click();
  await page.getByLabel("Заголовок блока").fill("Как это работает");
  await page.getByLabel("Текст", { exact: true }).fill("Сохранить мысль и вернуться к ней позже.\nВторая строка.");
  await page.getByRole("button", { name: "Сохранить идею", exact: true }).last().click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Как это работает" })).toBeVisible();
  await expect(page.getByText("Сохранить мысль и вернуться к ней позже.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Действия с идеей", exact: true }).click();
  await page.getByRole("menuitem", { name: "Удалить идею", exact: true }).click();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Первая идея", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Действия с идеей", exact: true }).click();
  await page.getByRole("menuitem", { name: "Удалить идею", exact: true }).click();
  await page.getByRole("button", { name: "Удалить идею", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Полевые заметки", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Первая идея/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: /Первая идея/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Новая идея", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("editing can be cancelled, and a project can move to another section", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Создать раздел", exact: true }).last().click();
  await page.getByLabel("Название", { exact: true }).fill("Обучение");
  await page.getByRole("button", { name: "Создать раздел", exact: true }).last().click();
  await page.goto("/#/project/example");
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Несохранённое название");
  await page.getByRole("button", { name: "Отмена", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Example", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Действия с идеей", exact: true }).click();
  await page.getByRole("menuitem", { name: "Перенести в раздел", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Обучение", exact: true }).click();
  await page.getByRole("button", { name: "Обучение", exact: true }).filter({ has: page.locator("svg") }).last().click();
  await expect(page.getByRole("heading", { name: "Обучение", exact: true })).toBeVisible();
  await expect(page.locator(".project-card").filter({ hasText: "Example" })).toBeVisible();
});

test("invalid stored data is preserved and editing is disabled", async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, '{"version":99}'), STORAGE_KEY);
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "Исходные данные" })).toContainText("Исходные данные оставлены без изменений");
  await expect(page.getByRole("button", { name: "Создать раздел", exact: true }).last()).toBeDisabled();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{"version":99}');
});

test("layouts fit small phones and desktop screens", async ({ page }) => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const hash of ["#/", "#/section/examples", "#/project/example"]) {
      await page.goto("/" + hash);
      await expect(page.locator("main h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px ${hash}`).toBe(true);
    }
  }
});
