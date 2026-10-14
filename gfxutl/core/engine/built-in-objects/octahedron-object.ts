import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class OctahedronObject extends BuiltInObject {
  static readonly objectKind = "octahedron" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.OctahedronGeometry(...(spec.args ?? [])); }
}
