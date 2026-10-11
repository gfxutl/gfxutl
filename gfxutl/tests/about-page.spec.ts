import { expect, test } from "@playwright/test";

test("/about renders the standalone GfxUtl room page", async ({ page }) => {
  await page.goto("/about", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("GfxUtlのお部屋");
  await expect(page.locator("body")).toHaveClass(/about-route/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("GfxUtlのお部屋");
  await expect(page.getByRole("heading", { name: "★ ダウンロード ★" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "★ 使用上の注意 ★" })).toBeVisible();
  await expect(page.getByRole("link", { name: "GfxUtlを起動" }).first()).toHaveAttribute("href", "/");
  await expect(page.locator(".preview-panel, .timeline-panel, .inspector-panel")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("AviUtl");
  expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, overflow: getComputedStyle(document.documentElement).overflow, zoom: getComputedStyle(document.documentElement).zoom, viewportScale: window.visualViewport?.scale, viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") }))).toMatchObject({ width: 1440, overflow: "auto", zoom: "1", viewportScale: 1, viewport: "width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no" });
  expect((await page.evaluate(() => document.documentElement.scrollHeight))).toBeGreaterThan(2500);
});

test("the editor remains the root route", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".preview-panel")).toBeVisible();
  await expect(page.locator(".about-page")).toHaveCount(0);
});
