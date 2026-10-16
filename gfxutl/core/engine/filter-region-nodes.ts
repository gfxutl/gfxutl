import * as THREE from "three/webgpu";
import { abs, cameraProjectionMatrix, float, max, modelViewMatrix, screenUV, smoothstep, vec2, vec4 } from "three/tsl";
import type { FilterRegion } from "../protocol/engine-protocol";

/** Produces a softly antialiased mask for a rotated filter rectangle in output space. */
export function filterRegionMask(region: FilterRegion, point: any = screenUV) {
  const radians = THREE.MathUtils.degToRad(region.rotation);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const delta = point.sub(vec2(region.centerX, region.centerY));
  // Rotation is defined in CSS/output pixels, so compensate normalized X by
  // the composition aspect before rotating it with normalized Y.
  const pixelX = delta.x.mul(region.aspect);
  const localX = pixelX.mul(cosine).add(delta.y.mul(sine));
  const localY = delta.y.mul(cosine).sub(pixelX.mul(sine));
  const halfWidth = Math.max(0.000001, region.width * region.aspect / 2);
  const halfHeight = Math.max(0.000001, region.height / 2);
  const edge = max(abs(localX).div(halfWidth), abs(localY).div(halfHeight));
  return float(1).sub(smoothstep(0.997, 1, edge)).mul(THREE.MathUtils.clamp(region.opacity, 0, 1));
}

/** Projects an undeformed local vertex so mesh deformation observes the same bounds. */
export function filterRegionVertexMask(region: FilterRegion, localPosition: any) {
  const projected = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(localPosition, 1));
  const ndc = projected.xy.div(projected.w);
  const point = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
  return filterRegionMask(region, point);
}
