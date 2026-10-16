import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

async function importTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const outputText = stripTypeScriptTypes(source, { mode: "transform" });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("sequenceEnd preserves an explicit duration and expands for content", async () => {
  const { sequenceEnd } = await importTypeScript("../core/interface/sequence-duration.ts");
  assert.equal(sequenceEnd([], 30, 12), 12);
  assert.equal(sequenceEnd([{ start: 2, duration: 3 }], 30, 12), 12);
  assert.equal(sequenceEnd([{ start: 10, duration: 5 }], 30, 12), 15);
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
