export const MIN_TEXT_LETTER_SPACING = -100;
export const MAX_TEXT_LETTER_SPACING = 300;

export function clampTextLetterSpacing(value: number) {
  const finiteValue = Number.isFinite(value) ? value : 0;
  return Math.max(MIN_TEXT_LETTER_SPACING, Math.min(MAX_TEXT_LETTER_SPACING, finiteValue));
}

/** Converts the stored percentage into an additional distance between glyphs. */
export function textLetterSpacingDistance(fontSize: number, letterSpacing = 0) {
  return Math.max(0, Number.isFinite(fontSize) ? fontSize : 0) * clampTextLetterSpacing(letterSpacing) / 100;
}
