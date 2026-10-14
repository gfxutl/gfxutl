import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class DodecahedronObject extends BuiltInObject {
  static readonly objectKind = "dodecahedron" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.DodecahedronGeometry(...(spec.args ?? [])); }
}
