const PREVIEW_DRAG_THRESHOLD_PX = 3;

/** Distinguishes an intentional preview drag from normal pointer jitter during a click. */
export function isPreviewPointerDrag(startX: number, startY: number, clientX: number, clientY: number) {
  const deltaX = clientX - startX;
  const deltaY = clientY - startY;
  return deltaX * deltaX + deltaY * deltaY >= PREVIEW_DRAG_THRESHOLD_PX * PREVIEW_DRAG_THRESHOLD_PX;
}
