import type { TimelineClip } from "./types";

/**
 * Returns the timeline's back-to-front draw traversal. At the same explicit
 * Z position, rows are traversed from the top of the timeline to the bottom.
 * A user-assigned stackOrder remains authoritative over this default.
 */
export function orderedVisualClips(clips: readonly TimelineClip[]) {
  const visualClips = clips.filter((clip) => clip.kind !== "group" && clip.kind !== "filter");
  const timelineOrder = new Map([...visualClips]
    .sort((a, b) => (a.positionZ ?? 0) - (b.positionZ ?? 0) || a.y - b.y)
    .map((clip, index) => [clip.id, index]));
  return [...visualClips].sort((a, b) => {
    const aOrder = Number.isFinite(a.stackOrder) ? a.stackOrder! : timelineOrder.get(a.id) ?? 0;
    const bOrder = Number.isFinite(b.stackOrder) ? b.stackOrder! : timelineOrder.get(b.id) ?? 0;
    return aOrder - bOrder || (timelineOrder.get(a.id) ?? 0) - (timelineOrder.get(b.id) ?? 0);
  });
}

/** Filters are likewise composed in visual timeline order: top row to bottom. */
export function orderedTimelineFilters(clips: readonly TimelineClip[]) {
  return clips
    .filter((clip) => clip.kind === "filter")
    .sort((a, b) => a.y - b.y);
}
