import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject, type GeometryResolver } from "./built-in-object";

export default class EdgesObject extends BuiltInObject {
  static readonly objectKind = "edges" as const;
  static async createGeometry(spec: GeometrySpec, resolveGeometry: GeometryResolver) {
    const source = await resolveGeometry({ id: `${spec.id}:source`, kind: "box", ...spec.source });
    const geometry = new THREE.EdgesGeometry(source, spec.args?.[0]);
    source.dispose();
    return geometry;
  }
}
