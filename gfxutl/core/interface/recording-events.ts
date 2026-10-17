export const OPEN_AUDIO_RECORDING_EVENT = "gfxutl:open-audio-recording";
export const SAVE_AUDIO_RECORDING_EVENT = "gfxutl:save-audio-recording";

export type SaveAudioRecordingDetail = {
  blob: Blob;
  suggestedName: string;
  resolve: (fileName: string) => void;
  reject: (error: Error) => void;
};

export function openAudioRecordingTab() {
  window.dispatchEvent(new CustomEvent(OPEN_AUDIO_RECORDING_EVENT));
}

export function saveAudioRecording(blob: Blob, suggestedName: string) {
  return new Promise<string>((resolve, reject) => {
    window.dispatchEvent(new CustomEvent<SaveAudioRecordingDetail>(SAVE_AUDIO_RECORDING_EVENT, {
      detail: { blob, suggestedName, resolve, reject },
    }));
  });
}
