import type { BackgroundObject } from "./types";

export const DEFAULT_COMPOSITION_SIZE = { width: 1920, height: 1080 } as const;

export const COMPOSITION_SIZE_PRESETS = [
  { width: 3840, height: 2160 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 2160, height: 3840 },
  { width: 1080, height: 1920 },
  { width: 720, height: 1280 },
] as const;

export function normalizeCompositionDimension(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(2, Math.min(7680, Math.round(value)))
    : fallback;
}

export function normalizeBackgroundSize(background: BackgroundObject, fallback: { width?: unknown; height?: unknown } = DEFAULT_COMPOSITION_SIZE): BackgroundObject {
  const fallbackWidth = normalizeCompositionDimension(fallback.width, DEFAULT_COMPOSITION_SIZE.width);
  const fallbackHeight = normalizeCompositionDimension(fallback.height, DEFAULT_COMPOSITION_SIZE.height);
  const camera = background.scene.camera as Partial<BackgroundObject["scene"]["camera"]>;
  return {
    ...background,
    width: normalizeCompositionDimension(background.width, fallbackWidth),
    height: normalizeCompositionDimension(background.height, fallbackHeight),
    scene: {
      ...background.scene,
      camera: {
        ...background.scene.camera,
        id: camera.id || "camera-1",
        name: camera.name || "Camera 1",
      },
    },
  };
}
