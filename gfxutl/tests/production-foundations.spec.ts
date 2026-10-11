import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".timeline-panel")).toBeVisible();
});

test("undo and redo restore durable editor state", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addTextObject({ time: 1, timelineY: 40 });
  });
  await expect(page.locator(".timeline-clip")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".timeline-clip")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".timeline-clip")).toHaveCount(1);
});

test("portable project document round-trips the complete project settings", async ({ page }) => {
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { createProjectDocument, parseProjectDocument } = await import("/core/project/project-document.ts");
    const background = {
      id: "background", name: "背景", color: 0x123456,
      scene: {
        background: { color: 0x123456, alpha: 1, fogEnabled: false, fogColor: 0, fogNear: 1, fogFar: 10, environmentIntensity: 1, environmentRotation: 0, backgroundBlurriness: 0 },
        camera: { projection: "orthographic", position: [0, 0, 10], target: [0, 0, 0], near: .01, far: 1000, fov: 50, zoom: 1, orthographicHeight: 9 },
        renderer: { previewScale: .75, toneMapping: "aces", exposure: 1, outputBuffer: "uint8", antialias: true, samples: 2, shadows: true, shadowType: "pcf", transparentBackground: false, postProcessing: false, fxaa: false, bloomStrength: 0, bloomRadius: .25, bloomThreshold: .8 },
        lights: [],
      },
    } as const;
    const document = createProjectDocument({ name: "Round Trip", fps: 60, duration: 12, background, assets: [], clips: [], settings: { ramPreviewEnabled: true, ramPreviewMaxBytes: 64 * 1024 * 1024, audioChannels: "mono" }, exportSettings: { format: "webm", videoCodec: "vp9", audioCodec: "opus", width: 1080, height: 1080, fps: 60, bitrate: 4_000_000, audioBitrate: 128_000, filename: "Round Trip", startTime: 1, endTime: 11 } });
    return parseProjectDocument(JSON.stringify(document));
  });
  expect(result).toMatchObject({ application: "GfxUtl", version: 2, name: "Round Trip", fps: 60, duration: 12, settings: { audioChannels: "mono" }, exportSettings: { width: 1080, height: 1080 } });
  expect(result.background.color).toBe(0x123456);
});

test("shape paths, masks, and extended bezier keyframes stay behind contextual controls", async ({ page }) => {
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void } & typeof editorController;
    controller.addGeometryObject("shape", { time: 0, timelineY: 30 });
    const shape = controller.getSnapshot().clips[0];
    controller.update({
      assets: [{ id: "image", name: "Image.png", kind: "image", duration: 0, size: 12, width: 16, height: 9, color: "#777" }],
      clips: [...controller.getSnapshot().clips, { id: "image-clip", assetId: "image", name: "Image", kind: "video", y: 90, start: 0, duration: 5, offset: 0, color: "#777" }],
    });
    controller.addMask("image-clip", "ellipse");
    controller.addKeyframe(shape.id, "material.roughness", 0.2, "bezier");
    const snapshot = controller.getSnapshot();
    return {
      points: snapshot.clips.find((clip: { id: string }) => clip.id === shape.id)?.geometry?.points2D?.length,
      mask: snapshot.clips.find((clip: { id: string }) => clip.id === "image-clip")?.masks?.[0],
      key: snapshot.clips.find((clip: { id: string }) => clip.id === shape.id)?.keyframes?.[0],
    };
  });
  expect(result.points).toBe(4);
  expect(result.mask).toMatchObject({ shape: "ellipse", mode: "add", opacity: 100 });
  expect(result.key).toMatchObject({ property: "material.roughness", interpolation: "bezier" });
});

test("scene animation, markers, and loop state are durable editor features", async ({ page }) => {
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.setTime(2.5);
    editorController.addSceneKeyframe("camera.position.0", 4, "bezier");
    editorController.addMarker(2.5, "Beat");
    editorController.toggleLoopPlayback();
    editorController.selectBackground();
    const snapshot = editorController.getSnapshot();
    return { key: snapshot.background.scene.keyframes?.[0], marker: snapshot.markers[0], loop: snapshot.loopPlayback };
  });
  expect(result.key).toMatchObject({ property: "camera.position.0", time: 2.5, value: 4, interpolation: "bezier" });
  expect(result.marker).toMatchObject({ time: 2.5, label: "Beat" });
  expect(result.loop).toBe(true);
  await expect(page.locator(".timeline-marker")).toHaveCount(1);
  await expect(page.locator(".scene-keyframes")).toBeVisible();
});

test("custom context menu is available in both upper side panes", async ({ page }) => {
  await page.locator(".media-panel").click({ button: "right", position: { x: 24, y: 90 } });
  await expect(page.getByRole("menu", { name: "編集メニュー" })).toBeVisible();
  let scope = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().contextMenu?.scope;
  });
  expect(scope).toBe("media");

  await page.keyboard.press("Escape");
  await page.locator(".inspector-panel").click({ button: "right", position: { x: 24, y: 90 } });
  await expect(page.getByRole("menu", { name: "編集メニュー" })).toBeVisible();
  scope = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().contextMenu?.scope;
  });
  expect(scope).toBe("inspector");
});

test("preview transport is replaced by a hover-expanding timeline time pill", async ({ page }) => {
  await expect(page.locator(".preview-panel > .transport")).toHaveCount(0);
  const removedXPathExists = await page.evaluate(() => Boolean(document.evaluate('//*[@id="main"]/section[2]/div[2]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue));
  expect(removedXPathExists).toBe(false);

  const pill = page.locator(".timeline-transport-pill");
  await expect(page.locator(".timeline-pill-clock-compact")).toHaveText("00:00:00");
  await expect(page.locator(".timeline-pill-clock-precise")).toBeHidden();
  const collapsedBox = await pill.boundingBox();
  const collapsedWidth = collapsedBox?.width ?? 0;
  const collapsedHeight = collapsedBox?.height ?? 0;
  await pill.hover();
  await expect(page.locator(".timeline-pill-expanded")).toHaveCSS("opacity", "1");
  await expect(page.locator(".timeline-pill-clock-precise")).toHaveText("00:00:00.00");
  await expect(page.locator(".timeline-pill-clock-precise")).toBeVisible();
  await expect.poll(async () => (await pill.boundingBox())?.width ?? 0).toBeGreaterThan(collapsedWidth + 200);
  await expect.poll(async () => (await pill.boundingBox())?.height ?? 0).toBeGreaterThan(collapsedHeight + 6);
  await expect(page.getByRole("button", { name: "再生" })).toBeVisible();

  await page.getByRole("button", { name: "1フレーム進む" }).click();
  await page.locator(".preview-stage").hover();
  await expect(page.locator(".timeline-pill-expanded")).toHaveCSS("opacity", "0");
  await expect(page.locator(".timeline-pill-clock-precise")).toBeHidden();
  await expect.poll(async () => (await pill.boundingBox())?.width ?? 0).toBeLessThan(collapsedWidth + 10);
  await expect.poll(async () => (await pill.boundingBox())?.height ?? 0).toBeLessThan(collapsedHeight + 2);
});
