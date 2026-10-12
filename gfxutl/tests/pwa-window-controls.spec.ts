import { expect, test, type Page } from "@playwright/test";

async function mockWindowControlsOverlay(page: Page, platform: string, rect: { x: number; width: number; height: number }) {
  await page.addInitScript(({ platform, rect }) => {
    class MockWindowControlsOverlay extends EventTarget {
      visible = true;
      getTitlebarAreaRect() {
        return new DOMRect(rect.x, 0, rect.width, rect.height);
      }
    }
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { platform } });
    Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: new MockWindowControlsOverlay() });
  }, { platform, rect });
}

test("PWA manifest opts into Window Controls Overlay and ships an offline shell", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: "GfxUtl",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    start_url: "/",
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: "192x192", type: "image/png", purpose: "any maskable" }),
    expect.objectContaining({ sizes: "512x512", type: "image/png", purpose: "any maskable" }),
    expect.objectContaining({ sizes: "any", type: "image/svg+xml" }),
  ]));
  await expect((await request.get("/sw.js")).text()).resolves.toContain("gfxutl-shell-v1");
});

test("Windows overlay reserves the right controls and synchronizes pane header height", async ({ page }) => {
  await mockWindowControlsOverlay(page, "Windows", { x: 0, width: 1290, height: 38 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const root = page.locator("#main");
  await expect(root).toHaveAttribute("data-window-controls-overlay", "right");
  await expect(root).toHaveCSS("--pane-tab-h", "38px");
  const heights = await root.locator(":scope > section > div:first-child").evaluateAll((headers) => headers.slice(0, 3).map((header) => header.getBoundingClientRect().height));
  expect(heights).toEqual([38, 38, 38]);
  expect(await page.locator(".inspector-tabs").evaluate((element) => parseFloat(getComputedStyle(element).paddingRight))).toBe(150);
});

test("macOS overlay reserves the left controls and right-aligns the media tabs", async ({ page }) => {
  await mockWindowControlsOverlay(page, "macOS", { x: 78, width: 1362, height: 36 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const root = page.locator("#main");
  await expect(root).toHaveAttribute("data-window-controls-overlay", "left");
  await expect(root).toHaveCSS("--pane-tab-h", "36px");
  const mediaTabs = page.locator("#main > section").nth(0).locator(":scope > div").nth(0);
  await expect(mediaTabs).toHaveCSS("justify-content", "flex-end");
  expect(await mediaTabs.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft))).toBe(78);
  const heights = await root.locator(":scope > section > div:first-child").evaluateAll((headers) => headers.slice(0, 3).map((header) => header.getBoundingClientRect().height));
  expect(heights).toEqual([36, 36, 36]);
});
