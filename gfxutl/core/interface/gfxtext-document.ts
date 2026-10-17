import { normalizeFontVariations, type FontVariationSettings } from "../fonts/font-variation";

export const GFX_TEXT_DOCUMENT_VERSION = 1 as const;
export const OPEN_GFX_TEXT_EVENT = "gfxutl:open-gfx-text";

export type GfxTextMaterialType = "standard" | "physical" | "phong" | "basic";
export type GfxTextTextureWrap = "repeat" | "clamp" | "mirror";

export interface GfxTextMaterialSettings {
  type: GfxTextMaterialType;
  metalness: number;
  roughness: number;
  shininess: number;
  clearcoat: number;
  clearcoatRoughness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  wireframe: boolean;
  flatShading: boolean;
}

export interface GfxTextTextureSettings {
  name: string;
  dataUrl: string;
  repeatX: number;
  repeatY: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  wrap: GfxTextTextureWrap;
}

export interface GfxTextDocument {
  application: "GfxUtl";
  type: "3d-text";
  version: typeof GFX_TEXT_DOCUMENT_VERSION;
  name: string;
  text: string;
  fontId?: string;
  fontFamily: string;
  fontVariations?: FontVariationSettings;
  fontSize: number;
  textDepth: number;
  textColor: string;
  textOutlineColor: string;
  textOutlineWidth: number;
  material: GfxTextMaterialSettings;
  texture?: GfxTextTextureSettings;
}

export interface GfxTextEditorEntry {
  id: string;
  name: string;
  path: string;
  document: GfxTextDocument;
  handle?: FileSystemFileHandle;
}

export function createGfxTextDocument(): GfxTextDocument {
  return {
    application: "GfxUtl",
    type: "3d-text",
    version: GFX_TEXT_DOCUMENT_VERSION,
    name: "3D Text",
    text: "Text",
    fontFamily: "Helvetiker",
    fontSize: 1.2,
    textDepth: 0.12,
    textColor: "#202020",
    textOutlineColor: "#ffffff",
    textOutlineWidth: 0.02,
    material: createGfxTextMaterialSettings(),
  };
}

export function createGfxTextMaterialSettings(): GfxTextMaterialSettings {
  return {
    type: "standard",
    metalness: 0.08,
    roughness: 0.48,
    shininess: 30,
    clearcoat: 0,
    clearcoatRoughness: 0,
    emissive: "#000000",
    emissiveIntensity: 1,
    opacity: 1,
    wireframe: false,
    flatShading: false,
  };
}

export function parseGfxTextDocument(source: string): GfxTextDocument {
  const value = JSON.parse(source) as Partial<GfxTextDocument> | null;
  if (!value || value.application !== "GfxUtl" || value.type !== "3d-text" || value.version !== GFX_TEXT_DOCUMENT_VERSION) {
    throw new Error("対応していない3D Textファイルです");
  }
  return {
    application: "GfxUtl",
    type: "3d-text",
    version: GFX_TEXT_DOCUMENT_VERSION,
    name: text(value.name, "3D Text"),
    text: typeof value.text === "string" ? value.text : "Text",
    fontId: typeof value.fontId === "string" && value.fontId ? value.fontId : undefined,
    fontFamily: text(value.fontFamily, "Helvetiker"),
    fontVariations: Object.keys(normalizeFontVariations(value.fontVariations)).length ? normalizeFontVariations(value.fontVariations) : undefined,
    fontSize: number(value.fontSize, 0.01, 100, 1.2),
    textDepth: number(value.textDepth, 0, 100, 0.12),
    textColor: color(value.textColor, "#202020"),
    textOutlineColor: color(value.textOutlineColor, "#ffffff"),
    textOutlineWidth: number(value.textOutlineWidth, 0, 100, 0.02),
    material: parseMaterial(value.material),
    texture: parseTexture(value.texture),
  };
}

export function serializeGfxTextDocument(document: GfxTextDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function openGfxTextEditor(entry: GfxTextEditorEntry) {
  window.dispatchEvent(new CustomEvent<GfxTextEditorEntry>(OPEN_GFX_TEXT_EVENT, { detail: entry }));
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function color(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function parseMaterial(value: unknown): GfxTextMaterialSettings {
  const defaults = createGfxTextMaterialSettings();
  const material = isRecord(value) ? value : {};
  return {
    type: material.type === "physical" || material.type === "phong" || material.type === "basic" ? material.type : "standard",
    metalness: number(material.metalness, 0, 1, defaults.metalness),
    roughness: number(material.roughness, 0, 1, defaults.roughness),
    shininess: number(material.shininess, 0, 200, defaults.shininess),
    clearcoat: number(material.clearcoat, 0, 1, defaults.clearcoat),
    clearcoatRoughness: number(material.clearcoatRoughness, 0, 1, defaults.clearcoatRoughness),
    emissive: color(material.emissive, defaults.emissive),
    emissiveIntensity: number(material.emissiveIntensity, 0, 20, defaults.emissiveIntensity),
    opacity: number(material.opacity, 0, 1, defaults.opacity),
    wireframe: typeof material.wireframe === "boolean" ? material.wireframe : defaults.wireframe,
    flatShading: typeof material.flatShading === "boolean" ? material.flatShading : defaults.flatShading,
  };
}

function parseTexture(value: unknown): GfxTextTextureSettings | undefined {
  if (!isRecord(value) || typeof value.dataUrl !== "string" || !/^data:image\//i.test(value.dataUrl)) return undefined;
  return {
    name: text(value.name, "Texture"),
    dataUrl: value.dataUrl,
    repeatX: number(value.repeatX, -100, 100, 1),
    repeatY: number(value.repeatY, -100, 100, 1),
    offsetX: number(value.offsetX, -100, 100, 0),
    offsetY: number(value.offsetY, -100, 100, 0),
    rotation: number(value.rotation, -360, 360, 0),
    wrap: value.wrap === "clamp" || value.wrap === "mirror" ? value.wrap : "repeat",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
