export const MIN_AUDIO_WAVEFORM_ZOOM = 1;
export const MAX_AUDIO_WAVEFORM_ZOOM = 64;

export function clampAudioWaveformZoom(zoom: number) {
  const finiteZoom = Number.isFinite(zoom) ? zoom : MIN_AUDIO_WAVEFORM_ZOOM;
  return Math.max(MIN_AUDIO_WAVEFORM_ZOOM, Math.min(MAX_AUDIO_WAVEFORM_ZOOM, finiteZoom));
}

export function audioWaveformTimeAtPointer(
  scrollLeft: number,
  pointerX: number,
  zoom: number,
  duration: number,
  viewportWidth: number,
) {
  const contentWidth = Math.max(1, viewportWidth * clampAudioWaveformZoom(zoom));
  const ratio = (Math.max(0, scrollLeft) + Math.max(0, pointerX)) / contentWidth;
  return Math.max(0, Math.min(Math.max(0, duration), ratio * Math.max(0, duration)));
}

export function audioWaveformScrollForAnchor(
  time: number,
  pointerX: number,
  zoom: number,
  duration: number,
  viewportWidth: number,
) {
  const safeWidth = Math.max(0, viewportWidth);
  const contentWidth = safeWidth * clampAudioWaveformZoom(zoom);
  const ratio = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0;
  const desired = ratio * contentWidth - Math.max(0, pointerX);
  return Math.max(0, Math.min(Math.max(0, contentWidth - safeWidth), desired));
}
