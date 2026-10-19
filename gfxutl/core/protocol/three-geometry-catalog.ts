import type { GeometryKind, GeometrySpec } from "./engine-protocol";

/** Geometry classes exported by the core `three` package (addons are excluded). */
export const THREE_GEOMETRY_CATALOG = [
  { kind: "box", className: "BoxGeometry" },
  { kind: "buffer", className: "BufferGeometry" },
  { kind: "capsule", className: "CapsuleGeometry" },
  { kind: "circle", className: "CircleGeometry" },
  { kind: "cone", className: "ConeGeometry" },
  { kind: "cylinder", className: "CylinderGeometry" },
  { kind: "dodecahedron", className: "DodecahedronGeometry" },
  { kind: "edges", className: "EdgesGeometry" },
  { kind: "extrude", className: "ExtrudeGeometry" },
  { kind: "icosahedron", className: "IcosahedronGeometry" },
  { kind: "instancedBuffer", className: "InstancedBufferGeometry" },
  { kind: "lathe", className: "LatheGeometry" },
  { kind: "octahedron", className: "OctahedronGeometry" },
  { kind: "plane", className: "PlaneGeometry" },
  { kind: "polyhedron", className: "PolyhedronGeometry" },
  { kind: "ring", className: "RingGeometry" },
  { kind: "shape", className: "ShapeGeometry" },
  { kind: "sphere", className: "SphereGeometry" },
  { kind: "tetrahedron", className: "TetrahedronGeometry" },
  { kind: "torus", className: "TorusGeometry" },
  { kind: "torusKnot", className: "TorusKnotGeometry" },
  { kind: "tube", className: "TubeGeometry" },
  { kind: "wireframe", className: "WireframeGeometry" },
] as const satisfies ReadonlyArray<{ kind: GeometryKind; className: string }>;

export type ThreeGeometryKind = typeof THREE_GEOMETRY_CATALOG[number]["kind"];

const THREE_GEOMETRY_KINDS = new Set<GeometryKind>(THREE_GEOMETRY_CATALOG.map(({ kind }) => kind));

export function isThreeGeometryKind(kind: GeometryKind): kind is ThreeGeometryKind {
  return THREE_GEOMETRY_KINDS.has(kind);
}

export function threeGeometryClassName(kind: ThreeGeometryKind) {
  return THREE_GEOMETRY_CATALOG.find((entry) => entry.kind === kind)!.className;
}

/** Produces a visible, editable starter shape for every core Three.js geometry. */
export function defaultThreeGeometry(id: string, kind: ThreeGeometryKind): GeometrySpec {
  const base = { id, kind };
  switch (kind) {
    case "box": return { ...base, args: [2, 2, 0.5, 1, 1, 1] };
    case "buffer": return { ...base, vertices: [-1.2, -1, 0, 1.2, -1, 0, 0, 1.2, 0], indices: [0, 1, 2] };
    case "capsule": return { ...base, args: [0.7, 1.4, 8, 16] };
    case "circle": return { ...base, args: [1.25, 32, 0, Math.PI * 2] };
    case "cone": return { ...base, args: [1, 2, 32, 1, 0, 0, Math.PI * 2] };
    case "cylinder": return { ...base, args: [1, 1, 2, 32, 1, 0, 0, Math.PI * 2] };
    case "dodecahedron": return { ...base, args: [1.25, 0] };
    case "edges": return { ...base, args: [1], source: { kind: "box", args: [2, 2, 0.5] } };
    case "extrude": return {
      ...base,
      args: [0.6, 1, 0.12, 0.08, 3, 1, 12],
      points2D: [[-1.25, -0.9], [1.25, -0.9], [1.25, 0.9], [-1.25, 0.9]],
    };
    case "icosahedron": return { ...base, args: [1.25, 0] };
    case "instancedBuffer": return { ...base, vertices: [-1.2, -1, 0, 1.2, -1, 0, 0, 1.2, 0], indices: [0, 1, 2] };
    case "lathe": return {
      ...base,
      args: [32, 0, Math.PI * 2],
      points2D: [[0.25, -1.3], [0.85, -1], [0.6, -0.2], [0.9, 0.65], [0.3, 1.3]],
    };
    case "octahedron": return { ...base, args: [1.25, 0] };
    case "plane": return { ...base, args: [2.5, 2.5, 1, 1] };
    case "polyhedron": return {
      ...base,
      args: [1.25, 0],
      vertices: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
      indices: [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1],
    };
    case "ring": return { ...base, args: [0.6, 1.25, 32, 1, 0, Math.PI * 2] };
    case "shape": return { ...base, args: [12], points2D: [[-1.5, -1], [1.5, -1], [1.5, 1], [-1.5, 1]] };
    case "sphere": return { ...base, args: [1.25, 32, 20] };
    case "tetrahedron": return { ...base, args: [1.25, 0] };
    case "torus": return { ...base, args: [1, 0.32, 16, 48] };
    case "torusKnot": return { ...base, args: [1, 0.28, 96, 16, 2, 3] };
    case "tube": return {
      ...base,
      args: [64, 0.2, 12, 0],
      points3D: [[-1.5, -0.8, 0], [-0.5, 0.8, 0.4], [0.5, -0.4, -0.4], [1.5, 0.8, 0]],
    };
    case "wireframe": return { ...base, source: { kind: "box", args: [2, 2, 0.5] } };
  }
}
