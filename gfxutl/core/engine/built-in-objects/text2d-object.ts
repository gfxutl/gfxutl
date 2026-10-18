import * as THREE from "three/webgpu";
import type { GeometrySpec } from "../../protocol/engine-protocol";
import { fontVariationWeight, type FontVariationSettings } from "../../fonts/font-variation";
import { textLetterSpacingDistance } from "../../interface/text-spacing";
import { BuiltInObject } from "./built-in-object";

const FONT_PIXELS = 128;
const LINE_HEIGHT = 1.2;
const MAX_CANVAS_SIDE = 4_096;

type CanvasSurface = HTMLCanvasElement | OffscreenCanvas;
type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createCanvas(width: number, height: number): CanvasSurface {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function contextFor(canvas: CanvasSurface) {
  const context = canvas.getContext("2d") as CanvasContext | null;
  if (!context) throw new Error("Canvas 2D is unavailable for 2D Text");
  return context;
}

function colorCss(color: number) {
  return `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, "0")}`;
}

function canvasFont(fontPixels: number, fontId?: string, fontFamily?: string, variations?: FontVariationSettings) {
  const family = (fontId ? `GfxUtl Canvas ${fontId}` : fontFamily || "sans-serif").replace(/["\\]/g, "");
  const weight = fontVariationWeight(variations);
  return `${weight ?? "normal"} ${fontPixels}px "${family}", sans-serif`;
}

function measuredLineWidth(context: CanvasContext, line: string, letterSpacingPixels: number) {
  const text = line || " ";
  return Math.max(1, context.measureText(text).width + Math.max(0, [...text].length - 1) * letterSpacingPixels);
}

function drawLine(context: CanvasContext, line: string, x: number, y: number, letterSpacingPixels: number, outlinePixels: number) {
  const text = line || " ";
  if (Math.abs(letterSpacingPixels) < 0.001) {
    if (outlinePixels > 0) context.strokeText(text, x, y);
    context.fillText(text, x, y);
    return;
  }
  const characters = [...text];
  const width = measuredLineWidth(context, text, letterSpacingPixels);
  context.save();
  context.textAlign = "left";
  let prefix = "";
  characters.forEach((character, index) => {
    const characterX = x - width / 2 + context.measureText(prefix).width + index * letterSpacingPixels;
    if (outlinePixels > 0) context.strokeText(character, characterX, y);
    context.fillText(character, characterX, y);
    prefix += character;
  });
  context.restore();
}

/**
 * Rasterizes text with Canvas 2D and maps that transparent bitmap onto a plane.
 * The texture lives with the cached geometry so identical 2D titles share it.
 */
function createCanvasTextGeometry(spec: GeometrySpec) {
  const text = spec.text || "Text";
  const lines = text.split("\n");
  const size = Math.max(0.001, spec.size ?? 1.2);
  const fontPixels = Math.max(16, Math.ceil(spec.rasterPixelsPerUnit === undefined ? FONT_PIXELS : size * spec.rasterPixelsPerUnit));
  const idealLetterSpacingPixels = textLetterSpacingDistance(fontPixels, spec.letterSpacing);
  const idealOutlinePixels = Math.max(0, (spec.outlineWidth ?? 0) / size * fontPixels);
  const idealPadding = Math.max(2, Math.ceil(idealOutlinePixels + fontPixels * 0.08));
  const probe = createCanvas(1, 1);
  const probeContext = contextFor(probe);
  probeContext.font = canvasFont(fontPixels, spec.fontId, spec.fontFamily, spec.fontVariations);
  const contentWidth = Math.max(1, ...lines.map((line) => measuredLineWidth(probeContext, line, idealLetterSpacingPixels)));
  const idealLinePixels = fontPixels * LINE_HEIGHT;
  const idealWidth = contentWidth + idealPadding * 2;
  const idealHeight = lines.length * idealLinePixels + idealPadding * 2;
  const rasterScale = Math.min(1, MAX_CANVAS_SIDE / idealWidth, MAX_CANVAS_SIDE / idealHeight);
  const outlinePixels = idealOutlinePixels * rasterScale;
  const letterSpacingPixels = idealLetterSpacingPixels * rasterScale;
  const padding = idealPadding * rasterScale;
  const linePixels = idealLinePixels * rasterScale;
  const width = Math.max(1, Math.ceil(idealWidth * rasterScale));
  const height = Math.max(1, Math.ceil(idealHeight * rasterScale));
  const canvas = createCanvas(width, height);
  const context = contextFor(canvas);
  context.clearRect(0, 0, width, height);
  context.font = canvasFont(fontPixels * rasterScale, spec.fontId, spec.fontFamily, spec.fontVariations);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.miterLimit = 2;
  context.fillStyle = colorCss(spec.color ?? 0x202020);
  context.strokeStyle = colorCss(spec.outlineColor ?? 0xffffff);
  context.lineWidth = outlinePixels * 2;
  lines.forEach((line, index) => {
    const x = width / 2;
    const y = padding + linePixels * (index + 0.5);
    drawLine(context, line, x, y, letterSpacingPixels, outlinePixels);
  });

  const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(idealWidth / fontPixels * size, idealHeight / fontPixels * size, 32, 16);
  Object.defineProperty(geometry, "type", { value: "GfxCanvasTextGeometry", configurable: true });
  geometry.userData.gfxCanvasText = { text, width, height, lineCount: lines.length, rasterScale, fontPixels, letterSpacing: spec.letterSpacing ?? 0, rasterPixelsPerUnit: spec.rasterPixelsPerUnit, fontFamily: spec.fontFamily ?? "sans-serif" };
  geometry.userData.gfxCanvasTextTexture = texture;
  geometry.addEventListener("dispose", () => texture.dispose());
  return geometry;
}

export default class Text2DObject extends BuiltInObject {
  static readonly objectKind = "text2d" as const;
  static createGeometry(spec: GeometrySpec) { return createCanvasTextGeometry(spec); }

  constructor(geometry: THREE.BufferGeometry, material?: THREE.Material | THREE.Material[]) {
    super(geometry, material);
    const texture = geometry.userData.gfxCanvasTextTexture as THREE.Texture | undefined;
    for (const item of Array.isArray(this.material) ? this.material : [this.material]) {
      item.userData.gfxObjectMap = texture;
      if ("map" in item) (item as THREE.Material & { map: THREE.Texture | null }).map = texture ?? null;
      item.needsUpdate = true;
    }
    this.userData.gfxTextMode = "2d";
  }
}
