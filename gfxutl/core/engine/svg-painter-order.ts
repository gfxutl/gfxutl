import type { SvgMeshSpec } from "../protocol/engine-protocol";

export interface SvgDrawGroup {
  start: number;
  count: number;
  materialIndex: number;
}

/** Combines SVG parts into one geometry while retaining their painter order. */
export function combineSvgMeshParts(parts: readonly SvgMeshSpec[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  const groups: SvgDrawGroup[] = [];

  for (let materialIndex = 0; materialIndex < parts.length; materialIndex += 1) {
    const part = parts[materialIndex];
    const vertexOffset = positions.length / 3;
    const groupStart = indices.length;
    positions.push(...part.positions);
    if (part.indices?.length) {
      for (const index of part.indices) indices.push(vertexOffset + index);
    } else {
      for (let index = 0; index < part.positions.length / 3; index += 1) indices.push(vertexOffset + index);
    }
    groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex });
  }

  return { positions, indices, groups };
}
