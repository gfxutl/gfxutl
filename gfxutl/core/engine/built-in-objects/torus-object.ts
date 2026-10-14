import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class TorusObject extends BuiltInObject {
  static readonly objectKind = "torus" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.TorusGeometry(...(spec.args ?? [])); }
}
