export const MIN_TIMELINE_ZOOM = 0.05;
export const MAX_TIMELINE_ZOOM = 64;

export function clampTimelineZoom(zoom: number) {
  const finiteZoom = Number.isFinite(zoom) ? zoom : 1;
  return Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, finiteZoom));
}
