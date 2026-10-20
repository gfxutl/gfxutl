import type { ClipEffect } from "../protocol/engine-protocol";

export function resolveVisualOpacity(clipOpacity: number, effects: readonly ClipEffect[]) {
  let opacity = clipOpacity / 100;
  for (const effect of effects) {
    if (!effect.enabled || effect.filterRegion || effect.kind !== "opacity") continue;
    opacity *= (effect.params.amount ?? 100) / 100;
  }
  return Math.max(0, Math.min(1, opacity));
}

export function updateVisualOpacityControl(material: { opacity: number; userData: Record<string, unknown> }, opacity: number) {
  const clamped = Math.max(0, Math.min(1, opacity));
  material.opacity = clamped;
  const node = material.userData.gfxOpacityNode as { value?: number } | undefined;
  if (node) node.value = clamped;
  return clamped;
}
