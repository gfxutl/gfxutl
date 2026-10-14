import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class RingObject extends BuiltInObject {
  static readonly objectKind = "ring" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.RingGeometry(...(spec.args ?? [])); }
}
