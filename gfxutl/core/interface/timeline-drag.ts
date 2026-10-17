export type TimelineDragAxis = "horizontal" | "vertical";

export function resolveTimelineDragAxis(
  deltaX: number,
  deltaY: number,
  currentAxis: TimelineDragAxis | null,
  constrained: boolean,
): TimelineDragAxis | null {
  if (!constrained) return null;
  return currentAxis ?? (Math.abs(deltaX) >= Math.abs(deltaY) ? "horizontal" : "vertical");
}

export function constrainTimelineDrag(deltaX: number, deltaY: number, axis: TimelineDragAxis | null) {
  return {
    deltaX: axis === "vertical" ? 0 : deltaX,
    deltaY: axis === "horizontal" ? 0 : deltaY,
  };
}
