import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class TorusKnotObject extends BuiltInObject {
  static readonly objectKind = "torusKnot" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.TorusKnotGeometry(...(spec.args ?? [])); }
}
