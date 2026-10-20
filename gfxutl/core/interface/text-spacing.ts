export const MIN_TEXT_LETTER_SPACING = -100;
export const MAX_TEXT_LETTER_SPACING = 300;

export type TextKeyframeProperty = "fontSize" | "letterSpacing" | "textDepth" | "textOutlineWidth";

/** Keyframe properties shared by timeline 2D Text and 3D Text objects. */
export function textKeyframePropertyOptions(textMode: "2d" | "3d" | undefined): Array<[TextKeyframeProperty, string]> {
  const properties: Array<[TextKeyframeProperty, string]> = [
    ["fontSize", "文字サイズ"],
    ["letterSpacing", "文字間隔"],
    ["textOutlineWidth", "輪郭の太さ"],
  ];
  if (textMode !== "2d") properties.push(["textDepth", "文字の奥行き"]);
  return properties;
}

export function clampTextLetterSpacing(value: number) {
  const finiteValue = Number.isFinite(value) ? value : 0;
  return Math.max(MIN_TEXT_LETTER_SPACING, Math.min(MAX_TEXT_LETTER_SPACING, finiteValue));
}

/** Converts the stored percentage into an additional distance between glyphs. */
export function textLetterSpacingDistance(fontSize: number, letterSpacing = 0) {
  return Math.max(0, Number.isFinite(fontSize) ? fontSize : 0) * clampTextLetterSpacing(letterSpacing) / 100;
}
