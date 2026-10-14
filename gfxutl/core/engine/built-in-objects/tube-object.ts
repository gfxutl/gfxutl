import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class TubeObject extends BuiltInObject {
  static readonly objectKind = "tube" as const;
  static createGeometry(spec: GeometrySpec) {
    const points = (spec.points3D ?? [[0, 0, 0], [1, 0, 0]]).map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const [tubularSegments = 64, radius = 1, radialSegments = 8, closed = 0] = spec.args ?? [];
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, Boolean(closed)), tubularSegments, radius, radialSegments, Boolean(closed));
  }
}
