export function resolveTimelineKeyframeTime(requestedTime: number, duration: number, fps: number, snapEnabled: boolean) {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const clamped = Math.max(0, Math.min(safeDuration, Number.isFinite(requestedTime) ? requestedTime : 0));
  if (!snapEnabled) return clamped;
  const frameRate = Math.max(1, Number.isFinite(fps) ? fps : 1);
  return Math.max(0, Math.min(safeDuration, Math.round(clamped * frameRate) / frameRate));
}

export function createEmptyTimelineKeyframe(id: string, time: number) {
  return { id, property: "" as const, time, value: 0, interpolation: "smooth" as const };
}
