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

export function alignExportRangeToSequence<T extends { fps: number; startTime: number; endTime: number }>(settings: T, duration: number): T {
  const endTime = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const outputFps = Number.isFinite(settings.fps) ? Math.max(1, settings.fps) : 1;
  const maximumStart = Math.max(0, endTime - 1 / outputFps);
  const requestedStart = Number.isFinite(settings.startTime) ? settings.startTime : 0;
  return { ...settings, startTime: Math.max(0, Math.min(maximumStart, requestedStart)), endTime };
}
