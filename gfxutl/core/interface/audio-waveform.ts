import type { TimelineClip } from "./types";

/** Increment whenever persisted waveform data needs to be regenerated. */
export const AUDIO_WAVEFORM_VERSION = 2;

const MIN_SOURCE_PEAKS = 256;
const MAX_SOURCE_PEAKS = 8_192;
const SOURCE_PEAKS_PER_SECOND = 50;

export function audioWaveformPeakCount(duration: number) {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return Math.max(MIN_SOURCE_PEAKS, Math.min(MAX_SOURCE_PEAKS, Math.ceil(safeDuration * SOURCE_PEAKS_PER_SECOND)));
}

export function accumulateAudioWaveformPeaks(
  peaks: number[],
  duration: number,
  data: ArrayLike<number>,
  numberOfFrames: number,
  numberOfChannels: number,
  sampleRate: number,
  timestamp: number,
) {
  if (!peaks.length || !(duration > 0) || !(sampleRate > 0) || numberOfFrames <= 0 || numberOfChannels <= 0) return;
  for (let frameIndex = 0; frameIndex < numberOfFrames; frameIndex++) {
    const frameTimestamp = timestamp + frameIndex / sampleRate;
    if (frameTimestamp < 0 || frameTimestamp > duration) continue;
    const peakIndex = Math.min(peaks.length - 1, Math.floor(frameTimestamp / duration * peaks.length));
    let framePeak = 0;
    const channelOffset = frameIndex * numberOfChannels;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const value = data[channelOffset + channel];
      framePeak = Math.max(framePeak, Number.isFinite(value) ? Math.abs(value) : 0);
    }
    peaks[peakIndex] = Math.max(peaks[peakIndex], framePeak);
  }
}

export function clipWaveformPeaks(
  peaks: readonly number[],
  assetDuration: number,
  clip: Pick<TimelineClip, "duration" | "offset" | "speed">,
  requestedCount: number,
) {
  if (!peaks.length || !(assetDuration > 0)) return [];
  const count = Math.max(1, Math.floor(requestedCount));
  const speed = Math.max(0.01, (clip.speed ?? 100) / 100);
  const sourceStart = clamp(clip.offset, 0, assetDuration);
  const sourceEnd = clamp(sourceStart + Math.max(0, clip.duration) * speed, sourceStart, assetDuration);
  if (sourceEnd <= sourceStart) return Array.from({ length: count }, () => 0);

  return Array.from({ length: count }, (_, outputIndex) => {
    const intervalStart = sourceStart + (sourceEnd - sourceStart) * outputIndex / count;
    const intervalEnd = sourceStart + (sourceEnd - sourceStart) * (outputIndex + 1) / count;
    const firstPeak = clamp(Math.floor(intervalStart / assetDuration * peaks.length), 0, peaks.length - 1);
    const finalPeak = clamp(Math.ceil(intervalEnd / assetDuration * peaks.length) - 1, firstPeak, peaks.length - 1);
    let peak = 0;
    for (let sourceIndex = firstPeak; sourceIndex <= finalPeak; sourceIndex++) {
      peak = Math.max(peak, Number.isFinite(peaks[sourceIndex]) ? Math.abs(peaks[sourceIndex]) : 0);
    }
    return peak;
  });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}
