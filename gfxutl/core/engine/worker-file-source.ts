import { CustomSource } from "mediabunny";
import type { MediaFileSource } from "../protocol/engine-protocol";

export interface WorkerFileProfile {
  bytesRead: number;
  readOperations: number;
  largestRead: number;
}

export interface WorkerFileSource {
  file: File;
  mediaSource: CustomSource;
  profile: WorkerFileProfile;
  readAll(): Uint8Array<ArrayBuffer>;
}

/**
 * Opens a user-selected file inside the renderer worker. FileReaderSync is
 * worker-only; slicing first guarantees that each call reads exactly the byte
 * range requested by MediaBunny without copying the complete file.
 */
export async function openWorkerFileSource(descriptor: MediaFileSource): Promise<WorkerFileSource> {
  const file = descriptor.handle ? await descriptor.handle.getFile() : descriptor.file;
  if (!file) throw new Error("メディアのファイルハンドルがありません");
  const reader = new FileReaderSync();
  const profile: WorkerFileProfile = { bytesRead: 0, readOperations: 0, largestRead: 0 };

  const readRange = (start: number, end: number): Uint8Array<ArrayBuffer> => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > file.size) {
      throw new RangeError(`不正なファイル読み取り範囲です: ${start}..${end} / ${file.size}`);
    }
    const expected = end - start;
    const buffer: ArrayBuffer = reader.readAsArrayBuffer(file.slice(start, end));
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== expected) {
      throw new Error(`ファイルを完全に読み取れませんでした: ${bytes.byteLength} / ${expected} bytes`);
    }
    profile.bytesRead += bytes.byteLength;
    profile.readOperations++;
    profile.largestRead = Math.max(profile.largestRead, bytes.byteLength);
    return bytes;
  };

  const mediaSource = new CustomSource({
    getSize: () => file.size,
    read: readRange,
    maxCacheSize: 2 * 1024 * 1024,
    prefetchProfile: "fileSystem",
  });

  return { file, mediaSource, profile, readAll: () => readRange(0, file.size) };
}
