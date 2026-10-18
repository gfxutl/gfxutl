import * as THREE from "three/webgpu";
import type * as OpenType from "opentype.js";
import helvetikerData from "three.regular.helvetiker";
import type { GeometrySpec } from "../protocol/engine-protocol";
import { fontVariationId, normalizeFontVariations, type FontVariationSettings } from "../fonts/font-variation";
import { textLetterSpacingDistance } from "../interface/text-spacing";

type GlyphCommand =
  | { type: "M" | "L"; x: number; y: number }
  | { type: "Q"; x: number; y: number; x1: number; y1: number }
  | { type: "C"; x: number; y: number; x1: number; y1: number; x2: number; y2: number }
  | { type: "Z" };

interface PreparedGlyph {
  id: number;
  advance: number;
  commands: GlyphCommand[];
}

interface GlyphSource {
  readonly id: string;
  readonly unitsPerEm: number;
  readonly lineHeight: number;
  glyph(character: string): PreparedGlyph;
  kerning(left: PreparedGlyph, right: PreparedGlyph): number;
  cacheSize(): number;
}

interface TypefaceGlyph {
  ha: number;
  o?: string;
}

interface TypefaceData {
  resolution: number;
  ascender: number;
  descender: number;
  underlineThickness: number;
  boundingBox: { yMin: number; yMax: number };
  glyphs: Record<string, TypefaceGlyph>;
}

export interface GfxTextGlyphLayout {
  character: string;
  characterIndex: number;
  glyphId: number;
  origin: [number, number];
  advance: number;
  vertexStart: number;
  vertexCount: number;
  delay: number;
}

export interface GfxTextLayout {
  fontId: string;
  glyphs: GfxTextGlyphLayout[];
  width: number;
  height: number;
  lineCount: number;
  stagger: number;
}

export const GFX_TEXT_ATTRIBUTES = {
  glyphIndex: "gfxGlyphIndex",
  glyphDelay: "gfxGlyphDelay",
  glyphOrigin: "gfxGlyphOrigin",
  glyphUv: "gfxGlyphUv",
} as const;

const localFonts = new Map<string, GlyphSource>();
const registeredOpenTypeFonts = new Map<string, OpenType.Font>();
const derivedVariationFonts = new Map<string, GlyphSource>();
const MAX_DERIVED_VARIATION_FONTS = 64;

class TypefaceGlyphSource implements GlyphSource {
  readonly id = "gfxutl:helvetiker";
  readonly unitsPerEm: number;
  readonly lineHeight: number;
  private readonly glyphCache = new Map<string, PreparedGlyph>();

  constructor(private readonly data: TypefaceData) {
    this.unitsPerEm = data.resolution;
    this.lineHeight = data.boundingBox.yMax - data.boundingBox.yMin + data.underlineThickness;
  }

  glyph(character: string) {
    const cached = this.glyphCache.get(character);
    if (cached) return cached;
    const source = this.data.glyphs[character] ?? this.data.glyphs["?"];
    const commands: GlyphCommand[] = [];
    const tokens = source?.o?.trim().split(/\s+/) ?? [];
    for (let cursor = 0; cursor < tokens.length;) {
      const operation = tokens[cursor++];
      const number = () => Number(tokens[cursor++]);
      if (operation === "m" || operation === "l") commands.push({ type: operation.toUpperCase() as "M" | "L", x: number(), y: number() });
      else if (operation === "q") {
        const x = number(); const y = number(); const x1 = number(); const y1 = number();
        commands.push({ type: "Q", x, y, x1, y1 });
      } else if (operation === "b") {
        const x = number(); const y = number(); const x1 = number(); const y1 = number(); const x2 = number(); const y2 = number();
        commands.push({ type: "C", x, y, x1, y1, x2, y2 });
      }
    }
    const glyph = { id: character.codePointAt(0) ?? 0, advance: source?.ha ?? this.unitsPerEm, commands };
    this.glyphCache.set(character, glyph);
    return glyph;
  }

  kerning() { return 0; }
  cacheSize() { return this.glyphCache.size; }
}

class OpenTypeGlyphSource implements GlyphSource {
  readonly unitsPerEm: number;
  readonly lineHeight: number;
  private readonly glyphCache = new Map<string, PreparedGlyph>();
  private readonly glyphById = new Map<number, OpenType.Glyph>();
  private readonly kerningCache = new Map<string, number>();

  constructor(readonly id: string, private readonly font: OpenType.Font, private readonly variations: FontVariationSettings = {}) {
    this.unitsPerEm = font.unitsPerEm;
    this.lineHeight = font.ascender - font.descender;
  }

  glyph(character: string) {
    const cached = this.glyphCache.get(character);
    if (cached) return cached;
    // opentype.js is parsed in low-memory mode. charToGlyph materializes only
    // this glyph's outline from the font tables, rather than expanding the font.
    const source = this.font.charToGlyph(character);
    const variableFont = this.font as OpenType.Font & { variation?: { getTransform(glyph: OpenType.Glyph, settings?: FontVariationSettings): OpenType.Glyph } };
    const transformed = variableFont.variation && Object.keys(this.variations).length
      ? variableFont.variation.getTransform(source, this.variations)
      : source;
    const path = source.getPath(0, 0, this.unitsPerEm, { kerning: false, variation: this.variations } as OpenType.RenderOptions, this.font);
    const commands: GlyphCommand[] = [];
    for (const raw of path.commands) {
      if (raw.type === "M" || raw.type === "L") commands.push({ type: raw.type, x: raw.x, y: -raw.y });
      else if (raw.type === "Q") commands.push({ type: "Q", x: raw.x, y: -raw.y, x1: raw.x1, y1: -raw.y1 });
      else if (raw.type === "C") commands.push({ type: "C", x: raw.x, y: -raw.y, x1: raw.x1, y1: -raw.y1, x2: raw.x2, y2: -raw.y2 });
      else if (raw.type === "Z") commands.push({ type: "Z" });
    }
    const glyph = { id: source.index, advance: transformed.advanceWidth ?? source.advanceWidth ?? this.unitsPerEm, commands };
    this.glyphCache.set(character, glyph);
    this.glyphById.set(glyph.id, source);
    return glyph;
  }

  kerning(left: PreparedGlyph, right: PreparedGlyph) {
    const key = `${left.id}:${right.id}`;
    const cached = this.kerningCache.get(key);
    if (cached !== undefined) return cached;
    const leftGlyph = this.glyphById.get(left.id);
    const rightGlyph = this.glyphById.get(right.id);
    const value = leftGlyph && rightGlyph ? this.font.getKerningValue(leftGlyph, rightGlyph) : 0;
    this.kerningCache.set(key, value);
    return value;
  }

  cacheSize() { return this.glyphCache.size; }
}

const defaultFont = new TypefaceGlyphSource(helvetikerData as unknown as TypefaceData);

export async function registerGfxTextFont(fontId: string, buffer: ArrayBuffer) {
  const opentype = await import("opentype.js");
  const font = opentype.parse(buffer, { lowMemory: true });
  registeredOpenTypeFonts.set(fontId, font);
  localFonts.set(fontId, new OpenTypeGlyphSource(fontId, font));
}

export function registerGfxTextFontVariation(fontId: string, sourceFontId: string, variations: FontVariationSettings) {
  const font = registeredOpenTypeFonts.get(sourceFontId);
  if (!font) throw new Error(`Source font is not registered: ${sourceFontId}`);
  localFonts.set(fontId, new OpenTypeGlyphSource(fontId, font, normalizeFontVariations(variations)));
}

export function getGfxTextFontCacheInfo(fontId?: string) {
  const font = fontId ? localFonts.get(fontId) : defaultFont;
  return { fontId: font?.id, cachedGlyphs: font?.cacheSize() ?? 0 };
}

function sourceFor(fontId?: string, variations?: FontVariationSettings) {
  if (!fontId) return defaultFont;
  const normalized = normalizeFontVariations(variations);
  const variationId = fontVariationId(fontId, normalized);
  const registered = localFonts.get(variationId);
  if (registered) return registered;
  const cached = derivedVariationFonts.get(variationId);
  if (cached) {
    derivedVariationFonts.delete(variationId);
    derivedVariationFonts.set(variationId, cached);
    return cached;
  }
  const font = registeredOpenTypeFonts.get(fontId);
  if (!font || variationId === fontId) return localFonts.get(fontId) ?? defaultFont;
  const source = new OpenTypeGlyphSource(variationId, font, normalized);
  derivedVariationFonts.set(variationId, source);
  if (derivedVariationFonts.size > MAX_DERIVED_VARIATION_FONTS) {
    const oldest = derivedVariationFonts.keys().next().value;
    if (oldest) derivedVariationFonts.delete(oldest);
  }
  return source;
}

function glyphShapes(glyph: PreparedGlyph, scale: number, penX: number, penY: number) {
  const path = new THREE.ShapePath();
  for (const command of glyph.commands) {
    if (command.type === "M") path.moveTo(penX + command.x * scale, penY + command.y * scale);
    else if (command.type === "L") path.lineTo(penX + command.x * scale, penY + command.y * scale);
    else if (command.type === "Q") path.quadraticCurveTo(penX + command.x1 * scale, penY + command.y1 * scale, penX + command.x * scale, penY + command.y * scale);
    else if (command.type === "C") path.bezierCurveTo(penX + command.x1 * scale, penY + command.y1 * scale, penX + command.x2 * scale, penY + command.y2 * scale, penX + command.x * scale, penY + command.y * scale);
    else path.currentPath?.closePath();
  }
  return path.toShapes();
}

function cleanContour(points: THREE.Vector2[]) {
  if (points.length > 2 && points[0].equals(points.at(-1)!)) return points.slice(0, -1);
  return [...points];
}

interface GeometryBuffers {
  positions: number[];
  uvs: number[];
  glyphIndices: number[];
  glyphDelays: number[];
  glyphOrigins: number[];
  glyphUvs: number[];
}

function pushVertex(buffers: GeometryBuffers, point: THREE.Vector2, z: number, glyphIndex: number, delay: number, origin: THREE.Vector2, size: number) {
  buffers.positions.push(point.x, point.y, z);
  buffers.uvs.push(point.x, point.y);
  buffers.glyphIndices.push(glyphIndex);
  buffers.glyphDelays.push(delay);
  buffers.glyphOrigins.push(origin.x, origin.y, 0);
  buffers.glyphUvs.push((point.x - origin.x) / size + 0.5, (point.y - origin.y) / size + 0.5);
}

function pushFace(buffers: GeometryBuffers, points: THREE.Vector2[], face: number[], z: number, reverse: boolean, glyphIndex: number, delay: number, origin: THREE.Vector2, size: number) {
  const indices = reverse ? [face[2], face[1], face[0]] : face;
  for (const index of indices) pushVertex(buffers, points[index], z, glyphIndex, delay, origin, size);
}

function pushSide(buffers: GeometryBuffers, a: THREE.Vector2, b: THREE.Vector2, depth: number, reverse: boolean, glyphIndex: number, delay: number, origin: THREE.Vector2, size: number) {
  const vertices = reverse
    ? [[a, 0], [b, 0], [b, depth], [a, 0], [b, depth], [a, depth]] as const
    : [[a, 0], [b, depth], [b, 0], [a, 0], [a, depth], [b, depth]] as const;
  for (const [point, z] of vertices) pushVertex(buffers, point, z, glyphIndex, delay, origin, size);
}

function appendShape(buffers: GeometryBuffers, shape: THREE.Shape, depth: number, segments: number, glyphIndex: number, delay: number, origin: THREE.Vector2, size: number) {
  const extracted = shape.extractPoints(segments);
  let contour = cleanContour(extracted.shape);
  if (!THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const holes = extracted.holes.map(cleanContour);
  for (const hole of holes) if (THREE.ShapeUtils.isClockWise(hole)) hole.reverse();
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const points = contour.concat(...holes);
  for (const face of faces) {
    pushFace(buffers, points, face, depth, false, glyphIndex, delay, origin, size);
    if (depth > 0) pushFace(buffers, points, face, 0, true, glyphIndex, delay, origin, size);
  }
  if (depth <= 0) return;
  const rings = [contour, ...holes];
  rings.forEach((ring, ringIndex) => {
    for (let index = 0; index < ring.length; index++) {
      pushSide(buffers, ring[index], ring[(index + 1) % ring.length], depth, ringIndex > 0, glyphIndex, delay, origin, size);
    }
  });
}

/**
 * GfxUtl's text mesh. Three.js supplies only BufferGeometry primitives and
 * triangulation; glyph loading, layout, extrusion and per-character metadata
 * are owned by this class.
 */
export class GfxTextGeometry extends THREE.BufferGeometry {
  readonly layout: GfxTextLayout;

  constructor(spec: GeometrySpec) {
    super();
    Object.defineProperty(this, "type", { value: "GfxTextGeometry", configurable: true });
    const text = spec.text || "Text";
    const size = Math.max(0.001, spec.size ?? 1.2);
    const letterSpacing = textLetterSpacingDistance(size, spec.letterSpacing);
    const depth = Math.max(0, spec.depth ?? 0.12);
    const segments = Math.max(1, Math.floor(spec.curveSegments ?? 8));
    const stagger = Math.max(0, spec.glyphStagger ?? 0.04);
    // Geometry specs are the source of truth for variable coordinates. This
    // avoids depending on a separately registered alias when a slider update
    // and a preview render are queued close together.
    const source = sourceFor(spec.fontId, spec.fontVariations);
    const scale = size / source.unitsPerEm;
    const buffers: GeometryBuffers = { positions: [], uvs: [], glyphIndices: [], glyphDelays: [], glyphOrigins: [], glyphUvs: [] };
    const glyphs: GfxTextGlyphLayout[] = [];
    let penX = 0;
    let penY = 0;
    let width = 0;
    let lineCount = 1;
    let previous: PreparedGlyph | undefined;

    [...text].forEach((character, characterIndex) => {
      if (character === "\n") {
        width = Math.max(width, penX);
        penX = 0;
        penY -= source.lineHeight * scale;
        previous = undefined;
        lineCount++;
        return;
      }
      const glyph = source.glyph(character);
      if (previous) penX += source.kerning(previous, glyph) * scale + letterSpacing;
      const advance = glyph.advance * scale;
      const origin = new THREE.Vector2(penX + advance / 2, penY);
      const vertexStart = buffers.positions.length / 3;
      const delay = characterIndex * stagger;
      for (const shape of glyphShapes(glyph, scale, penX, penY)) appendShape(buffers, shape, depth, segments, characterIndex, delay, origin, size);
      glyphs.push({ character, characterIndex, glyphId: glyph.id, origin: [origin.x, origin.y], advance, vertexStart, vertexCount: buffers.positions.length / 3 - vertexStart, delay });
      penX += advance;
      width = Math.max(width, penX);
      previous = glyph;
    });

    this.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
    this.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uvs, 2));
    this.setAttribute(GFX_TEXT_ATTRIBUTES.glyphIndex, new THREE.Float32BufferAttribute(buffers.glyphIndices, 1));
    this.setAttribute(GFX_TEXT_ATTRIBUTES.glyphDelay, new THREE.Float32BufferAttribute(buffers.glyphDelays, 1));
    this.setAttribute(GFX_TEXT_ATTRIBUTES.glyphOrigin, new THREE.Float32BufferAttribute(buffers.glyphOrigins, 3));
    this.setAttribute(GFX_TEXT_ATTRIBUTES.glyphUv, new THREE.Float32BufferAttribute(buffers.glyphUvs, 2));
    if (buffers.positions.length) {
      this.computeVertexNormals();
      this.computeBoundingBox();
      const bounds = this.boundingBox!;
      const centerX = (bounds.min.x + bounds.max.x) / 2;
      const centerY = (bounds.min.y + bounds.max.y) / 2;
      this.translate(-centerX, -centerY, 0);
      const origins = this.getAttribute(GFX_TEXT_ATTRIBUTES.glyphOrigin) as THREE.BufferAttribute;
      for (let index = 0; index < origins.count; index++) origins.setXYZ(index, origins.getX(index) - centerX, origins.getY(index) - centerY, 0);
      origins.needsUpdate = true;
      for (const glyph of glyphs) { glyph.origin[0] -= centerX; glyph.origin[1] -= centerY; }
      this.computeBoundingBox();
      this.computeBoundingSphere();
    }
    const height = lineCount * source.lineHeight * scale;
    this.layout = { fontId: source.id, glyphs, width, height, lineCount, stagger };
    this.userData.gfxText = this.layout;
  }
}

export function createGfxTextGeometry(spec: GeometrySpec) {
  return new GfxTextGeometry(spec);
}
