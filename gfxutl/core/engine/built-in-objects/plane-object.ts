import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class PlaneObject extends BuiltInObject {
  static readonly objectKind = "plane" as const;
  static createGeometry(spec: GeometrySpec) {
    const [width = 1, height = 1, widthSegments = 32, heightSegments = 18] = spec.args ?? [];
    return new THREE.PlaneGeometry(width, height, widthSegments, heightSegments);
  }
}
