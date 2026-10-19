import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";
import { populateBufferGeometry } from "./buffer-object";

export default class InstancedBufferObject extends BuiltInObject {
  static readonly objectKind = "instancedBuffer" as const;
  static createGeometry(spec: GeometrySpec) {
    const geometry = populateBufferGeometry(new THREE.InstancedBufferGeometry(), spec);
    geometry.instanceCount = 1;
    return geometry;
  }
}
