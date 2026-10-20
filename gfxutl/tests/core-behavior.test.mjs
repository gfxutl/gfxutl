import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as THREE from "three";

async function importTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const outputText = stripTypeScriptTypes(source, { mode: "transform" });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("sequenceEnd preserves an explicit duration and expands for content", async () => {
  const { alignExportRangeToSequence, sequenceEnd } = await importTypeScript("../core/interface/sequence-duration.ts");
  assert.equal(sequenceEnd([], 30, 12), 12);
  assert.equal(sequenceEnd([{ start: 2, duration: 3 }], 30, 12), 12);
  assert.equal(sequenceEnd([{ start: 10, duration: 5 }], 30, 12), 15);
  assert.deepEqual(
    alignExportRangeToSequence({ fps: 30, startTime: 4, endTime: 12, format: "mp4" }, 18),
    { fps: 30, startTime: 4, endTime: 18, format: "mp4" },
  );
  assert.deepEqual(
    alignExportRangeToSequence({ fps: 30, startTime: 20, endTime: 24 }, 10),
    { fps: 30, startTime: 10 - 1 / 30, endTime: 10 },
  );
});

test("Google Fonts catalog entries use jsDelivr repository paths", async () => {
  const { googleFontsCdnUrl, parseGoogleFontsCatalog } = await importTypeScript("../core/fonts/google-fonts.ts");
  const fonts = parseGoogleFontsCatalog({
    families: {
      Roboto: { fp: "./ofl/roboto/Roboto[wdth,wght].ttf" },
      Inconsolata: { fp: "./ofl/inconsolata/static/Inconsolata-Regular.ttf" },
      Unsafe: { fp: "../../private.ttf" },
    },
  });
  assert.equal(fonts.length, 2);
  const roboto = fonts.find((font) => font.family === "Roboto");
  assert.ok(roboto);
  assert.deepEqual(roboto, {
    postscriptName: "google-fonts:Roboto",
    fullName: "Roboto",
    family: "Roboto",
    style: "Regular",
    source: "google",
    googleFontsPath: "ofl/roboto/Roboto[wdth,wght].ttf",
  });
  assert.equal(
    googleFontsCdnUrl(roboto.googleFontsPath),
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf",
  );
});

test("Google Fonts metadata selects the normal face nearest weight 400", async () => {
  const { parseGoogleFontsMetadata } = await importTypeScript("../core/fonts/google-fonts.ts");
  const metadata = `fonts {
    style: "italic"
    weight: 400
    filename: "Example-Italic[wght].ttf"
  }
  fonts {
    style: "normal"
    weight: 700
    filename: "Example-Bold.ttf"
  }
  fonts {
    style: "normal"
    weight: 400
    filename: "Example-Regular.ttf"
  }`;
  assert.equal(
    parseGoogleFontsMetadata(metadata, "ofl/example/Example-Italic[wght].ttf"),
    "ofl/example/Example-Regular.ttf",
  );
});

test("Google Fonts resolves stale nested catalog paths through family metadata", async () => {
  const { loadGoogleFontData } = await importTypeScript("../core/fonts/google-fonts.ts");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/ofl/inter/METADATA.pb")) return new Response(`name: "Inter"
fonts {
  style: "normal"
  weight: 400
  filename: "Inter[opsz,wght].ttf"
}`);
    if (String(url).endsWith("/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf")) return new Response(new Uint8Array([0, 1, 2]));
    return new Response("Not found", { status: 404 });
  };
  try {
    const blob = await loadGoogleFontData("ofl/inter/changed/Inter[opsz,wght].ttf", "Inter");
    assert.equal(blob.size, 3);
    assert.deepEqual(requests, [
      "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/METADATA.pb",
      "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("variable font coordinates are normalized, clamped, and keyed deterministically", async () => {
  const { clampFontVariations, fontVariationCss, fontVariationId, fontVariationWeight, normalizeFontVariations } = await importTypeScript("../core/fonts/font-variation.ts");
  assert.deepEqual(normalizeFontVariations({ wght: 700, opsz: 18, bad: 3, wdth: Number.NaN }), { opsz: 18, wght: 700 });
  const axes = [
    { tag: "wght", name: "Weight", minValue: 100, defaultValue: 400, maxValue: 900 },
    { tag: "opsz", name: "Optical size", minValue: 14, defaultValue: 14, maxValue: 32 },
  ];
  assert.deepEqual(clampFontVariations({ wght: 1200 }, axes), { wght: 900, opsz: 14 });
  assert.equal(fontVariationId("google-fonts:Inter", { wght: 700, opsz: 18 }), "google-fonts:Inter#variation:opsz=18,wght=700");
  assert.equal(fontVariationCss({ wght: 700, opsz: 18 }), '"opsz" 18, "wght" 700');
  assert.equal(fontVariationWeight({ wght: 725 }), 725);
  assert.equal(fontVariationWeight({ wght: 1200 }), 1000);
  assert.equal(fontVariationWeight({ opsz: 18 }), undefined);
});

test("text letter spacing uses a clamped percentage of font size", async () => {
  const { clampTextLetterSpacing, textKeyframePropertyOptions, textLetterSpacingDistance } = await importTypeScript("../core/interface/text-spacing.ts");
  assert.equal(clampTextLetterSpacing(-150), -100);
  assert.equal(clampTextLetterSpacing(450), 300);
  assert.equal(textLetterSpacingDistance(2, 25), 0.5);
  assert.equal(textLetterSpacingDistance(1.2, -50), -0.6);
  assert.ok(textKeyframePropertyOptions("2d").some(([property]) => property === "letterSpacing"));
  assert.ok(textKeyframePropertyOptions("3d").some(([property]) => property === "letterSpacing"));
  assert.ok(!textKeyframePropertyOptions("2d").some(([property]) => property === "textDepth"));
  assert.ok(textKeyframePropertyOptions("3d").some(([property]) => property === "textDepth"));
});

test("audio waveform peaks follow trim, duration, speed, and include the clip end", async () => {
  const { AUDIO_WAVEFORM_VERSION, accumulateAudioWaveformPeaks, audioWaveformPeakCount, clipWaveformPeaks } = await importTypeScript("../core/interface/audio-waveform.ts");
  assert.equal(AUDIO_WAVEFORM_VERSION, 2);
  assert.equal(audioWaveformPeakCount(1), 256);
  assert.equal(audioWaveformPeakCount(200), 8_192);

  const source = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(
    clipWaveformPeaks(source, 10, { offset: 2, duration: 2, speed: 100 }, 2),
    [2, 3],
  );
  assert.deepEqual(
    clipWaveformPeaks(source, 10, { offset: 2, duration: 2, speed: 200 }, 2),
    [3, 5],
  );
  assert.deepEqual(
    clipWaveformPeaks(source, 10, { offset: 8, duration: 2, speed: 100 }, 4),
    [8, 8, 9, 9],
  );

  const decoded = [0, 0, 0, 0];
  accumulateAudioWaveformPeaks(decoded, 1, new Float32Array([
    0.1, -0.8,
    0.2, 0.3,
    -0.4, 0.1,
    0.25, -0.9,
  ]), 4, 2, 4, 0);
  [0.8, 0.3, 0.4, 0.9].forEach((expected, index) => assert.ok(Math.abs(decoded[index] - expected) < 1e-6));
});

test("audio waveform zoom preserves the time beneath the pointer", async () => {
  const { audioWaveformScrollForAnchor, audioWaveformTimeAtPointer, clampAudioWaveformZoom } = await importTypeScript("../core/interface/audio-waveform-viewport.ts");
  assert.equal(clampAudioWaveformZoom(0.5), 1);
  assert.equal(clampAudioWaveformZoom(100), 64);

  const duration = 20;
  const viewportWidth = 500;
  const pointerX = 125;
  const initialTime = audioWaveformTimeAtPointer(375, pointerX, 2, duration, viewportWidth);
  assert.equal(initialTime, 10);
  const zoomedScroll = audioWaveformScrollForAnchor(initialTime, pointerX, 4, duration, viewportWidth);
  assert.equal(zoomedScroll, 875);
  assert.equal(audioWaveformTimeAtPointer(zoomedScroll, pointerX, 4, duration, viewportWidth), initialTime);
  assert.equal(audioWaveformScrollForAnchor(duration, pointerX, 4, duration, viewportWidth), 1_500);
});

test("clip action order is retained after applicability filtering", async () => {
  const { resolveClipPropertyActions } = await importTypeScript("../core/interface/clip-actions.ts");
  const clip = {
    kind: "video",
    propertyActions: [
      { id: "effects", kind: "effects" },
      { id: "grade", kind: "colorGrading" },
      { id: "duplicate", kind: "effects" },
      { id: "invalid", kind: "sceneGraph" },
    ],
  };
  assert.deepEqual(resolveClipPropertyActions(clip).map((action) => action.id), ["effects", "grade"]);
});

test("timeline transitions are identical at clip boundaries and overlap in the middle", async () => {
  const { clipTransitionGain } = await importTypeScript("../core/interface/sequencer-state.ts");
  const clip = { duration: 10, transitionIn: 2, transitionOut: 4 };
  assert.equal(clipTransitionGain(clip, 0), 0);
  assert.equal(clipTransitionGain(clip, 2), 1);
  assert.equal(clipTransitionGain(clip, 8), 0.5);
  assert.equal(clipTransitionGain(clip, 10), 0);
});

test("timeline draw hierarchy traverses visual rows and filters from top to bottom", async () => {
  const { orderedTimelineFilters, orderedVisualClips } = await importTypeScript("../core/interface/timeline-draw-order.ts");
  const clips = [
    { id: "bottom", kind: "video", y: 240, positionZ: 0 },
    { id: "top", kind: "video", y: 20, positionZ: 0 },
    { id: "middle", kind: "title", y: 120, positionZ: 0 },
    { id: "filter-bottom", kind: "filter", y: 180 },
    { id: "filter-top", kind: "filter", y: 40 },
    { id: "group", kind: "group", y: 0 },
  ];
  assert.deepEqual(orderedVisualClips(clips).map((clip) => clip.id), ["top", "middle", "bottom"]);
  assert.deepEqual(orderedTimelineFilters(clips).map((clip) => clip.id), ["filter-top", "filter-bottom"]);
});

test("an explicit stack order overrides the timeline row default", async () => {
  const { orderedVisualClips } = await importTypeScript("../core/interface/timeline-draw-order.ts");
  const clips = [
    { id: "bottom", kind: "video", y: 240, stackOrder: 0 },
    { id: "top", kind: "video", y: 20, stackOrder: 1 },
  ];
  assert.deepEqual(orderedVisualClips(clips).map((clip) => clip.id), ["bottom", "top"]);
});

test("camera cuts select the latest camera at or before the playhead", async () => {
  const { cameraForTime } = await importTypeScript("../core/interface/sequencer-state.ts");
  const a = { id: "a" };
  const b = { id: "b" };
  const scene = { camera: a, cameras: [a, b], cameraCuts: [{ id: "cut-b", time: 4, cameraId: "b" }, { id: "cut-a", time: 9, cameraId: "a" }] };
  assert.equal(cameraForTime(scene, 3).id, "a");
  assert.equal(cameraForTime(scene, 4).id, "b");
  assert.equal(cameraForTime(scene, 12).id, "a");
});

test("preview picking inherits the visible camera layer mask", async () => {
  const { matchPreviewLayerMask } = await importTypeScript("../core/engine/editor-layers.ts");
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  camera.lookAt(0, 0, 0);
  camera.layers.enableAll();
  camera.layers.disable(31);
  camera.updateMatrixWorld(true);

  const timelineObject = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  timelineObject.name = "timeline-object";
  const inspectorHelper = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  inspectorHelper.name = "inspector-helper";
  inspectorHelper.position.z = 2;
  inspectorHelper.layers.set(31);
  inspectorHelper.updateMatrixWorld(true);

  const picker = new THREE.Raycaster();
  picker.layers.enableAll();
  matchPreviewLayerMask(picker, camera);
  picker.setFromCamera(new THREE.Vector2(0, 0), camera);
  assert.deepEqual(
    picker.intersectObjects([inspectorHelper, timelineObject]).map((hit) => hit.object.name),
    ["timeline-object", "timeline-object"],
  );
});

test("preview resize preserves aspect ratio while Shift is held", async () => {
  const { resolvePreviewResize } = await importTypeScript("../core/interface/preview-resize.ts");
  const result = resolvePreviewResize({
    startWidth: 4,
    startHeight: 2,
    startScaleX: 100,
    startScaleY: 100,
    localX: 4,
    localY: 1.5,
    directionX: 1,
    directionY: 1,
    preserveAspect: true,
    fromCenter: false,
  });
  assert.equal(result.width / result.height, 2);
  assert.equal(result.scaleX, result.scaleY);
});

test("preview resize keeps its center while Ctrl is held", async () => {
  const { resolvePreviewResize } = await importTypeScript("../core/interface/preview-resize.ts");
  const result = resolvePreviewResize({
    startWidth: 4,
    startHeight: 2,
    startScaleX: 100,
    startScaleY: 100,
    localX: 3,
    localY: 0,
    directionX: 1,
    directionY: 0,
    preserveAspect: false,
    fromCenter: true,
  });
  assert.equal(result.width, 6);
  assert.equal(result.centerOffsetX, 0);
  assert.equal(result.centerOffsetY, 0);
});

test("timeline Shift-drag locks movement to its dominant axis", async () => {
  const { constrainTimelineDrag, resolveTimelineDragAxis } = await importTypeScript("../core/interface/timeline-drag.ts");
  const horizontal = resolveTimelineDragAxis(12, 5, null, true);
  assert.equal(horizontal, "horizontal");
  assert.deepEqual(constrainTimelineDrag(12, 5, horizontal), { deltaX: 12, deltaY: 0 });

  const vertical = resolveTimelineDragAxis(3, -9, null, true);
  assert.equal(vertical, "vertical");
  assert.deepEqual(constrainTimelineDrag(3, -9, vertical), { deltaX: 0, deltaY: -9 });
  assert.equal(resolveTimelineDragAxis(30, 1, vertical, true), "vertical");
  assert.equal(resolveTimelineDragAxis(30, 1, vertical, false), null);
});

test("timeline resize alignment offers the playhead for either clip edge", async () => {
  const { findTimelinePlayheadAlignment } = await importTypeScript("../core/interface/timeline-playhead-alignment.ts");
  assert.deepEqual(
    findTimelinePlayheadAlignment({ start: 4.5, duration: 2 }, 5, 10, ["start"]),
    { distance: 5, start: 5, time: 5, movingEdge: "start" },
  );
  assert.deepEqual(
    findTimelinePlayheadAlignment({ start: 2, duration: 2.5 }, 5, 10, ["end"]),
    { distance: 5, start: 2.5, time: 5, movingEdge: "end" },
  );
  assert.equal(findTimelinePlayheadAlignment({ start: 4, duration: 2 }, 5, 10, ["start"]), null);
});

test("the timeline thumbnail lane remains serial and can cancel pending requests", async () => {
  const { AsyncMessageLane } = await importTypeScript("../core/engine/async-message-lane.ts");
  const handled = [];
  const releases = [];
  const lane = new AsyncMessageLane(async (message) => {
    handled.push(`start:${message}`);
    await new Promise((resolve) => releases.push(resolve));
    handled.push(`end:${message}`);
  });

  lane.enqueue("a");
  lane.enqueue("b");
  lane.enqueue("c");
  assert.equal(lane.remove((message) => message === "b"), 1);
  await Promise.resolve();
  assert.deepEqual(handled, ["start:a"]);
  assert.equal(lane.hasActive((message) => message === "a"), true);
  assert.equal(lane.hasActive((message) => message === "c"), false);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ["start:a", "end:a", "start:c"]);
  assert.equal(lane.hasActive((message) => message === "a"), false);
  assert.equal(lane.hasActive((message) => message === "c"), true);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ["start:a", "end:a", "start:c", "end:c"]);
  assert.equal(lane.hasActive(() => true), false);
});

test("video export collects clip, material, background, and environment assets", async () => {
  const { collectExportAssetIds } = await importTypeScript("../core/interface/export-resources.ts");
  const sceneSettings = {
    background: { backgroundAssetId: "background", environmentAssetId: "environment" },
  };
  const clips = [
    { assetId: "video", masks: [{ sourceAssetId: "clip-mask" }], sceneObject: { material: { mapAssetId: "albedo", normalMapAssetId: "normal", masks: [{ sourceAssetId: "material-mask" }] } } },
    { assetId: "video", sceneObject: { material: { emissiveMapAssetId: "emissive" } } },
  ];
  const objects = [{ material: { roughnessMapAssetId: "roughness" } }];
  assert.deepEqual(collectExportAssetIds(clips, sceneSettings, objects), ["background", "environment", "video", "clip-mask", "albedo", "normal", "material-mask", "emissive", "roughness"]);
});

test("Ctrl+Meta+number resolves preview tabs in their visible order", async () => {
  const { resolvePreviewTabShortcut } = await importTypeScript("../core/interface/preview-tab-shortcut.ts");
  const shortcut = (key, overrides = {}) => resolvePreviewTabShortcut({
    key,
    ctrlKey: true,
    metaKey: true,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }, ["clip-a", "clip-b"]);

  assert.deepEqual(shortcut("1"), { kind: "view", view: "inspector" });
  assert.deepEqual(shortcut("2"), { kind: "view", view: "camera" });
  assert.deepEqual(shortcut("3"), { kind: "clip", clipId: "clip-a" });
  assert.deepEqual(shortcut("4"), { kind: "clip", clipId: "clip-b" });
  assert.equal(shortcut("5"), null);
  assert.equal(shortcut("Control"), null);
  assert.equal(shortcut("1", { metaKey: false }), null);
  assert.equal(shortcut("1", { ctrlKey: false }), null);
});

test("S3 addresses normalize prefixes and support path and virtual-host styles", async () => {
  const { normalizeS3Endpoint, normalizeS3Prefix, s3ObjectUrl } = await importTypeScript("../core/interface/s3-address.ts");
  const endpoint = normalizeS3Endpoint(" https://user:secret@storage.example.test/api?discard=1#fragment ");
  assert.equal(endpoint.href, "https://storage.example.test/api/");
  assert.equal(normalizeS3Prefix("/projects/demo"), "projects/demo/");
  assert.equal(normalizeS3Prefix(""), "");
  assert.equal(
    s3ObjectUrl(endpoint, "media bucket", "素材/demo #1.mp4", true).href,
    "https://storage.example.test/api/media%20bucket/%E7%B4%A0%E6%9D%90/demo%20%231.mp4",
  );
  assert.equal(
    s3ObjectUrl(new URL("https://storage.example.test/"), "media", "folder/image.png", false).href,
    "https://media.storage.example.test/folder/image.png",
  );
  assert.equal(
    s3ObjectUrl(new URL("https://storage.example.test/"), "media", "folder//image.png", true).href,
    "https://storage.example.test/media/folder//image.png",
  );
});

test("preview crop preserves the opposite edge and shrinks the rendered plane", async () => {
  const { clampCropInsets, croppedPlaneGeometry, resolveCropDrag } = await importTypeScript("../core/protocol/preview-crop.ts");
  assert.deepEqual(clampCropInsets(1000, 500, { left: -4, right: 1200, top: 50, bottom: 800 }), {
    left: 0,
    right: 999,
    top: 50,
    bottom: 449,
  });
  assert.deepEqual(croppedPlaneGeometry(1000, 500, 10, 5, { left: 100, right: 200, top: 50, bottom: 100 }), {
    left: 100,
    right: 200,
    top: 50,
    bottom: 100,
    width: 7,
    height: 3.5,
    offsetX: -0.5,
    offsetY: 0.25,
    repeatX: 0.7,
    repeatY: 0.7,
  });
  assert.deepEqual(resolveCropDrag({
    sourceWidth: 1000,
    sourceHeight: 500,
    start: { left: 100, right: 200, top: 50, bottom: 100 },
    handle: "nw",
    localDeltaX: 1,
    localDeltaY: -0.5,
    pixelsPerWorldX: 100,
    pixelsPerWorldY: 100,
  }), { left: 200, right: 200, top: 100, bottom: 100 });
  assert.deepEqual(resolveCropDrag({
    sourceWidth: 1000,
    sourceHeight: 500,
    start: { left: 100, right: 200, top: 50, bottom: 100 },
    handle: "se",
    localDeltaX: -20,
    localDeltaY: 20,
    pixelsPerWorldX: 100,
    pixelsPerWorldY: 100,
  }), { left: 100, right: 899, top: 50, bottom: 449 });
});

test("the Three.js geometry catalog exposes every core geometry with usable defaults", async () => {
  const { defaultThreeGeometry, THREE_GEOMETRY_CATALOG } = await importTypeScript("../core/protocol/three-geometry-catalog.ts");
  const expected = [
    "BoxGeometry", "BufferGeometry", "CapsuleGeometry", "CircleGeometry", "ConeGeometry", "CylinderGeometry",
    "DodecahedronGeometry", "EdgesGeometry", "ExtrudeGeometry", "IcosahedronGeometry", "InstancedBufferGeometry", "LatheGeometry",
    "OctahedronGeometry", "PlaneGeometry", "PolyhedronGeometry", "RingGeometry", "ShapeGeometry",
    "SphereGeometry", "TetrahedronGeometry", "TorusGeometry", "TorusKnotGeometry", "TubeGeometry", "WireframeGeometry",
  ];
  assert.deepEqual(THREE_GEOMETRY_CATALOG.map(({ className }) => className), expected);
  assert.deepEqual(
    THREE_GEOMETRY_CATALOG.map(({ className }) => className).toSorted(),
    Object.keys(THREE).filter((name) => name.endsWith("Geometry")).toSorted(),
  );
  assert.equal(new Set(THREE_GEOMETRY_CATALOG.map(({ kind }) => kind)).size, expected.length);
  for (const { kind, className } of THREE_GEOMETRY_CATALOG) {
    assert.equal(typeof THREE[className], "function", `${className} must be exported by three`);
    const spec = defaultThreeGeometry("geometry", kind);
    assert.equal(spec.id, "geometry");
    assert.equal(spec.kind, kind);
  }
  assert.ok(defaultThreeGeometry("lathe", "lathe").points2D.length >= 2);
  assert.ok(defaultThreeGeometry("tube", "tube").points3D.length >= 2);
  assert.ok(defaultThreeGeometry("polyhedron", "polyhedron").vertices.length >= 9);
  assert.ok(defaultThreeGeometry("buffer", "buffer").vertices.length >= 9);
  assert.ok(defaultThreeGeometry("instanced", "instancedBuffer").vertices.length >= 9);
});

test("preview rendering preserves the native device pixel ratio", async () => {
  const { nativePreviewPixelRatio } = await importTypeScript("../core/protocol/preview-resolution.ts");
  assert.equal(nativePreviewPixelRatio(1), 1);
  assert.equal(nativePreviewPixelRatio(1.5), 1.5);
  assert.equal(nativePreviewPixelRatio(2), 2);
  assert.equal(nativePreviewPixelRatio(3.5), 3.5);
  assert.equal(nativePreviewPixelRatio(Number.NaN), 1);
  assert.equal(nativePreviewPixelRatio(0), 1);
});

test("isolated object previews use a fixed camera-independent orthographic frame", async () => {
  const { OBJECT_PREVIEW_WORLD_HEIGHT, objectPreviewFrustum } = await importTypeScript("../core/protocol/object-preview-camera.ts");
  assert.equal(OBJECT_PREVIEW_WORLD_HEIGHT, 9);
  assert.deepEqual(objectPreviewFrustum(16 / 9), { left: -8, right: 8, top: 4.5, bottom: -4.5 });
  assert.deepEqual(objectPreviewFrustum(Number.NaN), { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5 });
});

test("the AviUtl-compatible effect set is wired through definitions, UI, and the shared shader stack", async () => {
  const kinds = [
    "monochrome", "invert", "colorKey", "luminanceKey", "colorRange", "colorShift", "gradient", "noise", "edge", "sharpen",
    "blur", "boundaryBlur", "radialBlur", "directionalBlur", "lensBlur", "emission", "glow", "outline", "shadow", "wipe", "displacement",
  ];
  const [protocol, controller, inspector, nodes] = await Promise.all([
    readFile(new URL("../core/protocol/engine-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../core/interface/editor-controller.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/inspector-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../core/engine/clip-effect-nodes.ts", import.meta.url), "utf8"),
  ]);
  for (const kind of kinds) {
    assert.match(protocol, new RegExp(`\\| "${kind}"`), `${kind} protocol kind`);
    assert.match(controller, new RegExp(`\\n    ${kind}: \\{`), `${kind} defaults`);
    assert.match(inspector, new RegExp(`value="${kind}"`), `${kind} add menu`);
    assert.match(inspector, new RegExp(`effect\\.kind === "${kind}"|effect\\.kind === "[^\"]+" \\|\\| effect\\.kind === "${kind}"`), `${kind} parameters`);
    assert.match(nodes, new RegExp(`effect\\.kind === "${kind}"|effect\\.kind === "[^\"]+" \\|\\| effect\\.kind === "${kind}"`), `${kind} shader implementation`);
  }
});

test("inspector property controls route Ctrl+Z and Ctrl+Y to editor history", async () => {
  const { shouldHandleEditorHistoryShortcut } = await importTypeScript("../core/interface/editor-history-shortcut.ts");
  assert.equal(shouldHandleEditorHistoryShortcut(null), true);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "input", inputType: "number", insideInspector: true }), true);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "input", inputType: "range", insideInspector: true }), true);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "input", inputType: "checkbox", insideInspector: true }), true);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "select", insideInspector: true }), true);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "input", inputType: "text", insideInspector: true }), false);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "textarea", insideInspector: true }), false);
  assert.equal(shouldHandleEditorHistoryShortcut({ tagName: "input", inputType: "number", insideInspector: false }), false);
});

test("visual opacity combines the property and effect stack and updates its live uniform", async () => {
  const { resolveVisualOpacity, updateVisualOpacityControl } = await importTypeScript("../core/engine/visual-opacity.ts");
  const opacityEffect = { kind: "opacity", enabled: true, params: { amount: 40 } };
  assert.equal(resolveVisualOpacity(50, [opacityEffect]), 0.2);
  assert.equal(resolveVisualOpacity(50, [{ ...opacityEffect, enabled: false }]), 0.5);
  assert.equal(resolveVisualOpacity(50, [{ ...opacityEffect, filterRegion: {} }]), 0.5);
  assert.equal(resolveVisualOpacity(250, []), 1);
  const opacityNode = { value: 1 };
  const material = { opacity: 1, userData: { gfxOpacityNode: opacityNode } };
  assert.equal(updateVisualOpacityControl(material, 0.25), 0.25);
  assert.equal(material.opacity, 0.25);
  assert.equal(opacityNode.value, 0.25);
});
