export type TrackKind = "video" | "audio" | "title" | "object";

import type { ClipEffect, ClipKeyframe, ExportSettings, GeometrySpec, SceneMaterialSpec, SceneSettings } from "../protocol/engine-protocol";
export type { BackgroundSettings, BlendMode, CameraSettings, ClipEffect, ClipEffectKind, ClipKeyframe, EngineRequest, EngineResponse, ExportSettings, GeometryKind, GeometrySpec, KeyframeProperty, LightKind, LightSpec, MaterialKind, ParticleSystemSpec, RendererSettings, RendererStats, RenderClip, SceneMaterialSpec, SceneObjectSpec, SceneSettings, TimelinePatch, ToneMappingKind } from "../protocol/engine-protocol";

export interface MediaAsset {
  id: string;
  name: string;
  kind: "video" | "audio" | "image" | "model";
  duration: number;
  size: number;
  width?: number;
  height?: number;
  codec?: string;
  hasAudio?: boolean;
  lastModified?: number;
  color: string;
  handle?: FileSystemFileHandle;
  fileStatus?: "ready" | "loading" | "permission-required" | "missing";
}

export interface TimelineClip {
  id: string;
  assetId?: string;
  name: string;
  start: number;
  y: number;
  duration: number;
  offset: number;
  color: string;
  kind: TrackKind;
  positionX?: number;
  positionY?: number;
  positionZ?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  rotationX?: number;
  rotationY?: number;
  opacity?: number;
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
  volume?: number;
  pan?: number;
  speed?: number;
  ripple?: boolean;
  effects?: ClipEffect[];
  keyframes?: ClipKeyframe[];
  geometry?: GeometrySpec;
  material?: SceneMaterialSpec;
  castShadow?: boolean;
  receiveShadow?: boolean;
  visible?: boolean;
  layer?: number;
  parentId?: string;
  instanceCount?: number;
  instanceSpacing?: number;
  primitive?: "mesh" | "points" | "line" | "sprite";
  particleSystem?: import("../protocol/engine-protocol").ParticleSystemSpec;
  text?: string;
  fontId?: string;
  fontFamily?: string;
  fontSize?: number;
  textDepth?: number;
  textColor?: number;
  textOutlineColor?: number;
  textOutlineWidth?: number;
}

export interface ContextMenuState {
  x: number;
  y: number;
  scope: "timeline" | "preview" | "clip";
  time: number;
  timelineY: number;
  positionX: number;
  positionY: number;
}

export interface FontFaceInfo {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
}

export interface CacheState {
  usedBytes: number;
  maxBytes: number;
  entries: number;
  codec: "H.264";
}

export interface BackgroundObject {
  id: "background";
  name: string;
  color: number;
  scene: SceneSettings;
}

export interface EditorLayout {
  leftPanelWidth: number;
  rightPanelWidth: number;
  timelineHeight: number;
}

export interface EditorState {
  fps: number;
  duration: number;
  currentTime: number;
  playing: boolean;
  zoom: number;
  snapEnabled: boolean;
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedAssetId: string | null;
  backgroundSelected: boolean;
  background: BackgroundObject;
  assets: MediaAsset[];
  clips: TimelineClip[];
  fonts: FontFaceInfo[];
  cache: CacheState;
  engine: "initializing" | "webgpu" | "webgl2" | "unsupported";
  cameraProjection: "orthographic" | "perspective";
  mediaBunnyReady: boolean;
  fileSystemAccess: boolean;
  localFontAccess: boolean;
  notice: string | null;
  layout: EditorLayout;
  leftPanelTab: "media" | "export";
  exportSettings: ExportSettings;
  exportStatus: "idle" | "exporting" | "done" | "error";
  exportProgress: number;
  videoFramesRendered: number;
  geometryObjectsReady: number;
  activeSceneObjects: number;
  activeImageObjects: number;
  playingAudioObjects: number;
  previewSource: "realtime" | "cache";
  cachedFramesDisplayed: number;
  previewFramesRendered: number;
  rendererStats: import("../protocol/engine-protocol").RendererStats;
  contextMenu: ContextMenuState | null;
}

declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
    queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<Array<{
      postscriptName: string;
      fullName: string;
      family: string;
      style: string;
      blob(): Promise<Blob>;
    }>>;
  }
}
