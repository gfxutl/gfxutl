import type { AudioProcessingSpec } from "../protocol/engine-protocol";

export const DEFAULT_AUDIO_PROCESSING: AudioProcessingSpec = {
  enabled: true,
  fadeIn: 0,
  fadeOut: 0,
  lowCutHz: 20,
  highCutHz: 20_000,
  lowShelfDb: 0,
  midPeakDb: 0,
  midFrequencyHz: 1_000,
  highShelfDb: 0,
  compressorThresholdDb: -24,
  compressorRatio: 1,
  compressorAttack: 0.003,
  compressorRelease: 0.25,
  reverbMix: 0,
  reverbDecay: 1.8,
  delayMix: 0,
  delayTime: 0.25,
  delayFeedback: 0.25,
};

export function resolveAudioProcessing(value?: Partial<AudioProcessingSpec>): AudioProcessingSpec {
  return { ...DEFAULT_AUDIO_PROCESSING, ...value };
}
