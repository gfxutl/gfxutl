import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";
import { shapeFrom } from "./shape-path";

export default class ExtrudeObject extends BuiltInObject {
  static readonly objectKind = "extrude" as const;
  static createGeometry(spec: GeometrySpec) {
    const [depth = 1, bevelEnabled = 1, bevelThickness = 0.2, bevelSize = 0.1, bevelSegments = 3, steps = 1, curveSegments = 12] = spec.args ?? [];
    return new THREE.ExtrudeGeometry(shapeFrom(spec), { depth, bevelEnabled: Boolean(bevelEnabled), bevelThickness, bevelSize, bevelSegments, steps, curveSegments });
  }
}
