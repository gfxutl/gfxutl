export interface CropInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export function clampCropInsets(sourceWidth: number, sourceHeight: number, crop: CropInsets): CropInsets {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const left = clampFinite(crop.left, 0, width - 1);
  const right = clampFinite(crop.right, 0, width - left - 1);
  const top = clampFinite(crop.top, 0, height - 1);
  const bottom = clampFinite(crop.bottom, 0, height - top - 1);
  return { left, right, top, bottom };
}

export function croppedPlaneGeometry(sourceWidth: number, sourceHeight: number, baseWidth: number, baseHeight: number, crop: CropInsets) {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const normalized = clampCropInsets(width, height, crop);
  const widthRatio = Math.max(1 / width, 1 - (normalized.left + normalized.right) / width);
  const heightRatio = Math.max(1 / height, 1 - (normalized.top + normalized.bottom) / height);
  return {
    ...normalized,
    width: baseWidth * widthRatio,
    height: baseHeight * heightRatio,
    offsetX: baseWidth * (normalized.left - normalized.right) / (2 * width),
    offsetY: baseHeight * (normalized.bottom - normalized.top) / (2 * height),
    repeatX: widthRatio,
    repeatY: heightRatio,
  };
}

export function resolveCropDrag(input: {
  sourceWidth: number;
  sourceHeight: number;
  start: CropInsets;
  handle: CropHandle;
  localDeltaX: number;
  localDeltaY: number;
  pixelsPerWorldX: number;
  pixelsPerWorldY: number;
}) {
  const start = clampCropInsets(input.sourceWidth, input.sourceHeight, input.start);
  const next = { ...start };
  if (input.handle.includes("w")) next.left = start.left + input.localDeltaX * input.pixelsPerWorldX;
  if (input.handle.includes("e")) next.right = start.right - input.localDeltaX * input.pixelsPerWorldX;
  if (input.handle.includes("n")) next.top = start.top - input.localDeltaY * input.pixelsPerWorldY;
  if (input.handle.includes("s")) next.bottom = start.bottom + input.localDeltaY * input.pixelsPerWorldY;

  if (input.handle.includes("w")) next.left = clampFinite(next.left, 0, Math.max(0, input.sourceWidth - start.right - 1));
  if (input.handle.includes("e")) next.right = clampFinite(next.right, 0, Math.max(0, input.sourceWidth - start.left - 1));
  if (input.handle.includes("n")) next.top = clampFinite(next.top, 0, Math.max(0, input.sourceHeight - start.bottom - 1));
  if (input.handle.includes("s")) next.bottom = clampFinite(next.bottom, 0, Math.max(0, input.sourceHeight - start.top - 1));
  return next;
}

function clampFinite(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}
