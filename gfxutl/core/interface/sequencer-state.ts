import type { CameraSettings, SceneSettings } from "../protocol/engine-protocol";

export function clipTransitionGain(
  clip: { transitionIn?: number; transitionOut?: number; duration: number },
  localTime: number,
) {
  const time = Math.max(0, Math.min(clip.duration, localTime));
  const remaining = Math.max(0, clip.duration - time);
  const fadeIn = Math.max(0, clip.transitionIn ?? 0);
  const fadeOut = Math.max(0, clip.transitionOut ?? 0);
  return (fadeIn > 0 ? Math.min(1, time / fadeIn) : 1)
    * (fadeOut > 0 ? Math.min(1, remaining / fadeOut) : 1);
}

export function cameraForTime(settings: Pick<SceneSettings, "camera" | "cameras" | "cameraCuts">, time: number): CameraSettings {
  let activeCut: NonNullable<SceneSettings["cameraCuts"]>[number] | undefined;
  for (const cut of settings.cameraCuts ?? []) {
    if (cut.time <= time && (!activeCut || cut.time > activeCut.time)) activeCut = cut;
  }
  return (activeCut && settings.cameras?.find((camera) => camera.id === activeCut.cameraId)) || settings.camera;
}
