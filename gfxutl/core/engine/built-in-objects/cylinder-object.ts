import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class CylinderObject extends BuiltInObject {
  static readonly objectKind = "cylinder" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.CylinderGeometry(...(spec.args ?? [])); }
}
