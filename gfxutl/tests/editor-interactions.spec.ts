import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

async function dragBy(page: Page, selector: string, dx: number, dy: number) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function seedTimeline(page: Page) {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void };
    controller.update({
      assets: [{ id: "seed-image", name: "Seed.png", kind: "image", duration: 0, size: 1024, width: 64, height: 64, color: "#777" }],
      clips: [{ id: "seed-clip", assetId: "seed-image", name: "Seed.png", kind: "video", y: 84, start: 2, duration: 5, offset: 0, color: "#777" }],
      selectedClipId: "seed-clip",
      selectedClipIds: ["seed-clip"],
      selectedAssetId: "seed-image",
    });
  });
}

function createWavBuffer(durationSeconds = 0.5, sampleRate = 8_000) {
  const samples = Math.floor(durationSeconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 440) * 8_000), 44 + index * 2);
  return buffer;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".timeline-panel")).toBeVisible();
});

test("panel boundaries resize and persist", async ({ page }) => {
  await dragBy(page, ".resizer-leftPanelWidth", 64, 0);
  await dragBy(page, ".resizer-rightPanelWidth", -52, 0);
  await dragBy(page, ".resizer-timelineHeight", 0, -46);

  const layout = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("#main")!;
    return {
      left: parseFloat(root.style.getPropertyValue("--left-w")),
      right: parseFloat(root.style.getPropertyValue("--right-w")),
      timeline: parseFloat(root.style.getPropertyValue("--timeline-h")),
      stored: JSON.parse(localStorage.getItem("gfxutl:layout") ?? "null"),
    };
  });

  expect(layout.left).toBeGreaterThan(330);
  expect(layout.right).toBeGreaterThan(330);
  expect(layout.timeline).toBeGreaterThan(340);
  expect(layout.stored).toMatchObject({ leftPanelWidth: layout.left, rightPanelWidth: layout.right, timelineHeight: layout.timeline });
});

test("clips move freely in time and vertical space", async ({ page }) => {
  await seedTimeline(page);
  const clip = page.locator(".timeline-clip", { hasText: "Seed.png" });
  const beforeLeft = parseFloat((await clip.getAttribute("style"))?.match(/left:\s*([\d.]+)px/)?.[1] ?? "0");
  const beforeTop = parseFloat((await clip.getAttribute("style"))?.match(/top:\s*([\d.]+)px/)?.[1] ?? "0");
  await dragBy(page, ".timeline-clip:has-text('Seed.png')", 108, 95);

  const moved = page.locator(".timeline-clip", { hasText: "Seed.png" });
  const afterLeft = parseFloat((await moved.getAttribute("style"))?.match(/left:\s*([\d.]+)px/)?.[1] ?? "0");
  const afterTop = parseFloat((await moved.getAttribute("style"))?.match(/top:\s*([\d.]+)px/)?.[1] ?? "0");
  expect(afterLeft).toBeGreaterThan(beforeLeft + 80);
  expect(afterTop).toBeGreaterThan(beforeTop + 80);
});

test("selected timeline objects move exactly one frame with arrow keys", async ({ page }) => {
  await seedTimeline(page);
  const clipStart = async () => page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips[0].start;
  });
  expect(await clipStart()).toBe(2);
  await page.keyboard.press("ArrowRight");
  await expect.poll(clipStart).toBeCloseTo(2 + 1 / 30, 8);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(clipStart).toBeCloseTo(2, 8);

  const search = page.getByPlaceholder("フォルダ内を検索");
  await search.focus();
  await page.keyboard.press("ArrowRight");
  expect(await clipStart()).toBeCloseTo(2, 8);
});

test("text, objects, and images resize from both timeline edges", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void };
    controller.update({
      assets: [
        { id: "still", name: "Still.png", kind: "image", duration: 0, size: 100, color: "#777" },
        { id: "movie", name: "Movie.mp4", kind: "video", duration: 10, size: 100, color: "#777" },
      ],
      clips: [
        { id: "title", name: "Text Static", text: "Text", kind: "title", y: 40, start: 1, duration: 5, offset: 0, color: "#9169b6" },
        { id: "object", name: "Static Object", kind: "object", y: 80, start: 2, duration: 4, offset: 0, color: "#6ca6d9" },
        { id: "image", assetId: "still", name: "Still.png", kind: "video", y: 120, start: 3, duration: 5, offset: 0, color: "#777" },
        { id: "video", assetId: "movie", name: "Movie.mp4", kind: "video", y: 160, start: 4, duration: 5, offset: 0, color: "#777" },
      ],
      selectedClipId: "title",
      selectedClipIds: ["title"],
    });
  });
  const title = page.locator(".timeline-clip", { hasText: "Text Static" });
  await expect(title.locator(".clip-trim-handle")).toHaveCount(2);
  await dragBy(page, ".timeline-clip:has-text('Text Static') .trim-end", 52, 0);
  await expect.poll(() => page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips.find((clip: { id: string; duration: number }) => clip.id === "title")?.duration;
  })).toBeCloseTo(7, 1);
  await dragBy(page, ".timeline-clip:has-text('Text Static') .trim-start", 26, 0);
  const titleTiming = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const clip = editorController.getSnapshot().clips.find((item: { id: string; start: number; duration: number }) => item.id === "title")!;
    return { start: clip.start, duration: clip.duration };
  });
  expect(titleTiming.start).toBeCloseTo(2, 1);
  expect(titleTiming.duration).toBeCloseTo(6, 1);

  await page.locator(".timeline-clip", { hasText: "Static Object" }).click();
  await expect(page.locator(".timeline-clip", { hasText: "Static Object" }).locator(".clip-trim-handle")).toHaveCount(2);
  await page.locator(".timeline-clip", { hasText: "Still.png" }).click();
  await expect(page.locator(".timeline-clip", { hasText: "Still.png" }).locator(".clip-trim-handle")).toHaveCount(2);
  await page.locator(".timeline-clip", { hasText: "Movie.mp4" }).click();
  await expect(page.locator(".timeline-clip", { hasText: "Movie.mp4" }).locator(".clip-trim-handle")).toHaveCount(0);
});

test("timeline groups resize in every direction and enforce all-in or all-out nesting", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addGroupObject({ time: 2, timelineY: 80 });
    editorController.addTextObject({ time: 3, timelineY: 110, positionX: 0, positionY: 0 });
  });

  const group = page.locator(".timeline-clip.clip-group");
  const text = page.locator(".timeline-clip.clip-title");
  await expect(group).toBeVisible();
  await group.click({ position: { x: 10, y: 10 } });
  await expect(group.locator(".group-resize-handle")).toHaveCount(8);
  await expect(text).toHaveAttribute("data-group-id", /.+/);

  const movedTogether = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const before = editorController.getSnapshot().clips;
    const beforeGroup = before.find((clip: { kind: string }) => clip.kind === "group")!;
    const beforeChild = before.find((clip: { kind: string }) => clip.kind === "title")!;
    editorController.selectClip(beforeGroup.id);
    editorController.moveClip(beforeGroup.id, 4, 120);
    const after = editorController.getSnapshot().clips;
    const afterGroup = after.find((clip: { id: string }) => clip.id === beforeGroup.id)!;
    const afterChild = after.find((clip: { id: string }) => clip.id === beforeChild.id)!;
    return {
      groupId: afterChild.groupId,
      group: { start: afterGroup.start, y: afterGroup.y },
      child: { start: afterChild.start, y: afterChild.y },
    };
  });
  expect(movedTogether.group).toEqual({ start: 4, y: 120 });
  expect(movedTogether.child).toEqual({ start: 5, y: 150 });
  expect(movedTogether.groupId).toBeTruthy();

  const boundaryRule = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const clips = editorController.getSnapshot().clips;
    const group = clips.find((clip: { kind: string }) => clip.kind === "group")!;
    const child = clips.find((clip: { kind: string }) => clip.kind === "title")!;
    editorController.selectClip(child.id);
    editorController.moveClip(child.id, 3, child.y); // Partially crosses the left edge: rejected.
    const rejected = editorController.getSnapshot().clips.find((clip: { id: string }) => clip.id === child.id)!;
    editorController.moveClip(child.id, group.start + group.duration + 1, child.y); // Fully outside.
    const outside = editorController.getSnapshot().clips.find((clip: { id: string }) => clip.id === child.id)!;
    editorController.moveClip(child.id, group.start + 1, group.y + 30); // Fully inside again.
    const inside = editorController.getSnapshot().clips.find((clip: { id: string }) => clip.id === child.id)!;
    return { rejectedStart: rejected.start, outsideGroupId: outside.groupId ?? null, insideGroupId: inside.groupId ?? null, groupId: group.id };
  });
  expect(boundaryRule.rejectedStart).toBe(5);
  expect(boundaryRule.outsideGroupId).toBeNull();
  expect(boundaryRule.insideGroupId).toBe(boundaryRule.groupId);

  await group.click();
  const beforeSize = await group.boundingBox();
  await dragBy(page, ".timeline-clip.clip-group .group-resize-se", 52, 40);
  const afterSize = await group.boundingBox();
  expect(afterSize!.width).toBeGreaterThan(beforeSize!.width + 35);
  expect(afterSize!.height).toBeGreaterThan(beforeSize!.height + 25);

  await page.locator(".timeline-workspace").click({ button: "right", position: { x: 500, y: 400 } });
  await expect(page.getByRole("menuitem", { name: "グループ" })).toBeVisible();
});

test("nested groups receive click focus and their contents stay in front", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void };
    controller.update({
      clips: [
        { id: "outer-group", name: "外側グループ", kind: "group", color: "#4f6880", start: 1, y: 40, duration: 20, offset: 0, groupHeight: 320 },
        { id: "inner-group", name: "内側グループ", kind: "group", color: "#617f91", start: 3, y: 90, duration: 12, offset: 0, groupHeight: 190, groupId: "outer-group" },
        { id: "nested-title", name: "内側テキスト", text: "Nested", kind: "title", color: "#9169b6", start: 4, y: 130, duration: 5, offset: 0, groupId: "inner-group" },
      ],
      selectedClipId: "outer-group",
      selectedClipIds: ["outer-group"],
    });
  });

  const outer = page.locator('[data-clip-id="outer-group"]');
  const inner = page.locator('[data-clip-id="inner-group"]');
  const title = page.locator('[data-clip-id="nested-title"]');
  const layers = await Promise.all([outer, inner, title].map(async (locator) => Number.parseInt((await locator.evaluate((element) => getComputedStyle(element).zIndex)), 10)));
  expect(layers[1]).toBeGreaterThan(layers[0]);
  expect(layers[2]).toBeGreaterThan(layers[1]);
  await expect(inner).toHaveAttribute("data-nesting-depth", "1");
  await expect(title).toHaveAttribute("data-nesting-depth", "2");

  await inner.click({ position: { x: 12, y: 12 } });
  await expect(inner).toHaveClass(/selected/);
  await expect(outer).not.toHaveClass(/selected/);
  await expect(page.locator(".selected-clip")).toContainText("内側グループ");

  await title.click();
  await expect(title).toHaveClass(/selected/);
  await expect(page.locator(".selected-clip")).toContainText("内側テキスト");
});

test("nearby timeline edges show an alignment suggestion and snap while dragging or resizing", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void };
    controller.update({
      clips: [
        { id: "align-moving", name: "揃える側", text: "A", kind: "title", color: "#9169b6", start: 1, y: 80, duration: 3, offset: 0 },
        { id: "align-target", name: "基準側", text: "B", kind: "title", color: "#66809a", start: 6, y: 160, duration: 2, offset: 0 },
      ],
      selectedClipId: "align-moving",
      selectedClipIds: ["align-moving"],
    });
  });

  const moving = page.locator('[data-clip-id="align-moving"]');
  const box = await moving.boundingBox();
  if (!box) throw new Error("moving clip is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 52, box.y + box.height / 2, { steps: 5 });
  const guide = page.locator(".timeline-alignment-guide");
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("data-target-clip-id", "align-target");
  await expect(guide).toHaveAttribute("data-moving-edge", "end");
  await expect(moving).toHaveAttribute("data-start", "3");
  await page.mouse.up();
  await expect(guide).toHaveCount(0);

  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.moveClip("align-moving", 1, 80);
  });
  const endHandle = moving.locator(".trim-end");
  const handleBox = await endHandle.boundingBox();
  if (!handleBox) throw new Error("resize handle is not visible");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 52, handleBox.y + handleBox.height / 2, { steps: 5 });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("data-moving-edge", "end");
  await expect(moving).toHaveAttribute("data-duration", "5");
  await page.mouse.up();
  await expect(guide).toHaveCount(0);

  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void };
    const clips = editorController.getSnapshot().clips.map((clip: { id: string; y: number; start: number; duration: number }) => clip.id === "align-target" ? { ...clip, y: 400 } : clip.id === "align-moving" ? { ...clip, start: 1, duration: 3, y: 80 } : clip);
    controller.update({ clips });
  });
  const farBox = await moving.boundingBox();
  if (!farBox) throw new Error("moving clip is not visible");
  await page.mouse.move(farBox.x + farBox.width / 2, farBox.y + farBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(farBox.x + farBox.width / 2 + 52, farBox.y + farBox.height / 2, { steps: 5 });
  await expect(guide).toHaveCount(0);
  await page.mouse.up();
});

test("requested panels expose export and metadata without the tool rail", async ({ page }) => {
  await expect(page.locator("#main > aside")).toHaveCount(0);
  const mediaTabs = page.locator("#main > section").nth(0).locator(":scope > div").nth(0).locator(":scope > button");
  await expect(mediaTabs).toHaveCount(3);
  await expect(mediaTabs.nth(1)).toHaveText("出力");
  await expect(mediaTabs.nth(2)).toHaveText("設定");
  await mediaTabs.nth(1).click();
  await expect(page.locator(".export-panel")).toBeVisible();
  await expect(page.locator(".export-field", { hasText: "ビットレート" })).toBeVisible();

  const inspectorTabs = page.locator("#main > section").nth(2).locator(":scope > div").nth(0).locator(":scope > button");
  await inspectorTabs.nth(1).click();
  await expect(page.locator(".metadata-empty")).toContainText("選択してください");
});

test("requested chrome is removed and inspector sections compact below fixed headers", async ({ page }) => {
  await seedTimeline(page);
  await expect(page.locator("#main > .panel-resizer > span")).toHaveCount(0);
  await expect(page.locator("#main > section").nth(1).locator(":scope > .preview-header")).toHaveCount(0);
  await expect(page.locator("#main > section").nth(2).locator(":scope > .selected-clip > .clip-icon")).toHaveCount(0);

  const firstSection = page.locator(".inspector-panel > .inspector-section").first();
  const body = firstSection.locator(":scope > .section-body");
  await expect(body).toBeVisible();
  await firstSection.locator(":scope > .section-title > .section-collapse-toggle").click();
  await expect(firstSection).toHaveClass(/compact/);
  await expect(body).toHaveCount(0);
  await firstSection.locator(":scope > .section-title > .section-collapse-toggle").click();
  await expect(body).toBeVisible();

  const inspector = page.locator(".inspector-panel");
  const tabs = page.locator(".inspector-tabs");
  const selection = page.locator(".selected-clip");
  const before = { tabs: await tabs.boundingBox(), selection: await selection.boundingBox() };
  await inspector.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => inspector.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const after = { tabs: await tabs.boundingBox(), selection: await selection.boundingBox() };
  expect(Math.round(after.tabs!.y)).toBe(Math.round(before.tabs!.y));
  expect(Math.round(after.selection!.y)).toBe(Math.round(before.selection!.y));
});

test("media items drag into the free timeline canvas", async ({ page }) => {
  await seedTimeline(page);
  const clips = page.locator(".timeline-clip");
  await expect(clips).toHaveCount(1);
  const source = page.locator(".media-card", { hasText: "Seed.png" });
  const target = page.locator(".timeline-workspace");
  await source.dragTo(target, { targetPosition: { x: 520, y: 260 } });
  await expect(clips).toHaveCount(2);
  const copies = page.locator(".timeline-clip", { hasText: "Seed.png" });
  await expect(copies).toHaveCount(2);
});

test("media panel opens a directory and expands it like a file explorer", async ({ page }) => {
  await page.evaluate(() => {
    const shot = { kind: "file", name: "shot-01.png", getFile: async () => {
      const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
      const context = canvas.getContext("2d")!; context.fillStyle = "#4179a3"; context.fillRect(0, 0, 8, 8);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      return new File([blob], "shot-01.png", { type: "image/png" });
    } };
    const notes = { kind: "file", name: "notes.txt", getFile: async () => new File([], "notes.txt", { type: "text/plain" }) };
    const poster = { kind: "file", name: "poster.png", getFile: async () => {
      const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 8;
      const context = canvas.getContext("2d")!; context.fillStyle = "#8a4f72"; context.fillRect(0, 0, 12, 8);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      return new File([blob], "poster.png", { type: "image/png" });
    } };
    const footage = { kind: "directory", name: "Footage", async *values() { yield shot; yield poster; yield notes; } };
    const audio = { kind: "file", name: "theme.wav", getFile: async () => new File([], "theme.wav", { type: "audio/wav" }) };
    const root = { kind: "directory", name: "Project Media", async *values() { yield audio; yield footage; } };
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => root });
  });
  await page.getByRole("button", { name: "フォルダを開く" }).click();
  await expect(page.getByRole("tree", { name: "メディアエクスプローラー" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Project Media フォルダ" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Footage フォルダ" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "theme.wav", exact: true })).toBeVisible();
  await page.getByRole("treeitem", { name: "Footage フォルダ" }).click();
  await expect(page.getByRole("treeitem", { name: "shot-01.png", exact: true })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "notes.txt", exact: true })).toHaveClass(/unsupported/);
  await page.getByPlaceholder("フォルダ内を検索").fill("shot-01");
  const shot = page.getByRole("treeitem", { name: "shot-01.png", exact: true });
  await expect(shot).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "theme.wav", exact: true })).toBeHidden();
  await shot.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 120, y: 120 } });
  await expect(page.locator(".timeline-clip", { hasText: "shot-01.png" })).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder("フォルダ内を検索").fill("");
  await page.getByRole("button", { name: "グリッド表示" }).click();
  await expect(page.getByRole("list", { name: "メディアグリッド" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Footage フォルダを開く" })).toBeVisible();
  await page.getByRole("button", { name: "Footage フォルダを開く" }).click();
  const gridShot = page.getByRole("button", { name: "shot-01.png", exact: true });
  await expect(gridShot).toBeVisible();
  const posterCard = page.getByRole("button", { name: "poster.png", exact: true });
  const posterThumbnail = posterCard.locator("img.explorer-image-thumbnail");
  await expect(posterThumbnail).toBeVisible();
  await expect.poll(() => posterThumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await posterCard.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 300, y: 180 } });
  await expect(page.locator(".timeline-clip", { hasText: "poster.png" })).toBeVisible({ timeout: 15_000 });
  await gridShot.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 220, y: 140 } });
  await expect(page.locator(".timeline-clip", { hasText: "shot-01.png" })).toHaveCount(2);
  await expect(page.locator(".explorer-breadcrumbs .current")).toHaveText("Footage");
  await page.getByRole("button", { name: "上のフォルダへ" }).click();
  await expect(page.getByRole("button", { name: "theme.wav", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "階層表示" }).click();
  await expect(page.getByRole("tree", { name: "メディアエクスプローラー" })).toBeVisible();
});

test("timeline ruler element is removed", async ({ page }) => {
  const timeline = page.locator("#main > section").nth(3);
  await expect(timeline.locator(":scope > .timeline-toolbar")).toHaveCount(0);
  await expect(timeline.locator(":scope > .timeline-scroll > .timeline-workspace")).toBeVisible();
  await expect(page.locator(".free-ruler, .ruler")).toHaveCount(0);
});

test("timeline zoom uses Ctrl-wheel and trackpad pinch wheel events", async ({ page }) => {
  const timeline = page.locator(".timeline-scroll");
  await timeline.hover({ position: { x: 300, y: 120 } });
  const zoom = async () => page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().zoom;
  });
  expect(await zoom()).toBe(1);
  await page.mouse.wheel(0, -120);
  expect(await zoom()).toBe(1);

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(zoom).toBeGreaterThan(1);
  const afterMouseZoom = await zoom();

  await timeline.dispatchEvent("wheel", { ctrlKey: true, deltaY: 90, deltaMode: 0, clientX: 300, clientY: 120 });
  await expect.poll(zoom).toBeLessThan(afterMouseZoom);
});

test("media and graphics worker becomes ready", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const gpu = page.locator(".gpu-context");
  await expect(gpu).toContainText(/WebGPU|WebGL/);
  await expect(page.locator(".status-center > span")).toHaveCount(2);
  await expect(page.locator(".status-bar")).not.toContainText("MediaBunny");
  await expect(page.locator(".status-bar")).not.toContainText("File System");
  const gpuBox = await gpu.boundingBox();
  expect(gpuBox!.x).toBeLessThan(80);
  await expect(page.locator(".preview-stage canvas")).toHaveAttribute("data-camera-projection", "orthographic");
});

test("pure white is the UI accent and Space controls playback from every focus", async ({ page }) => {
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).toBe("#fff");
  const playing = async () => page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().playing;
  });

  const search = page.locator(".search-box input");
  await search.focus();
  await page.keyboard.press("Space");
  await expect.poll(playing).toBe(true);
  await expect(search).toHaveValue("");

  await page.getByRole("button", { name: "メディア", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect.poll(playing).toBe(false);
});

test("128 MB H.264 RAM preview is live when stopped and cached during playback", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const meter = page.locator(".cache-meter");
  await expect(meter).toContainText("128 MB");
  await expect(meter).not.toHaveAttribute("data-cache-entries", "0", { timeout: 20_000 });
  const canvas = page.locator(".preview-stage canvas");
  await expect(canvas).toHaveAttribute("data-preview-source", "realtime");
  await page.locator(".play-button").click();
  await expect(canvas).not.toHaveAttribute("data-cache-frames", "0", { timeout: 20_000 });
  await page.locator(".play-button").click();
  await expect(canvas).toHaveAttribute("data-preview-source", "realtime", { timeout: 20_000 });
});

test("settings control RAM preview capacity and audio channels persistently", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByText("エディター設定")).toBeVisible();

  const enabled = page.getByRole("checkbox", { name: "RAMプレビューを有効化" });
  const capacity = page.getByRole("spinbutton", { name: "RAMプレビュー容量" });
  await expect(enabled).toBeChecked();
  await expect(capacity).toHaveValue("128");
  await capacity.fill("256");
  await capacity.blur();
  await expect(page.locator(".cache-meter")).toContainText("256 MB");

  await enabled.uncheck();
  await expect(page.locator(".cache-meter")).toHaveAttribute("data-cache-enabled", "false");
  await expect(page.locator(".cache-meter")).toContainText("無効");
  await expect(page.locator(".cache-meter")).toHaveAttribute("data-cache-entries", "0");

  await page.getByRole("radio", { name: /モノラル/ }).check();
  await expect(page.getByRole("radio", { name: /モノラル/ })).toBeChecked();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("gfxutl:settings") ?? "null"))).toEqual({
    ramPreviewEnabled: false,
    ramPreviewMaxBytes: 256 * 1024 * 1024,
    audioChannels: "mono",
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "RAMプレビューを有効化" })).not.toBeChecked();
  await expect(page.getByRole("spinbutton", { name: "RAMプレビュー容量" })).toHaveValue("256");
  await expect(page.getByRole("radio", { name: /モノラル/ })).toBeChecked();
});

test("inspector effects can be stacked, reordered, toggled, and removed", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await seedTimeline(page);
  const stack = page.locator(".effect-stack");
  await expect(stack).toBeVisible();
  const canvas = page.locator(".preview-stage canvas");
  const renderedBefore = Number(await canvas.getAttribute("data-preview-frames"));
  const selector = stack.getByLabel("追加する効果");
  await selector.selectOption("brightness");
  await stack.getByRole("button", { name: "効果を追加" }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-preview-frames")), { timeout: 1_000 }).toBeGreaterThan(renderedBefore);
  await selector.selectOption("opacity");
  await stack.getByRole("button", { name: "効果を追加" }).click();
  await expect(stack.locator(".effect-card")).toHaveCount(2);
  await expect(stack.locator(".effect-card").nth(0)).toHaveAttribute("data-effect-kind", "brightness");
  await stack.locator(".effect-card").nth(1).getByRole("button", { name: "上へ" }).click();
  await expect(stack.locator(".effect-card").nth(0)).toHaveAttribute("data-effect-kind", "opacity");
  await stack.locator(".effect-card").nth(0).getByRole("button", { name: /透明度を無効化/ }).click();
  await expect(stack.locator(".effect-card").nth(0)).toHaveClass(/disabled/);
  await stack.locator(".effect-card").nth(1).getByRole("button", { name: "効果を削除" }).click();
  await expect(stack.locator(".effect-card")).toHaveCount(1);
});

test("starts as an empty white project without a header or template", async ({ page }) => {
  await expect(page.locator("#main > header")).toHaveCount(0);
  await expect(page.locator(".media-card")).toHaveCount(0);
  await expect(page.locator(".timeline-clip")).toHaveCount(0);
  await expect(page.locator(".preview-copy")).toHaveCount(0);
  await expect(page.locator(".preview-stage")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  const state = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot();
  });
  expect(state.assets).toHaveLength(0);
  expect(state.clips).toHaveLength(0);
});

test("project state is persisted per FileSystemFileHandle in IndexedDB", async ({ page }) => {
  const restored = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const store = await import("/core/persistence/handle-project-store.ts");
    // Chromium headless currently crashes when OPFS handles are created with SwiftShader;
    // a structured-cloneable handle-shaped value exercises the same idb-keyval record path.
    const handle = { kind: "file", name: "idb-handle.webm" } as FileSystemFileHandle;
    const asset = { id: "persisted-asset", name: handle.name, kind: "video" as const, duration: 4, size: 10, color: "#777", handle };
    const clip = { id: "persisted-clip", assetId: asset.id, name: asset.name, kind: "video" as const, y: 30, start: 1, duration: 3, offset: 0, color: "#777" };
    const title = { id: "persisted-title", name: "Persisted title", text: "Persisted title", kind: "title" as const, y: 10, start: 1, duration: 3, offset: 0, color: "#765" };
    await store.saveHandleProject(asset, [clip, title]);
    const records = await store.loadHandleProjects();
    const record = records.find((item: { asset: { id: string } }) => item.asset.id === asset.id)!;
    return { handleName: record.handle.name, assetId: record.asset.id, clipId: record.clips[0]?.id, titleId: record.clips[1]?.id };
  });
  expect(restored).toEqual({ handleName: "idb-handle.webm", assetId: "persisted-asset", clipId: "persisted-clip", titleId: "persisted-title" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".media-card", { hasText: "idb-handle.webm" })).toBeVisible();
  await expect(page.locator(".timeline-clip", { hasText: "idb-handle.webm" })).toBeVisible();
  await expect(page.locator(".timeline-clip", { hasText: "Persisted title" })).toBeVisible();
  await expect(page.locator(".media-file-status", { hasText: "再接続" })).toBeVisible();
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const store = await import("/core/persistence/handle-project-store.ts");
    await store.removeHandleProject("persisted-asset");
  });
});

test("export produces a playable media container", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(() => Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined }));
  await page.locator(".panel-tabs > button", { hasText: "出力" }).click();
  await page.locator(".export-field", { hasText: "形式" }).locator("select").selectOption("webm");
  await page.getByLabel("終了時間").fill("0.2");
  await page.locator(".export-dimensions input").nth(0).fill("64");
  await page.locator(".export-dimensions input").nth(1).fill("64");
  await page.locator(".export-field", { hasText: "フレームレート" }).locator("select").selectOption("24");
  await page.locator(".export-field", { hasText: "ビットレート" }).locator("input").fill("1");
  const outcomePromise = Promise.race([
    page.waitForEvent("download", { timeout: 45_000 }).then((download) => ({ download, error: null })),
    page.locator(".toast").waitFor({ state: "visible", timeout: 45_000 }).then(async () => ({ download: null, error: await page.locator(".toast").textContent() })),
  ]);
  await page.locator(".export-submit").click();
  const outcome = await outcomePromise;
  if (!outcome.download) throw new Error(outcome.error ?? "Export failed");
  const download = outcome.download;
  expect(download.suggestedFilename()).toBe("Untitled Project.webm");
  const path = await download.path();
  expect(path).toBeTruthy();
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  expect(bytes).toBeGreaterThan(0);
});

test("Three geometry factory creates every supported core geometry", async ({ page }) => {
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { createGeometry } = await import("/core/engine/three-geometry-factory.ts");
    const tetraVertices = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1];
    const tetraIndices = [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1];
    const specs = [
      { id: "box", kind: "box" }, { id: "capsule", kind: "capsule" }, { id: "circle", kind: "circle" },
      { id: "cone", kind: "cone" }, { id: "cylinder", kind: "cylinder" }, { id: "dodecahedron", kind: "dodecahedron" },
      { id: "icosahedron", kind: "icosahedron" }, { id: "octahedron", kind: "octahedron" }, { id: "plane", kind: "plane" },
      { id: "ring", kind: "ring" }, { id: "sphere", kind: "sphere" }, { id: "tetrahedron", kind: "tetrahedron" },
      { id: "torus", kind: "torus" }, { id: "torusKnot", kind: "torusKnot" },
      { id: "lathe", kind: "lathe", points2D: [[0, -1], [1, 0], [0, 1]] },
      { id: "shape", kind: "shape", points2D: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { id: "extrude", kind: "extrude", points2D: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { id: "tube", kind: "tube", points3D: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]] },
      { id: "polyhedron", kind: "polyhedron", vertices: tetraVertices, indices: tetraIndices },
      { id: "edges", kind: "edges", source: { kind: "box" } },
      { id: "wireframe", kind: "wireframe", source: { kind: "sphere" } },
      { id: "buffer", kind: "buffer", vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
      { id: "text", kind: "text", text: "GfxUtl", size: 1, depth: 0.1 },
    ];
    return specs.map((spec) => {
      const geometry = createGeometry(spec as never);
      const count = geometry.getAttribute("position").count;
      geometry.dispose();
      return count;
    });
  });
  expect(result).toHaveLength(23);
  expect(result.every((count) => count > 0)).toBe(true);
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.upsertGeometry({ id: "runtime-torus", geometry: { id: "runtime-torus-geometry", kind: "torusKnot", args: [1, 0.3, 64, 8] }, material: { color: 0xdf7d45 }, transform: { position: [0, 0, 4] } });
  });
  await expect(page.locator(".preview-stage canvas")).toHaveAttribute("data-geometry-objects", "1");
});

test("custom context menu adds and edits text and supports clipboard operations", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const workspace = page.locator(".timeline-workspace");
  await workspace.click({ button: "right", position: { x: 240, y: 120 } });
  const menu = page.getByRole("menu", { name: "編集メニュー" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "テキスト" }).click();
  await expect(page.locator(".timeline-clip")).toHaveCount(1);
  await expect(page.getByLabel("テキスト内容")).toBeVisible();
  await page.getByLabel("テキスト内容").fill("Mesh Text");
  await expect(page.locator(".timeline-clip")).toContainText("Mesh Text");
  await expect(page.locator(".preview-stage canvas")).not.toHaveAttribute("data-geometry-objects", "0", { timeout: 10_000 });

  await page.locator(".timeline-clip").click({ button: "right" });
  await page.getByRole("menuitem", { name: /コピー/ }).click();
  await workspace.click({ button: "right", position: { x: 430, y: 210 } });
  await page.getByRole("menuitem", { name: /貼り付け/ }).click();
  await expect(page.locator(".timeline-clip")).toHaveCount(2);
  await page.locator(".timeline-clip").last().click({ button: "right" });
  await page.getByRole("menuitem", { name: /切り取り/ }).click();
  await expect(page.locator(".timeline-clip")).toHaveCount(1);
});

test("dragging empty timeline space box-selects multiple clips", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void };
    controller.update({
      clips: [
        { id: "box-a", name: "Box A", kind: "title", text: "A", y: 80, start: 2, duration: 2, offset: 0, color: "#765" },
        { id: "box-b", name: "Box B", kind: "object", geometry: { id: "g", kind: "box" }, y: 155, start: 4, duration: 2, offset: 0, color: "#567" },
      ],
      selectedClipId: null,
      selectedClipIds: [],
    });
  });
  const box = await page.locator(".timeline-workspace").boundingBox();
  if (!box) throw new Error("timeline workspace is not visible");
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 230, { steps: 6 });
  await expect(page.locator(".timeline-selection-box")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".timeline-clip.selected")).toHaveCount(2);
  const selected = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().selectedClipIds;
  });
  expect(selected.sort()).toEqual(["box-a", "box-b"]);
});

test("timeline context menu cuts at the pointer and toggles magnet", async ({ page }) => {
  await seedTimeline(page);
  const clip = page.locator(".timeline-clip", { hasText: "Seed.png" });
  await clip.click({ button: "right", position: { x: 90, y: 20 } });
  await expect(page.getByRole("menuitem", { name: /カット/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /カット/ }).click();
  await expect(page.locator(".timeline-clip")).toHaveCount(2);
  const durations = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips.map((clip: { duration: number }) => clip.duration);
  });
  expect(durations.reduce((sum: number, duration: number) => sum + duration, 0)).toBeCloseTo(5);

  await page.locator(".timeline-workspace").click({ button: "right", position: { x: 360, y: 250 } });
  const magnet = page.getByRole("menuitemcheckbox", { name: /マグネット/ });
  await expect(magnet).toHaveAttribute("aria-checked", "true");
  await magnet.click();
  const snapEnabled = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().snapEnabled;
  });
  expect(snapEnabled).toBe(false);
});

test("smaller timeline y renders in front across videos and Three objects", async ({ page }) => {
  const orders = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as { update(patch: unknown): void; getRenderClips(): Array<{ id: string; renderOrder: number; sceneObject?: { renderOrder?: number; material?: { transparent?: boolean } } }> };
    controller.update({ clips: [
      { id: "lower-video", name: "Lower", kind: "video", y: 240, start: 0, duration: 5, offset: 0, color: "#555" },
      { id: "upper-object", name: "Upper", kind: "object", y: 20, start: 0, duration: 5, offset: 0, color: "#777", geometry: { id: "upper-g", kind: "box" } },
    ] });
    return controller.getRenderClips().map((clip) => ({ id: clip.id, order: clip.renderOrder, objectOrder: clip.sceneObject?.renderOrder, transparent: clip.sceneObject?.material?.transparent }));
  });
  const lower = orders.find((item) => item.id === "lower-video")!;
  const upper = orders.find((item) => item.id === "upper-object")!;
  expect(upper.order).toBeGreaterThan(lower.order);
  expect(upper.objectOrder).toBe(upper.order);
  expect(upper.transparent).toBe(true);
});

test("object z coordinates override timeline y and are editable", async ({ page }) => {
  const ordering = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const controller = editorController as unknown as {
      update(patch: unknown): void;
      selectClip(id: string): void;
      getRenderClips(): Array<{ id: string; positionZ: number; renderOrder: number; sceneObject?: { transform?: { position?: [number, number, number] } } }>;
    };
    controller.update({ clips: [
      { id: "z-back", name: "Back", kind: "object", y: 20, positionZ: 0, start: 0, duration: 5, offset: 0, color: "#555", geometry: { id: "back-g", kind: "box" } },
      { id: "z-front", name: "Front", kind: "object", y: 240, positionZ: 120, start: 0, duration: 5, offset: 0, color: "#777", geometry: { id: "front-g", kind: "sphere" } },
    ] });
    controller.selectClip("z-front");
    return controller.getRenderClips().map((clip) => ({ id: clip.id, z: clip.positionZ, order: clip.renderOrder, worldZ: clip.sceneObject?.transform?.position?.[2] }));
  });
  const back = ordering.find((item) => item.id === "z-back")!;
  const front = ordering.find((item) => item.id === "z-front")!;
  expect(front.order).toBeGreaterThan(back.order);
  expect(front.z).toBe(120);
  expect(front.worldZ).toBeCloseTo(1.2);

  const zInput = page.locator(".number-field", { hasText: "位置 Z" }).locator("input");
  await expect(zInput).toHaveValue("120");
  const positionFields = page.locator(".transform-position-grid > .number-field");
  await expect(positionFields).toHaveCount(3);
  const positionRows = await positionFields.evaluateAll((fields) => fields.map((field) => Math.round(field.getBoundingClientRect().top)));
  expect(new Set(positionRows).size).toBe(1);
  await zInput.fill("240");
  await expect.poll(async () => page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips.find((clip: { id: string }) => clip.id === "z-front")?.positionZ;
  })).toBe(240);
});

test("multiple Three objects remain active and render simultaneously", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const canvas = page.locator(".preview-stage canvas");
  const before = await canvas.screenshot();
  const placements = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addGeometryObject("box", { time: 0, timelineY: 40, positionX: 0, positionY: 0 });
    editorController.addGeometryObject("sphere", { time: 0, timelineY: 110, positionX: 0, positionY: 0 });
    return editorController.getSnapshot().clips.map((clip: { positionX?: number; positionY?: number }) => [clip.positionX, clip.positionY]);
  });
  expect(placements[0]).not.toEqual(placements[1]);
  await expect(canvas).toHaveAttribute("data-active-scene-objects", "2", { timeout: 10_000 });
  await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 10_000 }).toBe(false);
  await page.setViewportSize({ width: 1380, height: 860 });
  await expect(canvas).toHaveAttribute("data-active-scene-objects", "2", { timeout: 10_000 });
  await expect(page.locator(".timeline-clip")).toHaveCount(2);
});

test("paused preview hover shows eight dimension handles and one rotation handle", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addGeometryObject("box", { time: 0, timelineY: 40, positionX: 0, positionY: 0 });
  });
  const stage = page.locator(".preview-stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error("preview stage is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const transformBox = page.locator(".preview-transform-box");
  await expect(transformBox).toBeVisible();
  await expect(transformBox.locator(".dimension-handle")).toHaveCount(8);
  await expect(transformBox.locator(".rotation-handle")).toHaveCount(1);
  const east = await transformBox.locator(".handle-e").boundingBox();
  if (!east) throw new Error("east resize handle is not visible");
  await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2);
  await page.mouse.down();
  await page.mouse.move(east.x + east.width / 2 + 45, east.y + east.height / 2, { steps: 5 });
  await page.mouse.up();
  const resized = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const clip = editorController.getSnapshot().clips[0];
    return { scaleX: clip.scaleX, scaleY: clip.scaleY };
  });
  expect(resized.scaleX).toBeGreaterThan(100);
  expect(resized.scaleY).toBe(100);

  const rotation = await transformBox.locator(".rotation-handle").boundingBox();
  if (!rotation) throw new Error("rotation handle is not visible");
  await page.mouse.move(rotation.x + rotation.width / 2, rotation.y + rotation.height / 2);
  await page.mouse.down();
  await page.mouse.move(rotation.x + rotation.width / 2 + 35, rotation.y + rotation.height / 2 + 16, { steps: 5 });
  await page.mouse.up();
  const angle = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips[0].rotation;
  });
  expect(Math.abs(angle)).toBeGreaterThan(5);
  await page.locator(".play-button").click();
  await expect(transformBox).toHaveCount(0);
});

test("preview objects drag directly and carry their position keyframes", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addGeometryObject("box", { time: 0, timelineY: 40, positionX: 0, positionY: 0 });
    const id = editorController.getSnapshot().clips[0].id;
    editorController.updateClip(id, { keyframes: [
      { id: "move-x", property: "positionX", time: 0, value: 0, interpolation: "linear" },
      { id: "move-y", property: "positionY", time: 0, value: 0, interpolation: "linear" },
    ] });
  });
  const stage = page.locator(".preview-stage");
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error("preview stage is not visible");
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  const transformBox = page.locator(".preview-transform-box");
  await expect(transformBox).toBeVisible();
  const bounds = await transformBox.boundingBox();
  if (!bounds) throw new Error("preview transform box is not visible");
  const canvas = page.locator(".preview-stage canvas");
  const renderedBeforeDrag = Number(await canvas.getAttribute("data-preview-frames"));
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 62, bounds.y + bounds.height / 2 + 35, { steps: 6 });
  await page.mouse.up();

  const moved = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    const clip = editorController.getSnapshot().clips[0];
    return { positionX: clip.positionX, positionY: clip.positionY, keyframes: clip.keyframes };
  });
  expect(moved.positionX).toBeGreaterThan(100);
  expect(moved.positionY).toBeGreaterThan(50);
  expect(moved.keyframes?.find((keyframe: { property: string }) => keyframe.property === "positionX")?.value).toBeCloseTo(moved.positionX!, 4);
  expect(moved.keyframes?.find((keyframe: { property: string }) => keyframe.property === "positionY")?.value).toBeCloseTo(moved.positionY!, 4);
  await expect.poll(async () => Number(await canvas.getAttribute("data-preview-frames")), { timeout: 1_500 }).toBeGreaterThan(renderedBeforeDrag);
});

test("images render through Three and media clips share resize handles", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(() => Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined }));
  const pngBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120; canvas.height = 60;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e54b2f"; context.fillRect(0, 0, 60, 60);
    context.fillStyle = "#2679c9"; context.fillRect(60, 0, 60, 60);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "読み込む" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "still.png", mimeType: "image/png", buffer: Buffer.from(pngBytes) });
  const card = page.locator(".media-card", { hasText: "still.png" });
  await expect(card).toContainText("120 × 60");
  await card.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 20, y: 80 } });
  const canvas = page.locator(".preview-stage canvas");
  await expect(canvas).toHaveAttribute("data-active-image-objects", "1", { timeout: 10_000 });

  const stage = page.locator(".preview-stage");
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error("preview stage is not visible");
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  const east = await page.locator(".preview-transform-box .handle-e").boundingBox();
  if (!east) throw new Error("media resize handle is not visible");
  await page.mouse.move(east.x + 4, east.y + 4); await page.mouse.down();
  await page.mouse.move(east.x + 44, east.y + 4, { steps: 4 }); await page.mouse.up();
  const scaleX = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips[0].scaleX;
  });
  expect(scaleX).toBeGreaterThan(100);
});

test("audio imports and follows timeline transport", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(() => Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined }));
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "読み込む" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: createWavBuffer(2) });
  const card = page.locator(".media-card", { hasText: "tone.wav" });
  await expect(card).toBeVisible();
  await card.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 4, y: 90 } });
  await expect(page.locator(".timeline-clip.clip-audio")).toBeVisible();
  await page.evaluate(() => {
    const prototype = AudioContext.prototype;
    const original = prototype.createBufferSource;
    const originalCreateBuffer = prototype.createBuffer;
    Object.defineProperty(window, "__gfxutlAudioSources", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, "__gfxutlAudioChannels", { configurable: true, writable: true, value: 0 });
    prototype.createBufferSource = function (...args) {
      (window as typeof window & { __gfxutlAudioSources: number }).__gfxutlAudioSources++;
      return original.apply(this, args);
    };
    prototype.createBuffer = function (numberOfChannels, ...args) {
      (window as typeof window & { __gfxutlAudioChannels: number }).__gfxutlAudioChannels = numberOfChannels;
      return originalCreateBuffer.call(this, numberOfChannels, ...args);
    };
  });
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("radio", { name: /モノラル/ }).check();
  const canvas = page.locator(".preview-stage canvas");
  await page.locator(".play-button").click();
  await expect(canvas).toHaveAttribute("data-playing-audio-objects", "1");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __gfxutlAudioSources?: number }).__gfxutlAudioSources ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __gfxutlAudioChannels?: number }).__gfxutlAudioChannels ?? 0), { timeout: 10_000 }).toBe(1);
  await page.locator(".play-button").click();
  await expect(canvas).toHaveAttribute("data-playing-audio-objects", "0");
});

test("video audio is decoded by MediaBunny and played through Web Audio", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const context2d = canvas.getContext("2d", { alpha: false })!;
    const videoStream = canvas.captureStream(12);
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    oscillator.connect(destination);
    oscillator.start();
    await audioContext.resume();
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start(80);
    for (let frame = 0; frame < 24; frame++) {
      context2d.fillStyle = frame % 2 ? "#fff" : "#315f8a";
      context2d.fillRect(0, 0, 64, 64);
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    recorder.stop();
    await stopped;
    oscillator.stop();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
    return Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()));
  });

  await page.evaluate(() => Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined }));
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "読み込む" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "video-with-audio.webm", mimeType: "video/webm", buffer: Buffer.from(bytes) });
  const card = page.locator(".media-card", { hasText: "video-with-audio.webm" });
  await expect(card).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().assets.find((asset: { name: string }) => asset.name === "video-with-audio.webm")?.hasAudio;
  }), { timeout: 15_000 }).toBe(true);
  await card.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 8, y: 120 } });
  await expect(page.locator(".timeline-clip.clip-video")).toBeVisible();
  await page.evaluate(() => {
    const prototype = AudioContext.prototype;
    const original = prototype.createBufferSource;
    Object.defineProperty(window, "__gfxutlVideoAudioSources", { configurable: true, writable: true, value: 0 });
    prototype.createBufferSource = function (...args) {
      (window as typeof window & { __gfxutlVideoAudioSources: number }).__gfxutlVideoAudioSources++;
      return original.apply(this, args);
    };
  });
  const canvas = page.locator(".preview-stage canvas");
  await page.locator(".play-button").click();
  await expect(canvas).toHaveAttribute("data-playing-audio-objects", "1");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __gfxutlVideoAudioSources?: number }).__gfxutlVideoAudioSources ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.locator(".play-button").click();
});

test("timeline uses a crosshair and a vertical cursor guide", async ({ page }) => {
  const workspace = page.locator(".timeline-workspace");
  await expect(workspace).toHaveCSS("cursor", "crosshair");
  const box = await workspace.boundingBox();
  if (!box) throw new Error("timeline workspace is not visible");
  await page.mouse.move(box.x + 240, box.y + 120);
  const guide = page.locator(".timeline-cursor-guide");
  await expect(guide).toBeVisible();
  const left = parseFloat((await guide.getAttribute("style"))?.match(/left:\s*([\d.]+)px/)?.[1] ?? "0");
  expect(left).toBeGreaterThan(200);
});

test("timeline reels use the compact width and height", async ({ page }) => {
  await seedTimeline(page);
  const box = await page.locator(".timeline-clip", { hasText: "Seed.png" }).boundingBox();
  if (!box) throw new Error("timeline reel is not visible");
  expect(box.width).toBeLessThanOrEqual(132);
  expect(box.height).toBeLessThanOrEqual(32);
});

test("text inspector exposes depth and rendered outline decoration", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.addTextObject({ time: 0, timelineY: 40, positionX: 0, positionY: 0 });
  });
  await expect(page.getByText("奥行き", { exact: true })).toBeVisible();
  await expect(page.getByText("枠線", { exact: true })).toBeVisible();
  await expect(page.getByLabel("枠線色")).toBeVisible();
  const canvas = page.locator(".preview-stage canvas");
  const before = Number(await canvas.getAttribute("data-geometry-objects"));
  const outlineWidth = page.locator(".text-inspector .number-field", { hasText: "太さ" }).locator("input");
  await outlineWidth.fill("1.5");
  await outlineWidth.press("Enter");
  await page.getByLabel("枠線色").fill("#ff4400");
  await expect.poll(async () => Number(await canvas.getAttribute("data-geometry-objects")), { timeout: 10_000 }).toBeGreaterThan(before);
  const state = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips[0];
  });
  expect(state.textOutlineWidth).toBe(1.5);
  expect(state.textOutlineColor).toBe(0xff4400);
});

test("text outline uses fixed 3D normal extrusion and renders only back faces", async ({ page }) => {
  const outline = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { createNormalExtrudedOutlineMaterial } = await import("/core/engine/three-scene-core.ts");
    const material = createNormalExtrudedOutlineMaterial({ outlineColor: 0xff4400, opacity: 0.75 }, 1.5);
    const result = {
      nodeMaterial: material.isMeshBasicNodeMaterial,
      hasVertexDisplacement: Boolean(material.positionNode),
      side: material.side,
      transparent: material.transparent,
      mode: material.userData.gfxOutlineMode,
      width: material.userData.gfxOutlineWidth,
    };
    material.dispose();
    return result;
  });
  expect(outline).toEqual({
    nodeMaterial: true,
    hasVertexDisplacement: true,
    side: 1, // THREE.BackSide
    transparent: true,
    mode: "normal-extrusion",
    width: 1.5,
  });
});

test("preview context menu positions a Three object at the pointer", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  await page.locator(".preview-stage").click({ button: "right", position: { x: 180, y: 100 } });
  await page.getByRole("menuitem", { name: "立方体" }).click();
  await expect(page.locator(".timeline-clip", { hasText: "立方体" })).toBeVisible();
  const state = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips[0];
  });
  expect(state.kind).toBe("object");
  expect(state.positionX).not.toBe(0);
  expect(state.positionY).not.toBe(0);
});

test("Local Font Access data is registered for editable text meshes", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const fontBase64 = readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf").toString("base64");
  await page.evaluate((base64) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    Object.defineProperty(window, "queryLocalFonts", { configurable: true, value: async () => [{
      postscriptName: "DejaVuSans", fullName: "DejaVu Sans", family: "DejaVu Sans", style: "Book",
      blob: async () => new Blob([bytes], { type: "font/ttf" }),
    }] });
  }, fontBase64);
  const vertices = await page.evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { registerLocalFont, createGeometry } = await import("/core/engine/three-geometry-factory.ts");
    await registerLocalFont("test-local", bytes.buffer);
    const geometry = createGeometry({ id: "local-text", kind: "text", text: "Local", fontId: "test-local", size: 1, depth: 0.1 });
    const count = geometry.getAttribute("position").count;
    geometry.dispose();
    return count;
  }, fontBase64);
  expect(vertices).toBeGreaterThan(0);
  await page.locator(".timeline-workspace").click({ button: "right", position: { x: 180, y: 90 } });
  await page.getByRole("menuitem", { name: "テキスト" }).click();
  await page.getByRole("button", { name: "ローカルフォントを読込" }).click();
  await expect(page.getByLabel("フォント").locator("option")).toHaveCount(2);
  const canvas = page.locator(".preview-stage canvas");
  const before = Number(await canvas.getAttribute("data-geometry-objects"));
  await page.getByLabel("フォント").selectOption("DejaVuSans");
  await page.getByLabel("テキスト内容").fill("Local Font");
  await expect.poll(async () => Number(await canvas.getAttribute("data-geometry-objects")), { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(page.locator(".font-access-row")).toContainText("DejaVu Sans");
});

test("MediaBunny VideoFrame is rendered through Three VideoFrameTexture", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d", { alpha: false })!;
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start(50);
    for (let frame = 0; frame < 8; frame++) {
      context.fillStyle = frame % 2 ? "#df7d45" : "#315f8a";
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = "white";
      context.fillRect(frame * 6, 20, 14, 24);
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
    await stopped;
    return Array.from(new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()));
  });

  await page.evaluate(() => Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined }));
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "読み込む" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "direct-frame.webm", mimeType: "video/webm", buffer: Buffer.from(bytes) });
  const card = page.locator(".media-card", { hasText: "direct-frame.webm" });
  await expect(card).toContainText("64 × 64", { timeout: 15_000 });
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    editorController.setTime(17 / 30);
  });
  const canvas = page.locator(".preview-stage canvas");
  const before = await canvas.screenshot();
  await card.dragTo(page.locator(".timeline-workspace"), { targetPosition: { x: 20, y: 300 } });
  await expect(canvas).not.toHaveAttribute("data-video-frames", "0", { timeout: 15_000 });
  await page.waitForTimeout(100);
  const after = await canvas.screenshot();
  expect(after.equals(before)).toBe(false);
  const stage = page.locator(".preview-stage");
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error("preview stage is not visible");
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  const east = await page.locator(".preview-transform-box .handle-e").boundingBox();
  if (!east) throw new Error("video resize handle is not visible");
  await page.mouse.move(east.x + 4, east.y + 4); await page.mouse.down();
  await page.mouse.move(east.x + 34, east.y + 4, { steps: 4 }); await page.mouse.up();
  const scaleX = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { editorController } = await import("/core/interface/index.ts");
    return editorController.getSnapshot().clips[0].scaleX;
  });
  expect(scaleX).toBeGreaterThan(100);
});

test("blank preview selects the persistent background object", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const stage = page.locator(".preview-stage");
  const canvas = stage.locator("canvas");
  const before = await canvas.screenshot();
  await stage.click({ position: { x: 12, y: 12 } });
  await expect(page.locator(".selected-clip")).toContainText("背景オブジェクト");
  await expect(page.locator(".background-inspector")).toContainText("THREE.SCENE");
  await page.getByLabel("背景色").fill("#315f8a");
  await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 10_000 }).toBe(false);
});

test("preview canvas pops out and can attach back to the editor", async ({ page }) => {
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/, { timeout: 20_000 });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "プレビューを別ウィンドウで表示" }).click();
  const popup = await popupPromise;
  await expect(page.locator(".preview-popout-placeholder")).toBeVisible();
  await expect(popup.locator("canvas")).toBeVisible();
  await popup.getByRole("button", { name: "プレビューを戻す" }).click();
  await expect(page.locator(".preview-stage canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".engine-light")).toHaveClass(/(webgpu|webgl2)/);
});
