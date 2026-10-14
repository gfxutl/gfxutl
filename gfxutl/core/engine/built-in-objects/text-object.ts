import type { GeometrySpec } from "../../protocol/engine-protocol";
import { createGfxTextGeometry } from "../gfx-text-geometry";
import { BuiltInObject } from "./built-in-object";

/** Extruded vector-glyph text. Kept on the legacy `text` kind for project compatibility. */
export default class Text3DObject extends BuiltInObject {
  static readonly objectKind = "text" as const;
  static createGeometry(spec: GeometrySpec) { return createGfxTextGeometry(spec); }
}
