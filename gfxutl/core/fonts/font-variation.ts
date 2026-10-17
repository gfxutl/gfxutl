export type FontVariationSettings = Record<string, number>;

export interface FontVariationAxis {
  tag: string;
  name: string;
  minValue: number;
  defaultValue: number;
  maxValue: number;
}

export function normalizeFontVariations(value: unknown): FontVariationSettings {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([tag, coordinate]) => /^[\x20-\x7e]{4}$/.test(tag) && typeof coordinate === "number" && Number.isFinite(coordinate))
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function fontVariationKey(value: FontVariationSettings | undefined) {
  return Object.entries(normalizeFontVariations(value))
    .map(([tag, coordinate]) => `${tag}=${coordinate}`)
    .join(",");
}

export function fontVariationId(fontId: string, value: FontVariationSettings | undefined) {
  const key = fontVariationKey(value);
  return key ? `${fontId}#variation:${key}` : fontId;
}

export function fontVariationCss(value: FontVariationSettings | undefined) {
  return Object.entries(normalizeFontVariations(value))
    .map(([tag, coordinate]) => `"${tag}" ${coordinate}`)
    .join(", ");
}

export function fontVariationWeight(value: FontVariationSettings | undefined) {
  const weight = normalizeFontVariations(value).wght;
  return weight === undefined ? undefined : Math.max(1, Math.min(1000, weight));
}

export function defaultFontVariations(axes: FontVariationAxis[]) {
  return Object.fromEntries(axes.map((axis) => [axis.tag, axis.defaultValue]));
}

export function clampFontVariations(value: FontVariationSettings | undefined, axes: FontVariationAxis[]) {
  const normalized = normalizeFontVariations(value);
  return Object.fromEntries(axes.map((axis) => [
    axis.tag,
    Math.max(axis.minValue, Math.min(axis.maxValue, normalized[axis.tag] ?? axis.defaultValue)),
  ]));
}
