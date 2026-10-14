import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class SphereObject extends BuiltInObject {
  static readonly objectKind = "sphere" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.SphereGeometry(...(spec.args ?? [])); }
}
