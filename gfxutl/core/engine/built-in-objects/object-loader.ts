import type { GeometryKind } from "../../protocol/engine-protocol";
import type { BuiltInObjectClass, BuiltInObjectModule } from "./built-in-object";

type ObjectImporter = () => Promise<BuiltInObjectModule>;

// Keep every import expression explicit: Vite/Rollup emits one independently
// minified production chunk per built-in object instead of folding the catalog
// into the worker entry bundle.
const objectImporters: Record<GeometryKind, ObjectImporter> = {
  box: async () => await import("./box-object"),
  capsule: async () => await import("./capsule-object"),
  circle: async () => await import("./circle-object"),
  cone: async () => await import("./cone-object"),
  cylinder: async () => await import("./cylinder-object"),
  dodecahedron: async () => await import("./dodecahedron-object"),
  icosahedron: async () => await import("./icosahedron-object"),
  instancedBuffer: async () => await import("./instanced-buffer-object"),
  octahedron: async () => await import("./octahedron-object"),
  plane: async () => await import("./plane-object"),
  ring: async () => await import("./ring-object"),
  sphere: async () => await import("./sphere-object"),
  tetrahedron: async () => await import("./tetrahedron-object"),
  torus: async () => await import("./torus-object"),
  torusKnot: async () => await import("./torus-knot-object"),
  lathe: async () => await import("./lathe-object"),
  shape: async () => await import("./shape-object"),
  extrude: async () => await import("./extrude-object"),
  tube: async () => await import("./tube-object"),
  polyhedron: async () => await import("./polyhedron-object"),
  edges: async () => await import("./edges-object"),
  wireframe: async () => await import("./wireframe-object"),
  buffer: async () => await import("./buffer-object"),
  text: async () => await import("./text-object"),
  text2d: async () => await import("./text2d-object"),
};

const objectClassPromises = new Map<GeometryKind, Promise<BuiltInObjectClass>>();

/** Loads an object ESM exactly once; subsequent creations reuse the import promise. */
export async function loadBuiltInObjectClass(kind: GeometryKind): Promise<BuiltInObjectClass> {
  let pending = objectClassPromises.get(kind);
  if (!pending) {
    pending = objectImporters[kind]().then((module) => {
      if (module.default.objectKind !== kind) throw new Error(`Built-in object module mismatch: ${kind}`);
      return module.default;
    });
    objectClassPromises.set(kind, pending);
  }
  return await pending;
}
