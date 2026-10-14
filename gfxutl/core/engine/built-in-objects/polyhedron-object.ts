import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class PolyhedronObject extends BuiltInObject {
  static readonly objectKind = "polyhedron" as const;
  static createGeometry(spec: GeometrySpec) {
    const [radius = 1, detail = 0] = spec.args ?? [];
    return new THREE.PolyhedronGeometry(spec.vertices ?? [], spec.indices ?? [], radius, detail);
  }
}
