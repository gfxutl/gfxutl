import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class PlaneObject extends BuiltInObject {
  static readonly objectKind = "plane" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.PlaneGeometry(...(spec.args ?? [])); }
}
