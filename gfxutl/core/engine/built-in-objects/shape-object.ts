import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";
import { shapeFrom } from "./shape-path";

export default class ShapeObject extends BuiltInObject {
  static readonly objectKind = "shape" as const;
  static createGeometry(spec: GeometrySpec) { return new THREE.ShapeGeometry(shapeFrom(spec), spec.args?.[0]); }
}
