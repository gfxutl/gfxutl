import { del, get, set } from "idb-keyval";
import type { MediaAsset, TimelineClip } from "../interface/types";
import type { ProjectDocument } from "../project/project-document";

const INDEX_KEY = "gfxutl:file-handles:index:v1";
const RECORD_PREFIX = "gfxutl:file-handle:v1:";
const DIRECTORY_KEY = "gfxutl:media-directory:v1";

export interface HandleProjectRecord {
  version: 1 | 2;
  asset: Omit<MediaAsset, "handle">;
  handle: FileSystemFileHandle;
  clips: TimelineClip[];
  project?: Omit<ProjectDocument, "assets" | "clips">;
  savedAt: number;
}

export async function loadHandleProjects() {
  const ids = await get<string[]>(INDEX_KEY) ?? [];
  const records = await Promise.all(ids.map((id) => get<HandleProjectRecord>(`${RECORD_PREFIX}${id}`)));
  return records.filter((record): record is HandleProjectRecord => Boolean(record?.handle && record.asset));
}

export async function saveHandleProject(asset: MediaAsset, clips: TimelineClip[], project?: Omit<ProjectDocument, "assets" | "clips">) {
  if (!asset.handle) return;
  const { handle, ...serializableAsset } = asset;
  const record: HandleProjectRecord = {
    version: project ? 2 : 1,
    asset: serializableAsset,
    handle,
    // Every handle is an entry point to the same handle-backed project. Keeping
    // the complete timeline also preserves titles and generated objects, which
    // do not have an assetId of their own.
    clips,
    project,
    savedAt: Date.now(),
  };
  await set(`${RECORD_PREFIX}${asset.id}`, record);
  const ids = await get<string[]>(INDEX_KEY) ?? [];
  if (!ids.includes(asset.id)) await set(INDEX_KEY, [...ids, asset.id]);
}

export async function removeHandleProject(assetId: string) {
  await del(`${RECORD_PREFIX}${assetId}`);
  const ids = await get<string[]>(INDEX_KEY) ?? [];
  await set(INDEX_KEY, ids.filter((id) => id !== assetId));
}

export async function saveMediaDirectory(handle: FileSystemDirectoryHandle) {
  await set(DIRECTORY_KEY, handle);
}

export async function loadMediaDirectory() {
  return await get<FileSystemDirectoryHandle>(DIRECTORY_KEY);
}

export async function clearMediaDirectory() {
  await del(DIRECTORY_KEY);
}
