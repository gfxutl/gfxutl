import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../protocol/engine-protocol";
import { registerGfxTextFont } from "./gfx-text-geometry";
import { loadBuiltInObjectClass } from "./built-in-objects/object-loader";

export { GFX_TEXT_ATTRIBUTES, GfxTextGeometry, getGfxTextFontCacheInfo } from "./gfx-text-geometry";

export async function registerLocalFont(fontId: string, buffer: ArrayBuffer) {
  await registerGfxTextFont(fontId, buffer);
  if (typeof FontFace !== "undefined") {
    const family = `GfxUtl Canvas ${fontId}`;
    const face = await new FontFace(family, buffer).load();
    (globalThis as typeof globalThis & { fonts?: FontFaceSet }).fonts?.add(face);
  }
}

/** Dynamically imports the matching object ESM and creates its geometry. */
export async function createGeometry(spec: GeometrySpec): Promise<THREE.BufferGeometry> {
  const ObjectClass = await loadBuiltInObjectClass(spec.kind);
  return await ObjectClass.createGeometry(spec, createGeometry);
}
