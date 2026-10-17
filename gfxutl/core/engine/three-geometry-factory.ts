import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../protocol/engine-protocol";
import type { FontVariationSettings } from "../fonts/font-variation";
import { fontVariationCss, fontVariationWeight } from "../fonts/font-variation";
import { registerGfxTextFont, registerGfxTextFontVariation } from "./gfx-text-geometry";
import { loadBuiltInObjectClass } from "./built-in-objects/object-loader";

export { GFX_TEXT_ATTRIBUTES, GfxTextGeometry, getGfxTextFontCacheInfo } from "./gfx-text-geometry";

const localFontBuffers = new Map<string, ArrayBuffer>();
const localFontFaces = new Map<string, FontFace>();

function installFontFace(fontId: string, face: FontFace) {
  const fonts = (globalThis as typeof globalThis & { fonts?: FontFaceSet }).fonts;
  const previous = localFontFaces.get(fontId);
  if (previous) fonts?.delete(previous);
  fonts?.add(face);
  localFontFaces.set(fontId, face);
}

export async function registerLocalFont(fontId: string, buffer: ArrayBuffer) {
  localFontBuffers.set(fontId, buffer);
  await registerGfxTextFont(fontId, buffer);
  if (typeof FontFace !== "undefined") {
    const family = `GfxUtl Canvas ${fontId}`;
    const face = await new FontFace(family, buffer).load();
    installFontFace(fontId, face);
  }
}

export async function registerLocalFontVariation(fontId: string, sourceFontId: string, variations: FontVariationSettings) {
  const buffer = localFontBuffers.get(sourceFontId);
  if (!buffer) throw new Error(`Source font is not registered: ${sourceFontId}`);
  registerGfxTextFontVariation(fontId, sourceFontId, variations);
  if (typeof FontFace !== "undefined") {
    const family = `GfxUtl Canvas ${fontId}`;
    const variationSettings = fontVariationCss(variations);
    const weight = fontVariationWeight(variations);
    const face = await new FontFace(family, buffer, {
      ...(variationSettings ? { variationSettings } : {}),
      ...(weight === undefined ? {} : { weight: String(weight) }),
    }).load();
    installFontFace(fontId, face);
  }
}

/** Dynamically imports the matching object ESM and creates its geometry. */
export async function createGeometry(spec: GeometrySpec): Promise<THREE.BufferGeometry> {
  const ObjectClass = await loadBuiltInObjectClass(spec.kind);
  return await ObjectClass.createGeometry(spec, createGeometry);
}
