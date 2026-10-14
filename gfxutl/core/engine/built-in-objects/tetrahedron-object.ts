import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class TetrahedronObject extends BuiltInObject {
  static readonly objectKind = "tetrahedron" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.TetrahedronGeometry(...(spec.args ?? [])); }
}
