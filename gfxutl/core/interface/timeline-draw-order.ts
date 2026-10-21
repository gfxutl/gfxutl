import type { TimelineClip } from "./types";

/**
 * Returns visual clips from the back of the 3D scene to the front. Timeline
 * row placement is deliberately irrelevant to scene depth.
 */
export function orderedVisualClips(clips: readonly TimelineClip[]) {
  return clips
    .filter((clip) => clip.kind !== "group" && clip.kind !== "filter")
    .sort((a, b) => (a.positionZ ?? 0) - (b.positionZ ?? 0));
}

/** Filters are composed from the back of the 3D scene to the front. */
export function orderedTimelineFilters(clips: readonly TimelineClip[]) {
  return clips
    .filter((clip) => clip.kind === "filter")
    .sort((a, b) => (a.positionZ ?? 0) - (b.positionZ ?? 0));
}
