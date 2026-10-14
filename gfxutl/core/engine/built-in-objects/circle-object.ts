import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class CircleObject extends BuiltInObject {
  static readonly objectKind = "circle" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.CircleGeometry(...(spec.args ?? [])); }
}
