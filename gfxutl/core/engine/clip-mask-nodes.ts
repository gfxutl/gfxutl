import * as THREE from "three/webgpu";
import { abs, atan, cos, float, length, luminance, max, mix, smoothstep, vec2, vec4 } from "three/tsl";
import type { ClipMask } from "../protocol/engine-protocol";

type Node = any;
type MaskSampler = (assetId: string, coordinates: Node) => Node | undefined;

function rotatePoint(point: Node, degrees: number) {
  const angle = THREE.MathUtils.degToRad(degrees);
  return vec2(point.x.mul(Math.cos(angle)).sub(point.y.mul(Math.sin(angle))), point.x.mul(Math.sin(angle)).add(point.y.mul(Math.cos(angle))));
}

function maskDistance(mask: ClipMask, coordinates: Node) {
  const halfWidth = Math.max(0.0001, mask.width / 200);
  const halfHeight = Math.max(0.0001, mask.height / 200);
  const point = rotatePoint(coordinates.sub(vec2(mask.x / 100, 1 - mask.y / 100)), -(mask.rotation ?? 0));
  const normalized = point.div(vec2(halfWidth, halfHeight));
  if (mask.shape === "ellipse") return length(normalized);
  if (mask.shape === "diamond") return abs(normalized.x).add(abs(normalized.y));
  if (mask.shape === "star") {
    const angle = atan(normalized.y, normalized.x);
    const radius = length(normalized);
    const boundary = float(0.72).add(cos(angle.mul(5)).mul(0.28));
    return radius.div(boundary);
  }
  const rectangle = max(abs(normalized.x), abs(normalized.y));
  if (mask.shape !== "roundedRectangle") return rectangle;
  const roundness = THREE.MathUtils.clamp((mask.roundness ?? 25) / 100, 0, 1);
  return mix(rectangle, length(normalized), roundness * 0.45);
}

export function applyClipMaskNodes(input: Node, masks: readonly ClipMask[], coordinates: Node, sampleMask?: MaskSampler) {
  let combinedMask: Node | null = null;
  for (const mask of masks) {
    if (!mask.enabled) continue;
    const edge = maskDistance(mask, coordinates);
    const feather = Math.max(0.0001, mask.feather / 100);
    let value: Node = float(1).sub(smoothstep(Math.max(0, 1 - feather), 1, edge)).mul(THREE.MathUtils.clamp(mask.opacity / 100, 0, 1));
    if (mask.sourceAssetId && sampleMask) {
      const halfWidth = Math.max(0.0001, mask.width / 200);
      const halfHeight = Math.max(0.0001, mask.height / 200);
      const point = rotatePoint(coordinates.sub(vec2(mask.x / 100, 1 - mask.y / 100)), -(mask.rotation ?? 0));
      const maskTexture = sampleMask(mask.sourceAssetId, point.div(vec2(halfWidth, halfHeight)).mul(0.5).add(0.5));
      if (maskTexture) value = value.mul(mask.sourceChannel === "luminance" ? luminance(maskTexture.rgb) : maskTexture.a);
    }
    if (mask.inverted) value = float(1).sub(value);
    if (combinedMask === null) combinedMask = mask.mode === "subtract" ? float(1).sub(value) : value;
    else if (mask.mode === "add") combinedMask = max(combinedMask, value);
    else if (mask.mode === "subtract") combinedMask = combinedMask.mul(float(1).sub(value));
    else combinedMask = combinedMask.mul(value);
  }
  return combinedMask === null ? input : vec4(input.rgb, input.a.mul(combinedMask));
}
