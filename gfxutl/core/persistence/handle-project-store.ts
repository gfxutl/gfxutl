import { del, get, set } from "idb-keyval";
import type { MediaAsset, TimelineClip } from "../interface/types";

const INDEX_KEY = "gfxutl:file-handles:index:v1";
const RECORD_PREFIX = "gfxutl:file-handle:v1:";

export interface HandleProjectRecord {
  version: 1;
  asset: Omit<MediaAsset, "handle">;
  handle: FileSystemFileHandle;
  clips: TimelineClip[];
  savedAt: number;
}

export async function loadHandleProjects() {
  const ids = await get<string[]>(INDEX_KEY) ?? [];
  const records = await Promise.all(ids.map((id) => get<HandleProjectRecord>(`${RECORD_PREFIX}${id}`)));
  return records.filter((record): record is HandleProjectRecord => Boolean(record?.handle && record.asset));
}

export async function saveHandleProject(asset: MediaAsset, clips: TimelineClip[]) {
  if (!asset.handle) return;
  const { handle, ...serializableAsset } = asset;
  const record: HandleProjectRecord = {
    version: 1,
    asset: serializableAsset,
    handle,
    // Every handle is an entry point to the same handle-backed project. Keeping
    // the complete timeline also preserves titles and generated objects, which
    // do not have an assetId of their own.
    clips,
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
