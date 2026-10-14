import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class ConeObject extends BuiltInObject {
  static readonly objectKind = "cone" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.ConeGeometry(...(spec.args ?? [])); }
}
