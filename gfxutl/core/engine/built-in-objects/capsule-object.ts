import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class CapsuleObject extends BuiltInObject {
  static readonly objectKind = "capsule" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.CapsuleGeometry(...(spec.args ?? [])); }
}
