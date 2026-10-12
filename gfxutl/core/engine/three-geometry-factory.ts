import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../protocol/engine-protocol";
import { createGfxTextGeometry, registerGfxTextFont } from "./gfx-text-geometry";

export { GFX_TEXT_ATTRIBUTES, GfxTextGeometry, getGfxTextFontCacheInfo } from "./gfx-text-geometry";

type GeometryConstructor = new (...args: any[]) => THREE.BufferGeometry;

const primitiveConstructors: Partial<Record<GeometrySpec["kind"], GeometryConstructor>> = {
  box: THREE.BoxGeometry,
  capsule: THREE.CapsuleGeometry,
  circle: THREE.CircleGeometry,
  cone: THREE.ConeGeometry,
  cylinder: THREE.CylinderGeometry,
  dodecahedron: THREE.DodecahedronGeometry,
  icosahedron: THREE.IcosahedronGeometry,
  octahedron: THREE.OctahedronGeometry,
  plane: THREE.PlaneGeometry,
  ring: THREE.RingGeometry,
  sphere: THREE.SphereGeometry,
  tetrahedron: THREE.TetrahedronGeometry,
  torus: THREE.TorusGeometry,
  torusKnot: THREE.TorusKnotGeometry,
};

export async function registerLocalFont(fontId: string, buffer: ArrayBuffer) {
  await registerGfxTextFont(fontId, buffer);
}

function shapeFrom(spec: Pick<GeometrySpec, "points2D" | "holes">) {
  const points = spec.points2D ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hole of spec.holes ?? []) {
    shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}

/** Creates every geometry shipped in Three.js core from structured-clone-safe data. */
export function createGeometry(spec: GeometrySpec): THREE.BufferGeometry {
  const Primitive = primitiveConstructors[spec.kind];
  if (Primitive) return new Primitive(...(spec.args ?? []));

  switch (spec.kind) {
    case "text": {
      return createGfxTextGeometry(spec);
    }
    case "lathe":
      return new THREE.LatheGeometry((spec.points2D ?? []).map(([x, y]) => new THREE.Vector2(x, y)), spec.args?.[0], spec.args?.[1], spec.args?.[2]);
    case "shape":
      return new THREE.ShapeGeometry(shapeFrom(spec), spec.args?.[0]);
    case "extrude": {
      const [depth = 1, bevelEnabled = 1, bevelThickness = 0.2, bevelSize = 0.1, bevelSegments = 3, steps = 1, curveSegments = 12] = spec.args ?? [];
      return new THREE.ExtrudeGeometry(shapeFrom(spec), { depth, bevelEnabled: Boolean(bevelEnabled), bevelThickness, bevelSize, bevelSegments, steps, curveSegments });
    }
    case "tube": {
      const points = (spec.points3D ?? [[0, 0, 0], [1, 0, 0]]).map(([x, y, z]) => new THREE.Vector3(x, y, z));
      const [tubularSegments = 64, radius = 1, radialSegments = 8, closed = 0] = spec.args ?? [];
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, Boolean(closed)), tubularSegments, radius, radialSegments, Boolean(closed));
    }
    case "polyhedron": {
      const [radius = 1, detail = 0] = spec.args ?? [];
      return new THREE.PolyhedronGeometry(spec.vertices ?? [], spec.indices ?? [], radius, detail);
    }
    case "edges": {
      const source = createGeometry({ id: `${spec.id}:source`, kind: "box", ...spec.source });
      const geometry = new THREE.EdgesGeometry(source, spec.args?.[0]);
      source.dispose();
      return geometry;
    }
    case "wireframe": {
      const source = createGeometry({ id: `${spec.id}:source`, kind: "box", ...spec.source });
      const geometry = new THREE.WireframeGeometry(source);
      source.dispose();
      return geometry;
    }
    case "buffer": {
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
    default:
      throw new Error(`Unsupported geometry: ${String(spec.kind)}`);
  }
}
