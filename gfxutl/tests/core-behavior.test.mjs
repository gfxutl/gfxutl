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

test("shader graph emits the renderer post-process ABI", async () => {
  const { compileShaderGraphToGlsl } = await importTypeScript("../core/shader-graph/shader-graph-document.ts");
  const glsl = compileShaderGraphToGlsl({
    nodes: [
      { id: "input", kind: "inputColor", position: { x: 0, y: 0 }, data: { label: "Input" } },
      { id: "tint", kind: "color", position: { x: 0, y: 0 }, data: { label: "Tint", color: "#ff8000" } },
      { id: "multiply", kind: "multiply", position: { x: 0, y: 0 }, data: { label: "Multiply" } },
      { id: "output", kind: "output", position: { x: 0, y: 0 }, data: { label: "Output" } },
    ],
    edges: [
      { id: "a", source: "input", target: "multiply", targetHandle: "a" },
      { id: "b", source: "tint", target: "multiply", targetHandle: "b" },
      { id: "out", source: "multiply", target: "output", targetHandle: "color" },
    ],
  });
  assert.match(glsl, /^vec4 gfxPostProcess\(vec4 color, vec2 uv, float time\)/);
  assert.match(glsl, /color/);
  assert.match(glsl, /vec4\(1\.0000, 0\.5020, 0\.0000, 1\.0\)/);
});

test("timeline transitions are identical at clip boundaries and overlap in the middle", async () => {
  const { clipTransitionGain } = await importTypeScript("../core/interface/sequencer-state.ts");
  const clip = { duration: 10, transitionIn: 2, transitionOut: 4 };
  assert.equal(clipTransitionGain(clip, 0), 0);
  assert.equal(clipTransitionGain(clip, 2), 1);
  assert.equal(clipTransitionGain(clip, 8), 0.5);
  assert.equal(clipTransitionGain(clip, 10), 0);
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
