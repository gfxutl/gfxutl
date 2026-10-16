import type { BackgroundObject, EditorSettings, FontFaceInfo, MediaAsset, ShaderGraphDocument, TimelineClip, TimelineMarker } from "../interface/types";
import type { RendererPluginInfo } from "../plugins/plugin-types";
import type { ExportSettings } from "../protocol/engine-protocol";
import { normalizeBackgroundSize } from "../interface/composition-size";
import { alignExportRangeToSequence, sequenceEnd } from "../interface/sequence-duration";

export const PROJECT_DOCUMENT_VERSION = 3 as const;

export type ProjectShaderGraph = Omit<ShaderGraphDocument, "handle">;

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
  shaderGraphs: ProjectShaderGraph[];
  fonts: FontFaceInfo[];
  plugins: RendererPluginInfo[];
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
  shaderGraphs?: ShaderGraphDocument[];
  fonts?: FontFaceInfo[];
  plugins?: RendererPluginInfo[];
  markers?: TimelineMarker[];
  loopPlayback?: boolean;
  settings: EditorSettings;
  exportSettings: ExportSettings;
}

export function createProjectDocument(source: ProjectDocumentSource): ProjectDocument {
  const fps = clampNumber(source.fps, 1, 240, 30);
  const duration = sequenceEnd(source.clips, fps, finite(source.duration, 32));
  return {
    application: "GfxUtl",
    version: PROJECT_DOCUMENT_VERSION,
    name: source.name.trim() || "Untitled Project",
    savedAt: new Date().toISOString(),
    fps,
    duration,
    background: structuredClone(normalizeBackgroundSize(source.background)),
    assets: source.assets.map(({ handle: _handle, ...asset }) => ({ ...asset })),
    clips: structuredClone(source.clips),
    shaderGraphs: (source.shaderGraphs ?? []).map(({ handle: _handle, ...graph }) => structuredClone(graph)),
    fonts: structuredClone(source.fonts ?? []),
    plugins: structuredClone(source.plugins ?? []),
    markers: structuredClone(source.markers ?? []),
    loopPlayback: source.loopPlayback === true,
    settings: structuredClone(source.settings),
    exportSettings: structuredClone(alignExportRangeToSequence(source.exportSettings, duration)),
  };
}

export function parseProjectDocument(text: string): ProjectDocument {
  const value = JSON.parse(text) as (Partial<ProjectDocument> & { version?: number }) | null;
  const version = value?.version as number | undefined;
  if (!value || value.application !== "GfxUtl" || (version !== 2 && version !== PROJECT_DOCUMENT_VERSION)) {
    throw new Error("対応していないGfxUtlプロジェクトです");
  }
  if (!Array.isArray(value.assets) || !Array.isArray(value.clips) || !value.background || !value.settings || !value.exportSettings) {
    throw new Error("プロジェクトデータが破損しています");
  }
  const fps = clampNumber(value.fps, 1, 240, 30);
  const duration = sequenceEnd(value.clips, fps, finite(value.duration, 32));
  return {
    application: "GfxUtl",
    version: PROJECT_DOCUMENT_VERSION,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "Untitled Project",
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date(0).toISOString(),
    fps,
    duration,
    background: structuredClone(normalizeBackgroundSize(value.background, value.exportSettings)),
    assets: value.assets.map((asset) => ({ ...asset, handle: undefined, fileStatus: "missing" as const })),
    clips: structuredClone(value.clips),
    shaderGraphs: Array.isArray(value.shaderGraphs) ? value.shaderGraphs.map((graph) => ({ ...structuredClone(graph), handle: undefined })) : [],
    fonts: Array.isArray(value.fonts) ? structuredClone(value.fonts) : [],
    plugins: Array.isArray(value.plugins) ? structuredClone(value.plugins) : [],
    markers: Array.isArray(value.markers) ? structuredClone(value.markers) : [],
    loopPlayback: value.loopPlayback === true,
    settings: { ...structuredClone(value.settings), autoKeyEnabled: value.settings.autoKeyEnabled === true },
    exportSettings: structuredClone(alignExportRangeToSequence(value.exportSettings, duration)),
  };
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return Math.max(minimum, Math.min(maximum, finite(value, fallback)));
}
