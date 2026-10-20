export type TimelineResizeEdge = "start" | "end";

export interface TimelinePlayheadAlignment {
  distance: number;
  start: number;
  time: number;
  movingEdge: TimelineResizeEdge;
}

export function findTimelinePlayheadAlignment(
  candidate: { start: number; duration: number },
  playheadTime: number,
  pxPerSecond: number,
  movingEdges: readonly TimelineResizeEdge[],
  threshold = 9,
): TimelinePlayheadAlignment | null {
  if (!Number.isFinite(playheadTime) || !Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return null;
  let best: TimelinePlayheadAlignment | null = null;
  for (const movingEdge of movingEdges) {
    const movingTime = movingEdge === "start" ? candidate.start : candidate.start + candidate.duration;
    const distance = Math.abs(playheadTime - movingTime) * pxPerSecond;
    if (distance > threshold || (best && distance >= best.distance)) continue;
    const start = movingEdge === "start" ? playheadTime : playheadTime - candidate.duration;
    if (start < 0) continue;
    best = { distance, start, time: playheadTime, movingEdge };
  }
  return best;
}
