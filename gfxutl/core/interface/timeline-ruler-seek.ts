export function timelineRulerSeekTime(viewportX: number, scrollLeft: number, pxPerSecond: number, duration: number) {
  const time = (Math.max(0, viewportX) + Math.max(0, scrollLeft)) / Math.max(0.001, pxPerSecond);
  return Math.max(0, Math.min(Math.max(0, duration), time));
}
