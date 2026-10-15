import type { RendererPluginInfo } from "../plugins/plugin-types";

export type TrackKind = "video" | "audio" | "title" | "object" | "group";

export type ClipPropertyActionKind = "transform" | "sceneGraph" | "keyframes" | "crop" | "colorGrading" | "effects" | "postProcess" | "masks" | "audio" | "speed";

export interface ClipPropertyAction {
  id: string;
  kind: ClipPropertyActionKind;
}

import type { AudioProcessingSpec, ClipEffect, ClipKeyframe, ClipMask, ClipPostProcess, ColorGradingSpec, ExportSettings, GeometrySpec, SceneMaterialSpec, SceneSettings, SourceIoProfile } from "../protocol/engine-protocol";
export type { AudioProcessingSpec, BackgroundSettings, BlendMode, CameraHandleKind, CameraHandleTransform, CameraSettings, ClipEffect, ClipEffectKind, ClipKeyframe, ClipMask, ClipPostProcess, ColorGradingSpec, EngineRequest, EngineResponse, ExportSettings, GeometryKind, GeometrySpec, KeyframeProperty, LightKind, LightSpec, MaterialKind, ParticleSystemSpec, PreviewPickResult, PreviewView, RendererSettings, RendererStats, RenderClip, SceneKeyframe, SceneMaterialSpec, SceneObjectSpec, SceneSettings, SceneSettingsPatch, SourceIoProfile, TimelinePatch, TimelineSnapshot, ToneMappingKind, TransformHandleKind } from "../protocol/engine-protocol";

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
  sourceProfile?: SourceIoProfile;
  waveformPeaks?: number[];
  lastModified?: number;
  /** Path relative to the media explorer root. Used to reconnect tree entries. */
  sourcePath?: string;
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
  audioProcessing?: AudioProcessingSpec;
  ripple?: boolean;
  effects?: ClipEffect[];
  colorGrading?: ColorGradingSpec;
  postProcess?: ClipPostProcess;
  masks?: ClipMask[];
  keyframes?: ClipKeyframe[];
  geometry?: GeometrySpec;
  material?: SceneMaterialSpec;
  castShadow?: boolean;
  receiveShadow?: boolean;
  visible?: boolean;
  layer?: number;
  /** Explicit front-to-back order used by the composite preview. Higher values render in front. */
  stackOrder?: number;
  parentId?: string;
  instanceCount?: number;
  instanceSpacing?: number;
  primitive?: "mesh" | "points" | "line" | "sprite";
  particleSystem?: import("../protocol/engine-protocol").ParticleSystemSpec;
  text?: string;
  /** Legacy titles without this field are 3D text. */
  textMode?: "2d" | "3d";
  fontId?: string;
  fontFamily?: string;
  fontSize?: number;
  textDepth?: number;
  textColor?: number;
  textOutlineColor?: number;
  textOutlineWidth?: number;
  /** Timeline-only container height in pixels. */
  groupHeight?: number;
  /** Direct timeline container. This is separate from the Three.js scene parentId. */
  groupId?: string;
  /** Ordered, removable property operations applied on top of the base object. */
  propertyActions?: ClipPropertyAction[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  scope: "timeline" | "preview" | "clip" | "media" | "inspector";
  time: number;
  timelineY: number;
  positionX: number;
  positionY: number;
  /** Marker explicitly hit when opening a timeline context menu. */
  markerId?: string;
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

export interface MediaBufferStatus {
  usedBytes: number;
  maxBytes: number;
  entries: number;
  pending: number;
  instances: number;
}

export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  color: string;
}

export interface BackgroundObject {
  id: "background";
  name: string;
  color: number;
  width: number;
  height: number;
  scene: SceneSettings;
}

export interface EditorLayout {
  leftPanelWidth: number;
  rightPanelWidth: number;
  timelineHeight: number;
}

export interface EditorSettings {
  ramPreviewEnabled: boolean;
  ramPreviewMaxBytes: number;
  audioChannels: "stereo" | "mono";
}

export type EditorDialogState =
  | { kind: "new-project" }
  | { kind: "rename-marker"; markerId: string; value: string };

export interface EditorState {
  projectName: string;
  canUndo: boolean;
  canRedo: boolean;
  markers: TimelineMarker[];
  loopPlayback: boolean;
  fps: number;
  duration: number;
  currentTime: number;
  playing: boolean;
  zoom: number;
  timelineVerticalZoom: number;
  snapEnabled: boolean;
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedCameraKeyframeIds: string[];
  previewClipTabs: string[];
  activePreviewClipId: string | null;
  activePreviewView: "camera" | "inspector";
  selectedAssetId: string | null;
  backgroundSelected: boolean;
  background: BackgroundObject;
  assets: MediaAsset[];
  clips: TimelineClip[];
  fonts: FontFaceInfo[];
  plugins: RendererPluginInfo[];
  cache: CacheState;
  mediaBuffer: MediaBufferStatus;
  engine: "initializing" | "webgpu" | "webgl2" | "unsupported";
  cameraProjection: "orthographic" | "perspective";
  mediaBunnyReady: boolean;
  fileSystemAccess: boolean;
  localFontAccess: boolean;
  notice: string | null;
  dialog: EditorDialogState | null;
  layout: EditorLayout;
  settings: EditorSettings;
  leftPanelTab: "media" | "export" | "settings" | "plugins";
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
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
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
