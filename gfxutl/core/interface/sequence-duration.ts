import type { TimelineClip } from "./types";

export const DEFAULT_SEQUENCE_DURATION = 32;

export function sequenceEnd(clips: readonly TimelineClip[], fps: number, emptyDuration = DEFAULT_SEQUENCE_DURATION) {
  if (!clips.length) return emptyDuration;
  const minimumDuration = 1 / Math.max(1, fps);
  const ends = clips
    .map((clip) => clip.start + clip.duration)
    .filter((end) => Number.isFinite(end));
  return ends.length ? Math.max(minimumDuration, emptyDuration, ...ends) : emptyDuration;
}
