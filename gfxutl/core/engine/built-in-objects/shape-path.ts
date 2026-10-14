import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";

export function shapeFrom(spec: Pick<GeometrySpec, "points2D" | "holes">) {
  const points = spec.points2D ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hole of spec.holes ?? []) {
    shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}
