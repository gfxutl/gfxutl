import type { BackgroundObject, EditorSettings, MediaAsset, TimelineClip, TimelineMarker } from "../interface/types";
import type { ExportSettings } from "../protocol/engine-protocol";
import { normalizeBackgroundSize } from "../interface/composition-size";
import { sequenceEnd } from "../interface/sequence-duration";

export const PROJECT_DOCUMENT_VERSION = 2 as const;

export interface ProjectDocument {
  application: "GfxUtl";
  version: typeof PROJECT_DOCUMENT_VERSION;
  name: string;
  savedAt: string;
  fps: number;
  duration: number;
  background: BackgroundObject;
  assets: Array<Omit<MediaAsset, "handle">>;
  clips: TimelineClip[];
  markers: TimelineMarker[];
  loopPlayback: boolean;
  settings: EditorSettings;
  exportSettings: ExportSettings;
}

export interface ProjectDocumentSource {
  name: string;
  fps: number;
  duration: number;
  background: BackgroundObject;
  assets: MediaAsset[];
  clips: TimelineClip[];
  markers?: TimelineMarker[];
  loopPlayback?: boolean;
  settings: EditorSettings;
  exportSettings: ExportSettings;
}

export function createProjectDocument(source: ProjectDocumentSource): ProjectDocument {
  const fps = clampNumber(source.fps, 1, 240, 30);
  return {
    application: "GfxUtl",
    version: PROJECT_DOCUMENT_VERSION,
    name: source.name.trim() || "Untitled Project",
    savedAt: new Date().toISOString(),
    fps,
    duration: sequenceEnd(source.clips, fps, finite(source.duration, 32)),
    background: structuredClone(normalizeBackgroundSize(source.background)),
    assets: source.assets.map(({ handle: _handle, ...asset }) => ({ ...asset })),
    clips: structuredClone(source.clips),
    markers: structuredClone(source.markers ?? []),
    loopPlayback: source.loopPlayback === true,
    settings: structuredClone(source.settings),
    exportSettings: structuredClone(source.exportSettings),
  };
}

export function parseProjectDocument(text: string): ProjectDocument {
  const value = JSON.parse(text) as Partial<ProjectDocument> | null;
  if (!value || value.application !== "GfxUtl" || value.version !== PROJECT_DOCUMENT_VERSION) {
    throw new Error("対応していないGfxUtlプロジェクトです");
  }
  if (!Array.isArray(value.assets) || !Array.isArray(value.clips) || !value.background || !value.settings || !value.exportSettings) {
    throw new Error("プロジェクトデータが破損しています");
  }
  const fps = clampNumber(value.fps, 1, 240, 30);
  return {
    application: "GfxUtl",
    version: PROJECT_DOCUMENT_VERSION,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "Untitled Project",
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date(0).toISOString(),
    fps,
    duration: sequenceEnd(value.clips, fps, finite(value.duration, 32)),
    background: structuredClone(normalizeBackgroundSize(value.background, value.exportSettings)),
    assets: value.assets.map((asset) => ({ ...asset, handle: undefined, fileStatus: "missing" as const })),
    clips: structuredClone(value.clips),
    markers: Array.isArray(value.markers) ? structuredClone(value.markers) : [],
    loopPlayback: value.loopPlayback === true,
    settings: structuredClone(value.settings),
    exportSettings: structuredClone(value.exportSettings),
  };
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return Math.max(minimum, Math.min(maximum, finite(value, fallback)));
}
