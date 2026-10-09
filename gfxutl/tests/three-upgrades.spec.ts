import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 30_000 });
});

test("GPU particle object renders with a WebGL CPU fallback", async ({ page }) => {
  const canvas = page.locator(".preview-stage canvas");
  const before = await canvas.screenshot();
  await page.locator(".preview-stage").click({ button: "right", position: { x: 420, y: 220 } });
  await page.getByRole("menuitem", { name: "GPUパーティクル" }).click();
  await expect(page.getByText("TSL COMPUTE", { exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute("data-active-scene-objects", "1", { timeout: 15_000 });
  await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 15_000 }).toBe(false);
});

test("smooth keyframes are stored and rendered at timeline time", async ({ page }) => {
  const canvas = page.locator(".preview-stage canvas");
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addGeometryObject("box", { time: 0, timelineY: 40, positionX: 0, positionY: 0 });
    const id = editorController.getSnapshot().clips[0].id;
    editorController.setTime(0);
    editorController.addKeyframe(id, "positionX", -250, "smooth");
    editorController.setTime(2);
    editorController.addKeyframe(id, "positionX", 250, "smooth");
    editorController.setTime(0);
  });
  const first = await canvas.screenshot();
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.setTime(2);
  });
  await expect.poll(async () => (await canvas.screenshot()).equals(first), { timeout: 15_000 }).toBe(false);
  await expect(page.locator(".timeline-keyframe")).toHaveCount(2);
});
