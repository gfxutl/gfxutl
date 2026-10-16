import * as THREE from "three/webgpu";
import { abs, cameraProjectionMatrix, float, max, modelViewMatrix, positionLocal, screenUV, step, vec2, vec4 } from "three/tsl";
import type { FilterRegion } from "../protocol/engine-protocol";

export function classifyFilterRegion(region: FilterRegion): "outside" | "full" | "partial" {
  if (region.opacity <= 0 || region.width <= 0 || region.height <= 0) return "outside";
  const radians = THREE.MathUtils.degToRad(region.rotation);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = region.centerX * region.aspect;
  const centerY = region.centerY;
  const halfWidth = region.width * region.aspect / 2;
  const halfHeight = region.height / 2;
  const extentX = Math.abs(cosine) * halfWidth + Math.abs(sine) * halfHeight;
  const extentY = Math.abs(sine) * halfWidth + Math.abs(cosine) * halfHeight;
  if (centerX + extentX <= 0 || centerX - extentX >= region.aspect || centerY + extentY <= 0 || centerY - extentY >= 1) return "outside";
  const contains = (x: number, y: number) => {
    const deltaX = x - centerX;
    const deltaY = y - centerY;
    const localX = deltaX * cosine + deltaY * sine;
    const localY = deltaY * cosine - deltaX * sine;
    return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
  };
  return contains(0, 0) && contains(region.aspect, 0) && contains(region.aspect, 1) && contains(0, 1) ? "full" : "partial";
}

/** Produces a mask for a rotated filter rectangle in output space. */
export function filterRegionMask(region: FilterRegion, point: any = screenUV) {
  const radians = THREE.MathUtils.degToRad(region.rotation);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const halfWidth = Math.max(0.000001, region.width * region.aspect / 2);
  const halfHeight = Math.max(0.000001, region.height / 2);
  // Fold translation, aspect correction, inverse rotation and normalization
  // into two affine rows on the CPU. The fragment shader only evaluates two
  // multiply-add pairs instead of rebuilding the transform for every effect.
  const rowX = [region.aspect * cosine / halfWidth, sine / halfWidth] as const;
  const rowY = [-region.aspect * sine / halfHeight, cosine / halfHeight] as const;
  const offsetX = -region.centerX * rowX[0] - region.centerY * rowX[1];
  const offsetY = -region.centerX * rowY[0] - region.centerY * rowY[1];
  const localX = point.x.mul(rowX[0]).add(point.y.mul(rowX[1])).add(offsetX);
  const localY = point.x.mul(rowY[0]).add(point.y.mul(rowY[1])).add(offsetY);
  const edge = max(abs(localX), abs(localY));
  return float(1).sub(step(1, edge)).mul(THREE.MathUtils.clamp(region.opacity, 0, 1));
}

/** Projects an undeformed local vertex so mesh deformation observes the same bounds. */
export function filterRegionVertexMask(region: FilterRegion, localPosition: any) {
  const projected = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(localPosition, 1));
  const ndc = projected.xy.div(projected.w);
  const point = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));
  return filterRegionMask(region, point);
}

/**
 * Shares TSL variables per material. A filter can contribute several effects,
 * but its screen-space rectangle should be transformed and tested only once.
 */
export function createFilterRegionNodeCache() {
  const fragmentMasks = new Map<string, any>();
  const vertexMasks = new Map<string, any>();
  const keyOf = (region: FilterRegion) => `${region.centerX}:${region.centerY}:${region.width}:${region.height}:${region.rotation}:${region.opacity}:${region.aspect}`;
  return {
    fragment(region: FilterRegion) {
      const key = keyOf(region);
      let mask = fragmentMasks.get(key);
      if (!mask) {
        mask = filterRegionMask(region).toVar();
        fragmentMasks.set(key, mask);
      }
      return mask;
    },
    vertex(region: FilterRegion) {
      const key = keyOf(region);
      let mask = vertexMasks.get(key);
      if (!mask) {
        mask = filterRegionVertexMask(region, positionLocal).toVar();
        vertexMasks.set(key, mask);
      }
      return mask;
    },
  };
}
