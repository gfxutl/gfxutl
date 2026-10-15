import { get, set } from "idb-keyval";
import type { FontFaceInfo } from "../interface/types";

const FONT_CATALOG_KEY = "gfxutl:local-fonts:catalog:v1";
const FONT_DATA_PREFIX = "gfxutl:local-fonts:data:v1:";

export async function loadLocalFontCatalog() {
  return await get<FontFaceInfo[]>(FONT_CATALOG_KEY) ?? [];
}

export async function saveLocalFontCatalog(fonts: FontFaceInfo[]) {
  await set(FONT_CATALOG_KEY, fonts);
}

export async function loadLocalFontData(postscriptName: string) {
  return await get<Blob>(`${FONT_DATA_PREFIX}${postscriptName}`);
}

export async function saveLocalFontData(postscriptName: string, blob: Blob) {
  await set(`${FONT_DATA_PREFIX}${postscriptName}`, blob);
}
