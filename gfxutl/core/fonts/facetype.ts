/*
 * Conversion format and scaling are adapted from facetype.js:
 * https://github.com/gero3/facetype.js
 *
 * MIT License
 * Copyright (c) 2016 gero3
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type * as OpenType from "opentype.js";
import type { FontData } from "three/addons/loaders/FontLoader.js";

type FontTables = {
  head?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
  post?: { underlinePosition?: number; underlineThickness?: number };
};

export async function convertLocalFontWithFacetype(buffer: ArrayBuffer, characters: string): Promise<FontData> {
  const imported = await import("opentype.js");
  const opentype = typeof imported.parse === "function"
    ? imported
    : (imported as unknown as { default: typeof imported }).default;
  const font = opentype.parse(buffer, { lowMemory: true });
  return convertFacetypeFont(font, characters);
}

export function facetypeCharacterSet(text: string) {
  return [...new Set(Array.from(`${text}? `).filter((character) => character !== "\n" && character !== "\r"))]
    .sort((left, right) => (left.codePointAt(0) ?? 0) - (right.codePointAt(0) ?? 0))
    .join("");
}

function convertFacetypeFont(font: OpenType.Font, characters: string): FontData {
  // This is the scale used by facetype.js for its 1000-unit typeface format.
  const scale = (1000 * 100) / ((font.unitsPerEm || 2048) * 72);
  const glyphs: FontData["glyphs"] = {};

  for (const character of facetypeCharacterSet(characters)) {
    const glyph = font.charToGlyph(character);
    glyphs[character] = {
      ha: Math.round((glyph.advanceWidth ?? font.unitsPerEm) * scale),
      x_min: Math.round((glyph.xMin ?? 0) * scale),
      x_max: Math.round((glyph.xMax ?? 0) * scale),
      o: glyph.path.commands.map((command) => facetypeCommand(command, scale)).join(""),
    };
  }

  const tables = font.tables as FontTables;
  const head = tables.head;
  const post = tables.post;
  const familyName = font.getEnglishName("fontFamily") || "Local font";
  const styleName = font.getEnglishName("fontSubfamily") || "Regular";

  return {
    glyphs,
    familyName,
    ascender: Math.round(font.ascender * scale),
    descender: Math.round(font.descender * scale),
    underlinePosition: Math.round((post?.underlinePosition ?? 0) * scale),
    underlineThickness: Math.round((post?.underlineThickness ?? 0) * scale),
    boundingBox: {
      yMin: Math.round((head?.yMin ?? font.descender) * scale),
      xMin: Math.round((head?.xMin ?? 0) * scale),
      yMax: Math.round((head?.yMax ?? font.ascender) * scale),
      xMax: Math.round((head?.xMax ?? font.unitsPerEm) * scale),
    },
    resolution: 1000,
    original_font_information: {
      converter: "facetype.js",
      familyName,
      styleName,
    },
  };
}

function facetypeCommand(command: OpenType.PathCommand, scale: number) {
  const values: number[] = [];
  if ("x" in command && "y" in command) values.push(command.x, command.y);
  if ("x1" in command && "y1" in command) values.push(command.x1, command.y1);
  if ("x2" in command && "y2" in command) values.push(command.x2, command.y2);
  const operation = command.type.toLowerCase() === "c" ? "b" : command.type.toLowerCase();
  return `${operation} ${values.map((value) => Math.round(value * scale)).join(" ")}${values.length ? " " : ""}`;
}
