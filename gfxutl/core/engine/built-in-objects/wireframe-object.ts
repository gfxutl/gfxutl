import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject, type GeometryResolver } from "./built-in-object";

export default class WireframeObject extends BuiltInObject {
  static readonly objectKind = "wireframe" as const;
  static async createGeometry(spec: GeometrySpec, resolveGeometry: GeometryResolver) {
    const source = await resolveGeometry({ id: `${spec.id}:source`, kind: "box", ...spec.source });
    const geometry = new THREE.WireframeGeometry(source);
    source.dispose();
    return geometry;
  }
}
