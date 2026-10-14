import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class LatheObject extends BuiltInObject {
  static readonly objectKind = "lathe" as const;
  static createGeometry(spec: GeometrySpec) {
    return new THREE.LatheGeometry((spec.points2D ?? []).map(([x, y]) => new THREE.Vector2(x, y)), spec.args?.[0], spec.args?.[1], spec.args?.[2]);
  }
}
