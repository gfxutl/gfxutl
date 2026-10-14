import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { BuiltInObject } from "./built-in-object";

export default class BufferObject extends BuiltInObject {
  static readonly objectKind = "buffer" as const;
  static createGeometry(spec: GeometrySpec) {
    if (!spec.vertices?.length) throw new Error("buffer geometry requires vertices");
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(spec.vertices, 3));
    if (spec.normals?.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(spec.normals, 3));
    if (spec.uvs?.length) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(spec.uvs, 2));
    if (spec.uv1s?.length) geometry.setAttribute("uv1", new THREE.Float32BufferAttribute(spec.uv1s, 2));
    if (spec.colors?.length) geometry.setAttribute("color", new THREE.Float32BufferAttribute(spec.colors, spec.colors.length / (spec.vertices.length / 3) >= 4 ? 4 : 3));
    if (spec.tangents?.length) geometry.setAttribute("tangent", new THREE.Float32BufferAttribute(spec.tangents, 4));
    for (const [name, attribute] of Object.entries(spec.customAttributes ?? {})) {
      if (attribute.itemSize > 0 && attribute.values.length) geometry.setAttribute(name, new THREE.Float32BufferAttribute(attribute.values, attribute.itemSize));
    }
    if (spec.indices?.length) geometry.setIndex(spec.indices);
    for (const group of spec.groups ?? []) geometry.addGroup(group.start, group.count, group.materialIndex);
    if (spec.drawRange) geometry.setDrawRange(spec.drawRange.start, spec.drawRange.count);
    if (!spec.normals?.length) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
