import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class BoxObject extends BuiltInObject {
  static readonly objectKind = "box" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.BoxGeometry(...(spec.args ?? [])); }
}
