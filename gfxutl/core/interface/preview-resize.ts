const MIN_SIZE = 0.04;
const MIN_SCALE = 1;
const MAX_SCALE = 5_000;

export interface PreviewResizeInput {
  startWidth: number;
  startHeight: number;
  startScaleX: number;
  startScaleY: number;
  localX: number;
  localY: number;
  directionX: number;
  directionY: number;
  preserveAspect: boolean;
  fromCenter: boolean;
}

export interface PreviewResizeResult {
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  centerOffsetX: number;
  centerOffsetY: number;
}

/** Resolves preview-handle resizing in the object's unrotated local space. */
export function resolvePreviewResize(input: PreviewResizeInput): PreviewResizeResult {
  const {
    startWidth, startHeight, startScaleX, startScaleY,
    localX, localY, directionX, directionY,
    preserveAspect, fromCenter,
  } = input;
  const resizeX = directionX !== 0;
  const resizeY = directionY !== 0;
  const requestedWidth = resizeX
    ? Math.max(MIN_SIZE, directionX * localX * (fromCenter ? 2 : 1) + (fromCenter ? 0 : startWidth / 2))
    : startWidth;
  const requestedHeight = resizeY
    ? Math.max(MIN_SIZE, directionY * localY * (fromCenter ? 2 : 1) + (fromCenter ? 0 : startHeight / 2))
    : startHeight;

  let scaleX: number;
  let scaleY: number;
  if (preserveAspect) {
    let factor: number;
    if (resizeX && resizeY) {
      // Project the pointer-requested rectangle onto the original aspect-ratio
      // line so corner drags remain smooth regardless of drag direction.
      factor = (requestedWidth * startWidth + requestedHeight * startHeight)
        / (startWidth * startWidth + startHeight * startHeight);
    } else if (resizeX) factor = requestedWidth / startWidth;
    else factor = requestedHeight / startHeight;
    const minimumFactor = Math.max(MIN_SCALE / startScaleX, MIN_SCALE / startScaleY, MIN_SIZE / startWidth, MIN_SIZE / startHeight);
    const maximumFactor = Math.min(MAX_SCALE / startScaleX, MAX_SCALE / startScaleY);
    factor = Math.max(minimumFactor, Math.min(maximumFactor, factor));
    scaleX = startScaleX * factor;
    scaleY = startScaleY * factor;
  } else {
    scaleX = resizeX ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScaleX * requestedWidth / startWidth)) : startScaleX;
    scaleY = resizeY ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScaleY * requestedHeight / startHeight)) : startScaleY;
  }

  const width = startWidth * scaleX / startScaleX;
  const height = startHeight * scaleY / startScaleY;
  return {
    scaleX,
    scaleY,
    width,
    height,
    centerOffsetX: fromCenter || !resizeX ? 0 : directionX * (width - startWidth) / 2,
    centerOffsetY: fromCenter || !resizeY ? 0 : directionY * (height - startHeight) / 2,
  };
}
