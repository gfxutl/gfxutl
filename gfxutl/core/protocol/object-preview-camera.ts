export const OBJECT_PREVIEW_WORLD_HEIGHT = 9;

/** Fixed orthographic bounds used by isolated object tabs and their DOM overlays. */
export function objectPreviewFrustum(aspect: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfHeight = OBJECT_PREVIEW_WORLD_HEIGHT / 2;
  return {
    left: -halfHeight * safeAspect,
    right: halfHeight * safeAspect,
    top: halfHeight,
    bottom: -halfHeight,
  };
}
