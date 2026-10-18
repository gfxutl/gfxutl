import type { AudioProcessingSpec, CameraHandleKind, CameraSettings, ClipEffect, ClipEffectKind, ClipKeyframe, ClipMask, ClipPropertyActionKind, ContextMenuState, EditorLayout, EditorSettings, EditorState, EngineResponse, ExportSettings, FontFaceInfo, GeometryKind, KeyframeProperty, MediaAsset, RenderClip, SceneKeyframe, SceneObjectSpec, SceneSettings, TimelineClip } from "./types";
import { applicableClipActionKinds, resetPatchForClipAction, resolveClipPropertyActions, resolveColorGrading } from "./clip-actions";
import { EngineClient } from "./engine-client";
import { VirtualTimeline } from "./virtual-timeline";
import { assignTimelineGroups, expandGroupToValidBoundary, hasGroupBoundaryCrossing, MIN_GROUP_HEIGHT, placeTimelineClip, timelineGroupDescendants } from "./timeline-groups";
import { loadAutosaveProject, loadHandleProjects, loadPluginDirectory, removeHandleProject, removePluginDirectory, saveAutosaveProject, saveHandleProject, savePluginDirectory } from "../persistence/handle-project-store";
import { loadLocalFontCatalog, loadLocalFontData, saveLocalFontCatalog, saveLocalFontData } from "../persistence/local-font-store";
import { createProjectDocument, parseProjectDocument, type ProjectDocument } from "../project/project-document";
import { clampTimelineVerticalZoom, clampTimelineZoom } from "./timeline-zoom";
import { MediaReadPlanner } from "./media-read-graph";
import { resolveAudioProcessing } from "./audio-processing";
import { DEFAULT_COMPOSITION_SIZE, normalizeBackgroundSize, normalizeCompositionDimension } from "./composition-size";
import { alignExportRangeToSequence, DEFAULT_SEQUENCE_DURATION, sequenceEnd } from "./sequence-duration";
import { readRendererPluginPackage } from "../plugins/plugin-package";
import { bundleRendererPlugin } from "../plugins/plugin-bundler";
import { translateCurrent as t } from "../i18n";
import { clipTransitionGain } from "./sequencer-state";
import { convertLocalFontWithFacetype, facetypeCharacterSet, readFontVariationAxes } from "../fonts/facetype";
import { loadGoogleFontCatalog, loadGoogleFontData } from "../fonts/google-fonts";
import { fontVariationCss, fontVariationId, fontVariationKey, normalizeFontVariations, type FontVariationAxis, type FontVariationSettings } from "../fonts/font-variation";
import { AUDIO_WAVEFORM_VERSION } from "./audio-waveform";
import type { FontData } from "three/addons/loaders/FontLoader.js";

type Listener = () => void;

const MiB = 1024 * 1024;

const defaultLayout: EditorLayout = { leftPanelWidth: 286, rightPanelWidth: 294, timelineHeight: 309 };
const defaultSettings: EditorSettings = { ramPreviewEnabled: true, ramPreviewMaxBytes: 128 * MiB, audioChannels: "stereo", autoKeyEnabled: false };

const defaultSceneSettings: SceneSettings = {
  background: { color: 0xffffff, alpha: 1, fogEnabled: false, fogColor: 0xffffff, fogNear: 5, fogFar: 30, environmentIntensity: 1, environmentRotation: 0, backgroundBlurriness: 0 },
  camera: { id: "camera-1", name: "Camera 1", projection: "orthographic", position: [0, 0, 10], target: [0, 0, 0], near: 0.01, far: 1_000, fov: 50, zoom: 1, orthographicHeight: 9 },
  cameras: [{ id: "camera-1", name: "Camera 1", projection: "orthographic", position: [0, 0, 10], target: [0, 0, 0], near: 0.01, far: 1_000, fov: 50, zoom: 1, orthographicHeight: 9 }],
  cameraCuts: [],
  renderer: { previewScale: 0.75, toneMapping: "aces", exposure: 1, outputBuffer: "uint8", antialias: true, samples: 2, shadows: true, shadowType: "pcf", transparentBackground: false, postProcessing: false, fxaa: false, bloomStrength: 0, bloomRadius: 0.25, bloomThreshold: 0.8 },
  lights: [
    { id: "ambient", kind: "ambient", color: 0xffffff, intensity: 1.2, position: [0, 0, 0] },
    { id: "key", kind: "directional", color: 0xffffff, intensity: 2.5, position: [4, 6, 8], target: [0, 0, 0], castShadow: true },
  ],
};

function loadLayout(): EditorLayout {
  try {
    const stored = JSON.parse(localStorage.getItem("gfxutl:layout") ?? "null") as Partial<EditorLayout> | null;
    return stored ? { ...defaultLayout, ...stored } : defaultLayout;
  } catch {
    return defaultLayout;
  }
}

function loadSettings(): EditorSettings {
  try {
    const stored = JSON.parse(localStorage.getItem("gfxutl:settings") ?? "null") as Partial<EditorSettings> | null;
    if (!stored) return defaultSettings;
    const maxBytes = Math.max(32 * MiB, Math.min(2_048 * MiB, Number(stored.ramPreviewMaxBytes) || defaultSettings.ramPreviewMaxBytes));
    return {
      ramPreviewEnabled: stored.ramPreviewEnabled !== false,
      ramPreviewMaxBytes: maxBytes,
      audioChannels: stored.audioChannels === "mono" ? "mono" : "stereo",
      autoKeyEnabled: stored.autoKeyEnabled === true,
    };
  } catch {
    return defaultSettings;
  }
}

const loadedSettings = loadSettings();

function upsertPlugin(plugins: EditorState["plugins"], plugin: EditorState["plugins"][number]) {
  const index = plugins.findIndex((item) => item.id === plugin.id);
  if (index < 0) return [...plugins, plugin];
  return plugins.map((item, itemIndex) => itemIndex === index ? plugin : item);
}

const initialState: EditorState = {
  projectName: "Untitled Project",
  projectDirty: false,
  canUndo: false,
  canRedo: false,
  markers: [],
  loopPlayback: false,
  fps: 30,
  duration: DEFAULT_SEQUENCE_DURATION,
  currentTime: 0,
  playing: false,
  zoom: 1,
  timelineVerticalZoom: 1,
  snapEnabled: true,
  selectedClipId: null,
  selectedClipIds: [],
  selectedCameraKeyframeIds: [],
  previewClipTabs: [],
  activePreviewClipId: null,
  activePreviewView: "camera",
  selectedAssetId: null,
  backgroundSelected: true,
  background: { id: "background", name: t("背景オブジェクト"), color: 0xffffff, ...DEFAULT_COMPOSITION_SIZE, scene: structuredClone(defaultSceneSettings) },
  assets: [],
  clips: [],
  fonts: [],
  plugins: [],
  cache: { usedBytes: 0, maxBytes: loadedSettings.ramPreviewMaxBytes, entries: 0, codec: "H.264" },
  mediaBuffer: { usedBytes: 0, maxBytes: 128 * MiB, entries: 0, pending: 0, instances: 0 },
  engine: "initializing",
  cameraProjection: "orthographic",
  mediaBunnyReady: false,
  fileSystemAccess: "showDirectoryPicker" in window || "showOpenFilePicker" in window,
  localFontAccess: "queryLocalFonts" in window,
  notice: null,
  dialog: null,
  layout: loadLayout(),
  settings: loadedSettings,
  leftPanelTab: "media",
  exportSettings: { format: "mp4", videoCodec: "avc", audioCodec: "aac", width: 1920, height: 1080, fps: 30, bitrate: 8_000_000, audioBitrate: 192_000, filename: "Untitled Project", startTime: 0, endTime: 32 },
  exportStatus: "idle",
  exportProgress: 0,
  videoFramesRendered: 0,
  geometryObjectsReady: 0,
  activeSceneObjects: 0,
  activeImageObjects: 0,
  playingAudioObjects: 0,
  previewSource: "realtime",
  cachedFramesDisplayed: 0,
  previewFramesRendered: 0,
  rendererStats: { calls: 0, triangles: 0, lines: 0, points: 0, geometries: 0, textures: 0, frameMs: 0 },
  contextMenu: null,
};

type FontEntry = {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  source: "local" | "google";
  blob(): Promise<Blob>;
};

interface ClipboardPayload {
  type: "gfxutl/timeline-object";
  version: 2;
  clips: TimelineClip[];
}

interface PreviewAudioVoice {
  token: number;
  sources: Set<AudioBufferSourceNode>;
  input: GainNode;
  gain: GainNode;
  panner?: StereoPannerNode;
  highPass: BiquadFilterNode;
  lowPass: BiquadFilterNode;
  lowShelf: BiquadFilterNode;
  midPeak: BiquadFilterNode;
  highShelf: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  dry: GainNode;
  reverbWet: GainNode;
  delay: DelayNode;
  delayWet: GainNode;
  delayFeedback: GainNode;
  nodes: AudioNode[];
}

type HistorySnapshot = Pick<EditorState, "projectName" | "fps" | "duration" | "snapEnabled" | "background" | "assets" | "clips" | "markers" | "loopPlayback" | "settings" | "exportSettings">;

const HISTORY_KEYS = new Set<keyof EditorState>(["projectName", "fps", "duration", "snapEnabled", "background", "assets", "clips", "markers", "loopPlayback", "settings", "exportSettings"]);
const PERSISTED_KEYS = new Set<keyof EditorState>([...HISTORY_KEYS, "fonts", "plugins"]);

export class EditorController {
  private state = initialState;
  private listeners = new Set<Listener>();
  private engine: EngineClient;
  private virtualTimeline = new VirtualTimeline();
  private mediaReadPlanner = new MediaReadPlanner();
  private previewCanvases = new WeakSet<HTMLCanvasElement>();
  private frame = 0;
  private lastTick = 0;
  private playbackStartedAt = 0;
  private playbackStartTime = 0;
  private canvasReady = false;
  private lastPlaybackFrame = -1;
  private renderClipSource: readonly TimelineClip[] | null = null;
  private renderClipCache: RenderClip[] = [];
  private renderClipContextSignature = "";
  private mediaPlanClipSource: readonly TimelineClip[] | null = null;
  private mediaPlanAssetSource: readonly MediaAsset[] | null = null;
  private mediaPlanTimeBucket = -1;
  private previewMetricTimer = 0;
  private pendingPreviewFrames = 0;
  private pendingCachedFrames = 0;
  private pendingPreviewSource: "realtime" | "cache" = "realtime";
  private previewCacheDirty = false;
  private previewCacheTimer = 0;
  private persistenceTimer = 0;
  private fontEntries = new Map<string, FontEntry>();
  private fontCatalogRevision = 0;
  private googleFontCatalogLoad?: Promise<void>;
  private registeredFonts = new Set<string>();
  private fontPreviewLoads = new Map<string, Promise<string | undefined>>();
  private fontPreviewFaces = new Map<string, FontFace>();
  private facetypeFontLoads = new Map<string, Promise<FontData | undefined>>();
  private fontVariationAxisLoads = new Map<string, Promise<FontVariationAxis[]>>();
  private fontVariationUpdates = new Map<string, number>();
  private registeredFontVariations = new Map<string, string>();
  private memoryClipboard: ClipboardPayload | null = null;
  private audioContext: AudioContext | null = null;
  private audioVoices = new Map<string, PreviewAudioVoice>();
  private audioPreviewToken = 0;
  private activeAudioSignature = "";
  private explorerFiles = new Map<string, { file?: File; handle?: FileSystemFileHandle }>();
  private runtimeFiles = new Map<string, File>();
  private runtimeAssetLoads = new Map<string, Promise<void>>();
  private runtimeReadyAssetIds = new Set<string>();
  private persistedHandleSignatures = new Map<string, string>();
  private undoStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];
  private historySuspended = false;
  private lastHistorySignature = "";
  private lastHistoryAt = 0;
  private projectFileHandle?: FileSystemFileHandle;
  private pluginDirectories = new Map<string, FileSystemDirectoryHandle>();
  private cameraHandleDragQueue: Promise<void> = Promise.resolve();
  private cameraHandleDragGeneration = 0;
  private cameraHandleDragTime = 0;

  constructor(workerFactory: () => Worker) {
    this.engine = new EngineClient(workerFactory, (message) => this.onEngineMessage(message));
    this.engine.configurePreviewCache(this.state.settings.ramPreviewEnabled, this.state.settings.ramPreviewMaxBytes);
    void this.restoreLocalFonts();
    void this.restoreGoogleFonts().catch(() => { /* The font picker retries and reports remote catalog failures. */ });
    void this.restoreHandleProjects();
  }

  getSnapshot = () => this.state;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<EditorState>) {
    if (patch.clips) {
      const duration = sequenceEnd(patch.clips, patch.fps ?? this.state.fps, patch.duration ?? this.state.duration);
      patch.duration = duration;
      const currentTime = patch.currentTime ?? this.state.currentTime;
      if (currentTime > duration) patch.currentTime = duration;
    }
    if (patch.duration !== undefined) {
      patch.exportSettings = alignExportRangeToSequence(patch.exportSettings ?? this.state.exportSettings, patch.duration);
    }
    this.recordHistory(patch);
    if (patch.projectDirty === undefined && Object.keys(patch).some((key) => PERSISTED_KEYS.has(key as keyof EditorState))) patch.projectDirty = true;
    const nextState = { ...this.state, ...patch };
    if (!nextState.selectedClipId && nextState.selectedClipIds.length === 0 && !nextState.selectedAssetId && nextState.selectedCameraKeyframeIds.length === 0) {
      nextState.backgroundSelected = true;
    }
    this.state = nextState;
    this.listeners.forEach((listener) => listener());
  }

  private updateRuntime(patch: Partial<EditorState>) {
    const historySuspended = this.historySuspended;
    this.historySuspended = true;
    this.update({ ...patch, projectDirty: this.state.projectDirty });
    this.historySuspended = historySuspended;
  }

  private historySnapshot(state = this.state): HistorySnapshot {
    return {
      projectName: state.projectName,
      fps: state.fps,
      duration: state.duration,
      snapEnabled: state.snapEnabled,
      background: structuredClone(state.background),
      assets: state.assets.map((asset) => ({ ...asset })),
      clips: structuredClone(state.clips),
      markers: structuredClone(state.markers),
      loopPlayback: state.loopPlayback,
      settings: structuredClone(state.settings),
      exportSettings: structuredClone(state.exportSettings),
    };
  }

  private recordHistory(patch: Partial<EditorState>) {
    if (this.historySuspended) return;
    const keys = Object.keys(patch).filter((key) => HISTORY_KEYS.has(key as keyof EditorState)).sort();
    if (!keys.length) return;
    const signature = keys.join("|");
    const now = performance.now();
    if (signature !== this.lastHistorySignature || now - this.lastHistoryAt > 350) {
      this.undoStack.push(this.historySnapshot());
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.lastHistorySignature = signature;
    this.lastHistoryAt = now;
    patch.canUndo = true;
    patch.canRedo = false;
  }

  private restoreHistory(snapshot: HistorySnapshot, canUndo: boolean, canRedo: boolean) {
    const duration = sequenceEnd(snapshot.clips, snapshot.fps, snapshot.duration);
    const exportSettings = alignExportRangeToSequence(snapshot.exportSettings, duration);
    const selectedClipIds = this.state.selectedClipIds.filter((id) => snapshot.clips.some((clip) => clip.id === id));
    const selectedClipId = snapshot.clips.some((clip) => clip.id === this.state.selectedClipId) ? this.state.selectedClipId : selectedClipIds.at(-1) ?? null;
    const selectionWasClip = this.state.selectedClipId !== null || this.state.selectedClipIds.length > 0;
    const selectedAssetId = selectionWasClip ? snapshot.clips.find((clip) => clip.id === selectedClipId)?.assetId ?? null : this.state.selectedAssetId;
    const sceneKeyframeIds = new Set(snapshot.background.scene.keyframes?.map((keyframe) => keyframe.id) ?? []);
    const selectedCameraKeyframeIds = this.state.selectedCameraKeyframeIds.filter((id) => sceneKeyframeIds.has(id));
    this.historySuspended = true;
    this.state = {
      ...this.state,
      ...snapshot,
      duration,
      exportSettings,
      currentTime: Math.min(this.state.currentTime, duration),
      canUndo,
      canRedo,
      selectedClipId,
      selectedClipIds,
      selectedCameraKeyframeIds,
      selectedAssetId,
      backgroundSelected: !selectedClipId && selectedClipIds.length === 0 && !selectedAssetId && selectedCameraKeyframeIds.length === 0 ? true : this.state.backgroundSelected,
    };
    this.historySuspended = false;
    this.renderClipSource = null;
    this.engine.clearCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
    this.listeners.forEach((listener) => listener());
  }

  undo = () => {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.redoStack.push(this.historySnapshot());
    this.restoreHistory(snapshot, this.undoStack.length > 0, true);
    this.lastHistorySignature = "";
  };

  redo = () => {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this.historySnapshot());
    this.restoreHistory(snapshot, true, this.redoStack.length > 0);
    this.lastHistorySignature = "";
  };

  private invalidatePreviewCache() {
    this.previewCacheDirty = true;
    window.clearTimeout(this.previewCacheTimer);
    this.previewCacheTimer = window.setTimeout(() => {
      this.previewCacheDirty = false;
      if (!this.state.playing) this.renderPreview(true);
    }, 180);
  }

  private schedulePersistence() {
    window.clearTimeout(this.persistenceTimer);
    this.persistenceTimer = window.setTimeout(() => {
      const document = this.currentProjectDocument();
      const { assets: _assets, clips: _clips, ...project } = document;
      void saveAutosaveProject(document).catch(() => { /* Autosave may be unavailable in private browsing. */ });
      for (const asset of this.state.assets) {
        if (!asset.handle) continue;
        const signature = handleAssetSignature(asset);
        if (this.persistedHandleSignatures.get(asset.id) === signature) continue;
        void saveHandleProject(asset, this.state.clips, project).then(() => {
          if (this.state.assets.some((item) => item.id === asset.id && handleAssetSignature(item) === signature)) this.persistedHandleSignatures.set(asset.id, signature);
        }).catch(() => { /* Editing remains available if handle persistence is blocked. */ });
      }
    }, 200);
  }

  private currentProjectDocument(): ProjectDocument {
    return createProjectDocument({
      name: this.state.projectName,
      fps: this.state.fps,
      duration: this.state.duration,
      background: this.state.background,
      assets: this.state.assets,
      clips: this.state.clips,
      markers: this.state.markers,
      loopPlayback: this.state.loopPlayback,
      settings: this.state.settings,
      exportSettings: this.state.exportSettings,
      fonts: this.state.fonts,
      plugins: this.state.plugins,
    });
  }

  private async restoreHandleProjects() {
    try {
      const [records, autosave] = await Promise.all([loadHandleProjects(), loadAutosaveProject()]);
      if (!records.length && !autosave) return;
      const handles = new Map(records.map((record) => [record.asset.id, record]));
      for (const record of records) if (record.version === 3) this.persistedHandleSignatures.set(record.asset.id, handleAssetSignature(record.asset));
      const assets = autosave
        ? autosave.assets.map((asset) => {
          const record = handles.get(asset.id);
          return record ? { ...asset, handle: record.handle, fileStatus: "loading" as const } : { ...asset, fileStatus: "missing" as const };
        })
        : records.map((record) => ({ ...record.asset, handle: record.handle, fileStatus: "loading" as const }));
      const clips = autosave?.clips ?? [...new Map(records.flatMap((record) => record.clips ?? []).map((clip) => [clip.id, clip])).values()];
      const project = autosave ?? [...records].sort((a, b) => b.savedAt - a.savedAt).find((record) => record.project)?.project;
      this.hydrateGoogleFontEntries(project?.fonts ?? []);
      this.historySuspended = true;
      this.update({
        assets,
        clips,
        duration: project?.duration ?? this.state.duration,
        markers: project?.markers ?? [],
        loopPlayback: project?.loopPlayback ?? false,
        projectName: project?.name ?? this.state.projectName,
        fps: project?.fps ?? this.state.fps,
        background: project?.background ? normalizeBackgroundSize(project.background, project.exportSettings) : this.state.background,
        settings: project?.settings ?? this.state.settings,
        exportSettings: project?.exportSettings ?? this.state.exportSettings,
        fonts: combineFontCatalog(project?.fonts ?? [], this.state.fonts),
        plugins: (project?.plugins ?? []).map((plugin) => ({ ...plugin, status: "error" as const, error: t("再利用するにはプラグインのディレクトリを選択してください") })),
        projectDirty: false,
      });
      this.historySuspended = false;
      // Cached project metadata is sufficient for the first UI and background
      // frame. File handles, decoders, fonts and plugins hydrate afterwards.
      this.renderPreview(true);
      void this.registerTimelineFonts();
      const prioritizedAssets = [...assets].sort((left, right) => this.assetRestorePriority(left.id) - this.assetRestorePriority(right.id));
      void runWithConcurrency(prioritizedAssets, 3, (asset) => this.restoreAssetFile(asset.id, false)).then(() => {
        this.updateRuntime({ projectDirty: false });
        this.renderPreview(true);
        // Rewrites legacy per-handle v1/v2 records into the normalized v3
        // shape after the non-blocking restoration pass has completed.
        this.schedulePersistence();
      });
      void Promise.allSettled((project?.plugins ?? []).map(async (plugin) => {
        const directory = await loadPluginDirectory(plugin.id);
        if (!directory || await queryDirectoryReadPermission(directory) !== "granted") return;
        this.pluginDirectories.set(plugin.id, directory);
        await this.reloadRendererPlugin(plugin.id);
      })).then(() => this.updateRuntime({ projectDirty: false }));
    } catch {
      // IndexedDB or a persisted handle may be unavailable in private browsing.
    } finally {
      this.historySuspended = false;
    }
  }

  private assetRestorePriority(assetId: string) {
    const clip = this.state.clips.find((item) => item.assetId === assetId
      && item.start <= this.state.currentTime + 5
      && item.start + item.duration >= this.state.currentTime - 1);
    return clip ? Math.max(0, clip.start - this.state.currentTime) : Number.MAX_SAFE_INTEGER;
  }

  saveProject = async () => {
    try {
      const project = this.currentProjectDocument();
      const filename = `${project.name.replace(/[\\/:*?"<>|]/g, "-") || "Untitled Project"}.gfxutl`;
      if (!this.projectFileHandle && window.showSaveFilePicker) {
        this.projectFileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "GfxUtl Project", accept: { "application/json": [".gfxutl"] } }],
        });
      }
      const json = JSON.stringify(project, null, 2);
      if (this.projectFileHandle) {
        const writable = await this.projectFileHandle.createWritable();
        await writable.write(json);
        await writable.close();
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      this.schedulePersistence();
      this.update({ projectDirty: false });
      this.toast(t("{name} を保存しました", { name: filename }));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? t("保存失敗: {message}", { message: error.message }) : t("プロジェクトを保存できませんでした"));
    }
  };

  saveProjectAs = async () => {
    this.projectFileHandle = undefined;
    await this.saveProject();
  };

  openProject = async () => {
    try {
      let file: File;
      if (window.showOpenFilePicker) {
        const handles = await window.showOpenFilePicker({ multiple: false, types: [{ description: "GfxUtl Project", accept: { "application/json": [".gfxutl"] } }] });
        this.projectFileHandle = handles[0];
        file = await handles[0].getFile();
      } else file = await this.openWithInput(".gfxutl,application/json");
      const project = parseProjectDocument(await file.text());
      this.hydrateGoogleFontEntries(project.fonts);
      const assets = project.assets.map((asset) => {
        const connected = this.state.assets.find((item) => item.sourcePath && item.sourcePath === asset.sourcePath)
          ?? this.state.assets.find((item) => item.name === asset.name && item.size === asset.size);
        return connected ? { ...asset, handle: connected.handle, fileStatus: connected.fileStatus } : { ...asset, fileStatus: "missing" as const };
      });
      this.update({
        projectName: project.name,
        fps: project.fps,
        duration: project.duration,
        background: normalizeBackgroundSize(project.background),
        assets,
        clips: project.clips,
        markers: project.markers,
        loopPlayback: project.loopPlayback,
        settings: project.settings,
        exportSettings: project.exportSettings,
        fonts: combineFontCatalog(project.fonts, this.state.fonts),
        plugins: project.plugins.map((plugin) => ({ ...plugin, status: "error" as const, error: t("再利用するにはプラグインのディレクトリを選択してください") })),
        selectedClipId: null,
        selectedClipIds: [],
        selectedCameraKeyframeIds: [],
        previewClipTabs: [],
        activePreviewClipId: null,
        activePreviewView: "camera",
        selectedAssetId: null,
        backgroundSelected: true,
        projectDirty: false,
      });
      this.renderClipSource = null;
      this.engine.configurePreviewCache(project.settings.ramPreviewEnabled, project.settings.ramPreviewMaxBytes);
      this.engine.clearCache();
      this.renderPreview(true);
      void this.registerTimelineFonts();
      this.schedulePersistence();
      this.toast(t("{name} を開きました", { name: project.name }));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? error.message : t("プロジェクトを開けませんでした"));
    }
  };

  newProject = () => {
    if (this.state.projectDirty) {
      this.update({ dialog: { kind: "new-project" } });
      return;
    }
    this.createNewProject();
  };

  private createNewProject() {
    this.projectFileHandle = undefined;
    this.update({
      projectName: "Untitled Project",
      fps: 30,
      duration: DEFAULT_SEQUENCE_DURATION,
      currentTime: 0,
      playing: false,
      background: { id: "background", name: t("背景オブジェクト"), color: 0xffffff, ...DEFAULT_COMPOSITION_SIZE, scene: structuredClone(defaultSceneSettings) },
      assets: [],
      clips: [],
      markers: [],
      loopPlayback: false,
      selectedClipId: null,
      selectedClipIds: [],
      selectedCameraKeyframeIds: [],
      previewClipTabs: [],
      activePreviewClipId: null,
      activePreviewView: "camera",
      selectedAssetId: null,
      backgroundSelected: true,
      exportSettings: { ...initialState.exportSettings },
      plugins: [],
      projectDirty: false,
    });
    this.stopAudioPreview();
    this.engine.clearCache();
    this.renderClipSource = null;
    this.renderPreview(true);
    this.schedulePersistence();
  }

  openMarkerRenameDialog = (markerId: string) => {
    const marker = this.state.markers.find((item) => item.id === markerId);
    if (marker) this.update({ dialog: { kind: "rename-marker", markerId, value: marker.label } });
  };

  updateDialogValue = (value: string) => {
    const dialog = this.state.dialog;
    if (dialog?.kind === "rename-marker") this.update({ dialog: { ...dialog, value } });
  };

  dismissDialog = () => this.update({ dialog: null });

  confirmDialog = () => {
    const dialog = this.state.dialog;
    if (!dialog) return;
    this.update({ dialog: null });
    if (dialog.kind === "new-project") {
      this.createNewProject();
      return;
    }
    const label = dialog.value.trim();
    if (label) this.updateMarker(dialog.markerId, { label });
  };

  private async restoreAssetFile(assetId: string, requestPermission: boolean) {
    const asset = this.state.assets.find((item) => item.id === assetId);
    if (!asset?.handle) return false;
    try {
      let permission = await queryReadPermission(asset.handle);
      if (permission !== "granted" && requestPermission) permission = await requestReadPermission(asset.handle);
      if (permission !== "granted") {
        this.updateRuntime({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, fileStatus: "permission-required" } : item) });
        return false;
      }
      const file = await asset.handle.getFile();
      this.registerAvailableFile(asset.id, file);
      const changed = asset.size !== file.size || asset.lastModified !== file.lastModified;
      const info: Partial<MediaAsset> = { size: file.size, lastModified: file.lastModified };
      if (changed) Object.assign(info, await this.registerRuntimeFile(asset, file), { waveformPeaks: undefined, waveformVersion: undefined });
      this.updateRuntime({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, ...info, fileStatus: "ready" } : item) });
      if (this.assetRestorePriority(assetId) !== Number.MAX_SAFE_INTEGER) this.renderPreview(true);
      return true;
    } catch {
      this.updateRuntime({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, fileStatus: "missing" } : item) });
      return false;
    }
  }

  restoreMediaAccess = async (assetId?: string) => {
    const targets = this.state.assets.filter((asset) => asset.handle && (!assetId || asset.id === assetId) && asset.fileStatus !== "ready");
    if (!targets.length) return;
    this.update({ assets: this.state.assets.map((asset) => targets.some((target) => target.id === asset.id) ? { ...asset, fileStatus: "loading" } : asset) });
    const results = await Promise.all(targets.map((asset) => this.restoreAssetFile(asset.id, true)));
    const restored = results.filter(Boolean).length;
    this.toast(restored ? t("{count} 件のメディアを再接続しました", { count: restored }) : t("ファイルへのアクセス許可が必要です"));
    this.renderPreview(true);
  };

  relinkAsset = async (assetId: string) => {
    const asset = this.state.assets.find((item) => item.id === assetId);
    if (!asset) return;
    try {
      let file: File;
      let handle: FileSystemFileHandle | undefined;
      if (window.showOpenFilePicker) {
        [handle] = await window.showOpenFilePicker({ multiple: false });
        file = await handle.getFile();
      } else file = await this.openWithInput("video/*,audio/*,image/*,.hdr,.exr,.glb");
      if (mediaKindForFile(file) !== asset.kind) throw new Error(t("同じ種類の素材を選択してください"));
      const pending: MediaAsset = { ...asset, handle, size: file.size, lastModified: file.lastModified, fileStatus: "loading" };
      this.update({ assets: this.state.assets.map((item) => item.id === assetId ? pending : item) });
      const info = await this.registerRuntimeFile(pending, file);
      const retainWaveform = asset.kind === "audio" && asset.size === file.size && asset.lastModified === file.lastModified && asset.waveformVersion === AUDIO_WAVEFORM_VERSION;
      const ready: MediaAsset = { ...pending, ...info, waveformPeaks: retainWaveform ? asset.waveformPeaks : undefined, waveformVersion: retainWaveform ? asset.waveformVersion : undefined, fileStatus: "ready" };
      this.update({ assets: this.state.assets.map((item) => item.id === assetId ? ready : item) });
      if (handle) {
        const { assets: _assets, clips: _clips, ...project } = this.currentProjectDocument();
        await saveHandleProject(ready, this.state.clips, project).catch(() => undefined);
      }
      this.renderPreview(true);
      this.schedulePersistence();
      this.toast(t("{name} を再接続しました", { name: asset.name }));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? error.message : t("素材を再接続できませんでした"));
    }
  };

  private async registerRuntimeFile(asset: MediaAsset, file: File) {
    this.registerAvailableFile(asset.id, file);
    this.runtimeReadyAssetIds.delete(asset.id);
    const info = asset.kind === "image"
      ? await this.engine.inspectImage(file, asset.id, asset.handle)
      : asset.kind === "model"
        ? await this.engine.inspectModel(file, asset.id, asset.handle)
        : await this.engine.inspectMedia(file, asset.id, asset.handle);
    this.runtimeReadyAssetIds.add(asset.id);
    return info;
  }

  private registerAvailableFile(assetId: string, file: File) {
    this.runtimeFiles.set(assetId, file);
    const kind = this.state.assets.find((asset) => asset.id === assetId)?.kind;
    if (kind) this.engine.registerMediaFile(assetId, file, kind);
  }

  private ensureAssetRuntime(assetId: string) {
    if (this.runtimeReadyAssetIds.has(assetId)) return Promise.resolve();
    const pending = this.runtimeAssetLoads.get(assetId);
    if (pending) return pending;
    const request = (async () => {
      const asset = this.state.assets.find((item) => item.id === assetId);
      if (!asset) throw new Error("Media asset is unavailable");
      const file = this.runtimeFiles.get(assetId) ?? await asset.handle?.getFile();
      if (!file) throw new Error("Media file access is unavailable");
      const info = await this.registerRuntimeFile(asset, file);
      this.updateRuntime({
        assets: this.state.assets.map((item) => item.id === assetId
          ? { ...item, ...info, size: file.size, lastModified: file.lastModified, fileStatus: "ready" }
          : item),
      });
    })().finally(() => this.runtimeAssetLoads.delete(assetId));
    this.runtimeAssetLoads.set(assetId, request);
    return request;
  }

  private stopAudioPreview() {
    this.audioPreviewToken++;
    this.activeAudioSignature = "";
    for (const voice of this.audioVoices.values()) {
      for (const source of voice.sources) { try { source.stop(); } catch { /* Already stopped. */ } }
      voice.sources.clear();
      for (const node of voice.nodes) node.disconnect();
    }
    this.audioVoices.clear();
    if (this.state.playingAudioObjects !== 0) this.update({ playingAudioObjects: 0 });
  }

  private syncAudioPlayback(shouldPlay = this.state.playing, force = false) {
    if (!shouldPlay) {
      this.stopAudioPreview();
      return;
    }
    const audioSolo = this.state.clips.some((clip) => clip.solo && clipHasAudio(clip, this.state.assets));
    const active = this.state.clips.filter((clip) => {
      if (clip.muted || (audioSolo && !clip.solo)) return false;
      if (!clip.assetId || this.state.currentTime < clip.start || this.state.currentTime >= clip.start + clip.duration) return false;
      const asset = this.state.assets.find((item) => item.id === clip.assetId);
      return asset?.kind === "audio" || asset?.hasAudio === true;
    });
    const signature = active.map((clip) => `${clip.id}:${clip.start}:${clip.duration}:${clip.offset}:${clip.speed ?? 100}`).join("|");
    if (force || signature !== this.activeAudioSignature) {
      this.stopAudioPreview();
      this.activeAudioSignature = signature;
      const token = this.audioPreviewToken;
      for (const clip of active) void this.scheduleAudioPreview(clip, token);
    } else {
      for (const clip of active) this.applyAudioMix(clip, this.audioVoices.get(clip.id));
    }
    if (this.state.playingAudioObjects !== active.length) this.update({ playingAudioObjects: active.length });
  }

  private applyAudioMix(clip: TimelineClip, voice?: PreviewAudioVoice) {
    if (!voice || voice.token !== this.audioPreviewToken) return;
    const volume = evaluateClipNumber(clip, "volume", this.state.currentTime, clip.volume ?? 0);
    const pan = evaluateClipNumber(clip, "pan", this.state.currentTime, clip.pan ?? 0);
    const speed = Math.max(0.25, Math.min(4, evaluateClipNumber(clip, "speed", this.state.currentTime, clip.speed ?? 100) / 100));
    const processing = resolveAudioProcessing(clip.audioProcessing);
    const enabled = processing.enabled;
    const localTime = Math.max(0, this.state.currentTime - clip.start);
    const remaining = Math.max(0, clip.duration - localTime);
    const fadeIn = enabled && processing.fadeIn > 0 ? Math.min(1, localTime / processing.fadeIn) : 1;
    const fadeOut = enabled && processing.fadeOut > 0 ? Math.min(1, remaining / processing.fadeOut) : 1;
    const transition = clipTransitionGain(clip, localTime);
    voice.gain.gain.value = clip.muted || volume <= -60 ? 0 : Math.max(0, Math.min(4, 10 ** (volume / 20) * fadeIn * fadeOut * transition));
    if (voice.panner) voice.panner.pan.value = Math.max(-1, Math.min(1, pan / 100));
    voice.highPass.frequency.value = enabled ? Math.max(10, processing.lowCutHz) : 10;
    voice.lowPass.frequency.value = enabled ? Math.max(20, processing.highCutHz) : 22_000;
    voice.lowShelf.gain.value = enabled ? processing.lowShelfDb : 0;
    voice.midPeak.frequency.value = Math.max(40, processing.midFrequencyHz);
    voice.midPeak.gain.value = enabled ? processing.midPeakDb : 0;
    voice.highShelf.gain.value = enabled ? processing.highShelfDb : 0;
    voice.compressor.threshold.value = enabled ? processing.compressorThresholdDb : 0;
    voice.compressor.ratio.value = enabled ? Math.max(1, processing.compressorRatio) : 1;
    voice.compressor.attack.value = Math.max(0, processing.compressorAttack);
    voice.compressor.release.value = Math.max(0.01, processing.compressorRelease);
    const reverbMix = enabled ? Math.max(0, Math.min(1, processing.reverbMix / 100)) : 0;
    const delayMix = enabled ? Math.max(0, Math.min(1, processing.delayMix / 100)) : 0;
    voice.dry.gain.value = 1 - Math.max(reverbMix, delayMix) * 0.35;
    voice.reverbWet.gain.value = reverbMix;
    voice.delayWet.gain.value = delayMix;
    voice.delay.delayTime.value = Math.max(0, Math.min(2, processing.delayTime));
    voice.delayFeedback.gain.value = Math.max(0, Math.min(0.92, processing.delayFeedback));
    for (const source of voice.sources) source.playbackRate.value = speed;
  }

  private createReverbImpulse(context: AudioContext, decay: number) {
    const seconds = Math.max(0.1, Math.min(8, decay));
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const data = impulse.getChannelData(channel);
      let noise = 0x9e3779b9 ^ channel;
      for (let index = 0; index < length; index++) {
        noise = Math.imul(noise ^ noise >>> 16, 0x21f0aaad);
        noise = Math.imul(noise ^ noise >>> 15, 0x735a2d97);
        noise ^= noise >>> 15;
        data[index] = ((noise >>> 0) / 0x80000000 - 1) * (1 - index / length) ** 2.4;
      }
    }
    return impulse;
  }

  private async scheduleAudioPreview(clip: TimelineClip, token: number) {
    if (!clip.assetId) return;
    const context = this.audioContext ??= new AudioContext({ latencyHint: "interactive" });
    await context.resume();
    if (token !== this.audioPreviewToken || !this.state.playing) return;
    const speed = Math.max(0.25, Math.min(4, evaluateClipNumber(clip, "speed", this.state.currentTime, clip.speed ?? 100) / 100));
    const mediaStart = Math.max(0, clip.offset + (this.state.currentTime - clip.start) * speed);
    const mediaEnd = mediaStart + Math.max(0, clip.start + clip.duration - this.state.currentTime) * speed;
    const contextStart = context.currentTime + 0.04;
    const processing = resolveAudioProcessing(clip.audioProcessing);
    const input = context.createGain();
    const highPass = context.createBiquadFilter(); highPass.type = "highpass";
    const lowPass = context.createBiquadFilter(); lowPass.type = "lowpass";
    const lowShelf = context.createBiquadFilter(); lowShelf.type = "lowshelf"; lowShelf.frequency.value = 180;
    const midPeak = context.createBiquadFilter(); midPeak.type = "peaking"; midPeak.Q.value = 0.8;
    const highShelf = context.createBiquadFilter(); highShelf.type = "highshelf"; highShelf.frequency.value = 4_500;
    const compressor = context.createDynamicsCompressor();
    compressor.knee.value = 0;
    const dry = context.createGain();
    const convolver = context.createConvolver(); convolver.buffer = this.createReverbImpulse(context, processing.reverbDecay);
    const reverbWet = context.createGain();
    const delay = context.createDelay(2); const delayWet = context.createGain(); const delayFeedback = context.createGain();
    const gain = context.createGain();
    const panner = this.state.settings.audioChannels === "stereo" ? context.createStereoPanner() : undefined;
    input.connect(highPass).connect(lowPass).connect(lowShelf).connect(midPeak).connect(highShelf).connect(compressor);
    compressor.connect(dry).connect(gain);
    compressor.connect(convolver).connect(reverbWet).connect(gain);
    compressor.connect(delay).connect(delayWet).connect(gain);
    delay.connect(delayFeedback).connect(delay);
    if (panner) gain.connect(panner).connect(context.destination);
    else gain.connect(context.destination);
    const nodes: AudioNode[] = [input, highPass, lowPass, lowShelf, midPeak, highShelf, compressor, dry, convolver, reverbWet, delay, delayWet, delayFeedback, gain, ...(panner ? [panner] : [])];
    const voice: PreviewAudioVoice = { token, sources: new Set(), input, gain, panner, highPass, lowPass, lowShelf, midPeak, highShelf, compressor, dry, reverbWet, delay, delayWet, delayFeedback, nodes };
    this.audioVoices.set(clip.id, voice);
    this.applyAudioMix(clip, voice);
    try {
      const windowDuration = 0.75 * speed;
      for (let windowStart = mediaStart; windowStart < mediaEnd && token === this.audioPreviewToken && this.state.playing; windowStart += windowDuration) {
        const chunks = await this.engine.decodeAudioPreview(clip.assetId, windowStart, Math.min(mediaEnd, windowStart + windowDuration));
        for (const sample of chunks) {
          if (token !== this.audioPreviewToken || !this.state.playing || sample.channels.length === 0) break;
          const sourceOffset = Math.max(0, mediaStart - sample.timestamp);
          if (sourceOffset >= sample.duration) continue;
          const when = contextStart + Math.max(0, (sample.timestamp - mediaStart) / speed);
          while (when > context.currentTime + 1 && token === this.audioPreviewToken && this.state.playing) {
            await new Promise((resolve) => window.setTimeout(resolve, 80));
          }
          if (token !== this.audioPreviewToken || !this.state.playing) break;
          const frameCount = sample.channels[0].byteLength / Float32Array.BYTES_PER_ELEMENT;
          const mono = this.state.settings.audioChannels === "mono";
          const outputChannels = mono ? 1 : Math.min(2, sample.channels.length);
          const buffer = context.createBuffer(outputChannels, frameCount, sample.sampleRate);
          if (mono) {
            const mixed = new Float32Array(frameCount);
            for (const channel of sample.channels) {
              const values = new Float32Array(channel);
              for (let frame = 0; frame < frameCount; frame++) mixed[frame] += values[frame] / sample.channels.length;
            }
            buffer.copyToChannel(mixed, 0);
          } else {
            for (let channel = 0; channel < outputChannels; channel++) buffer.copyToChannel(new Float32Array(sample.channels[channel]), channel);
          }
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = speed;
          source.connect(input);
          voice.sources.add(source);
          source.onended = () => { voice.sources.delete(source); source.disconnect(); };
          source.start(Math.max(context.currentTime, when), sourceOffset);
        }
      }
    } catch {
      if (token === this.audioPreviewToken) this.toast(t("音声プレビューをデコードできませんでした"));
    }
  }

  private onEngineMessage(message: EngineResponse) {
    if (message.type === "ready") {
      this.update({ engine: message.backend, mediaBunnyReady: message.mediaBunnyReady, cameraProjection: message.cameraProjection });
      this.renderPreview(true);
    } else if (message.type === "cache") {
      this.update({ cache: { ...this.state.cache, usedBytes: message.usedBytes, maxBytes: message.maxBytes, entries: message.entries } });
    } else if (message.type === "media-buffer-state") {
      this.update({ mediaBuffer: {
        usedBytes: message.usedBytes,
        maxBytes: message.maxBytes,
        entries: message.residentAssetIds.length,
        pending: message.requestedAssetIds.length,
        instances: message.instanceCount,
      } });
    } else if (message.type === "export-progress") {
      this.update({ exportProgress: message.progress });
    } else if (message.type === "video-frame-ready") {
      this.update({ videoFramesRendered: this.state.videoFramesRendered + 1 });
    } else if (message.type === "geometry-ready") {
      this.update({ geometryObjectsReady: this.state.geometryObjectsReady + 1 });
    } else if (message.type === "scene-object-count") {
      this.update({ activeSceneObjects: message.count });
    } else if (message.type === "image-object-count") {
      this.update({ activeImageObjects: message.count });
    } else if (message.type === "render-complete") {
      if (message.videoFramesReady) this.update({ videoFramesRendered: this.state.videoFramesRendered + message.videoFramesReady });
      if (message.rendererStats) this.update({ rendererStats: message.rendererStats });
      if (message.previewSource) this.recordPreviewMetric(message.previewSource);
    } else if (message.type === "plugin-state") {
      this.update({ plugins: upsertPlugin(this.state.plugins, message.plugin) });
    } else if (message.type === "error") {
      this.toast(message.message);
    }
  }

  private recordPreviewMetric(source: "realtime" | "cache") {
    this.pendingPreviewFrames++;
    this.pendingCachedFrames += source === "cache" ? 1 : 0;
    this.pendingPreviewSource = source;
    if (source !== this.state.previewSource) this.flushPreviewMetrics();
    else if (!this.previewMetricTimer) this.previewMetricTimer = window.setTimeout(() => this.flushPreviewMetrics(), 250);
  }

  private flushPreviewMetrics() {
    window.clearTimeout(this.previewMetricTimer);
    this.previewMetricTimer = 0;
    if (!this.pendingPreviewFrames) return;
    const frames = this.pendingPreviewFrames;
    const cached = this.pendingCachedFrames;
    this.pendingPreviewFrames = 0;
    this.pendingCachedFrames = 0;
    this.update({
      previewSource: this.pendingPreviewSource,
      previewFramesRendered: this.state.previewFramesRendered + frames,
      cachedFramesDisplayed: this.state.cachedFramesDisplayed + cached,
    });
  }

  private previewDpr() {
    // Inspector renders at the device's native backing resolution. Camera
    // previews apply their own scale and fill-rate cap inside the renderer.
    return window.devicePixelRatio || 1;
  }

  connectPreview(canvas: HTMLCanvasElement, width: number, height: number) {
    if (this.previewCanvases.has(canvas)) return;
    this.previewCanvases.add(canvas);
    if (!("transferControlToOffscreen" in canvas)) {
      this.update({ engine: "unsupported" });
      return;
    }
    const offscreen = canvas.transferControlToOffscreen();
    if (this.canvasReady) this.engine.attachCanvas(offscreen, width, height, this.previewDpr());
    else {
      this.canvasReady = true;
      this.engine.init(offscreen, width, height, this.previewDpr());
    }
    this.renderPreview(true);
  }

  resizePreview(width: number, height: number) {
    if (this.canvasReady) this.engine.resize(width, height, this.previewDpr());
  }

  renderPreview(cache = false) {
    if (!this.canvasReady) return;
    const renderClips = this.getRenderClips();
    const patch = this.virtualTimeline.reconcile(renderClips);
    if (patch) this.engine.patchTimeline(patch);
    const mediaPlanTimeBucket = Math.floor(this.state.currentTime * 2);
    if (this.mediaPlanClipSource !== this.state.clips || this.mediaPlanAssetSource !== this.state.assets || this.mediaPlanTimeBucket !== mediaPlanTimeBucket) {
      this.mediaPlanClipSource = this.state.clips;
      this.mediaPlanAssetSource = this.state.assets;
      this.mediaPlanTimeBucket = mediaPlanTimeBucket;
      this.engine.setMediaReadGraph(this.mediaReadPlanner.build(this.state.clips, this.state.assets, this.state.currentTime));
    }
    const activePreviewClip = this.state.activePreviewClipId
      ? this.state.clips.find((clip) => clip.id === this.state.activePreviewClipId)
      : undefined;
    // Audio tabs replace the visual surface with the waveform editor. Do not
    // spend decode/GPU work on the canvas hidden behind that active tab.
    if (activePreviewClip?.kind === "audio") return;
    if (this.state.playing) {
      const frame = Math.floor(this.state.currentTime * this.state.fps);
      if (frame === this.lastPlaybackFrame) return;
      this.lastPlaybackFrame = frame;
    } else {
      this.lastPlaybackFrame = -1;
    }
    const previewView = this.state.activePreviewClipId ? "camera" : this.state.activePreviewView;
    this.engine.render(this.state.currentTime, cache && this.state.settings.ramPreviewEnabled && !this.state.activePreviewClipId && previewView === "camera", this.state.playing ? "playback" : "realtime", this.state.fps, this.state.background.scene, previewView, this.state.activePreviewClipId ?? undefined);
  }

  private getRenderClips(): RenderClip[] {
    const renderClipContextSignature = [
      this.state.background.width,
      this.state.background.height,
      this.state.background.scene.camera.orthographicHeight,
      this.state.background.scene.camera.zoom,
      this.state.assets.map((asset) => `${asset.id}:${asset.kind}:${asset.hasAudio === true}`).join(","),
    ].join(":");
    if (this.renderClipSource === this.state.clips && this.renderClipContextSignature === renderClipContextSignature) return this.renderClipCache;
    const visualSolo = this.state.clips.some((clip) => clip.solo && clip.kind !== "group" && clip.kind !== "audio");
    const audioSolo = this.state.clips.some((clip) => clip.solo && clipHasAudio(clip, this.state.assets));
    const visualClips = this.state.clips.filter((clip) => clip.kind !== "group" && clip.kind !== "filter");
    const filters = this.state.clips
      .filter((clip) => clip.kind === "filter" && !clip.muted && (!visualSolo || clip.solo))
      .sort((a, b) => b.y - a.y);
    const depth = new Map(orderedVisualClips(visualClips)
      .map((clip, index) => [clip.id, 1_000 + index]));
    this.renderClipSource = this.state.clips;
    this.renderClipContextSignature = renderClipContextSignature;
    this.renderClipCache = visualClips.map((clip) => ({
      id: clip.id,
      assetId: clip.assetId,
      start: clip.start,
      duration: clip.duration,
      offset: clip.offset,
      positionX: clip.positionX ?? 0,
      positionY: clip.positionY ?? 0,
      positionZ: clip.positionZ ?? 0,
      scale: clip.scale ?? 100,
      scaleX: clip.scaleX ?? 100,
      scaleY: clip.scaleY ?? 100,
      rotation: clip.rotation ?? 0,
      rotationX: clip.rotationX ?? 0,
      rotationY: clip.rotationY ?? 0,
      visible: (clip.visible ?? true) && !clip.muted && (!visualSolo || clip.solo === true || clip.kind === "audio"),
      layer: clip.layer ?? 0,
      parentId: clip.parentId,
      opacity: clip.opacity ?? 100,
      transitionIn: Math.max(0, clip.transitionIn ?? 0),
      transitionOut: Math.max(0, clip.transitionOut ?? 0),
      volume: clip.muted || (audioSolo && !clip.solo) ? -60 : clip.volume ?? 0,
      pan: clip.pan ?? 0,
      speed: clip.speed ?? 100,
      audioProcessing: clip.audioProcessing,
      cropLeft: clip.cropLeft ?? 0,
      cropRight: clip.cropRight ?? 0,
      cropTop: clip.cropTop ?? 0,
      cropBottom: clip.cropBottom ?? 0,
      effects: clip.effects ?? [],
      colorGrading: resolveColorGrading(clip.colorGrading),
      propertyActionOrder: resolveClipPropertyActions(clip).map((action) => action.kind),
      filterStack: clip.kind === "audio" ? [] : filters
        .filter((filter) => filter.y < clip.y && filter.start < clip.start + clip.duration && filter.start + filter.duration > clip.start)
        .map((filter) => ({
          id: filter.id,
          start: filter.start,
          duration: filter.duration,
          enabled: filter.visible !== false,
          positionX: filter.positionX ?? 0,
          positionY: filter.positionY ?? 0,
          scale: filter.scale ?? 100,
          scaleX: filter.scaleX ?? 100,
          scaleY: filter.scaleY ?? 100,
          rotation: filter.rotation ?? 0,
          opacity: filter.opacity ?? 100,
          compositionAspect: this.state.background.width / Math.max(1, this.state.background.height),
          effects: filter.effects ?? [],
          keyframes: filter.keyframes ?? [],
        })),
      masks: clip.masks ?? [],
      keyframes: clip.keyframes ?? [],
      particleSystem: clip.particleSystem,
      modelAnimation: clip.modelAnimation,
      instanceCount: clip.instanceCount ?? 1,
      instanceSpacing: clip.instanceSpacing ?? 2.5,
      renderOrder: depth.get(clip.id) ?? 1_000,
      sceneObject: this.sceneObjectForClip(clip, depth.get(clip.id) ?? 1_000),
    }));
    return this.renderClipCache;
  }

  private sceneObjectForClip(clip: TimelineClip, renderOrder: number): SceneObjectSpec | undefined {
    if (clip.kind !== "title" && clip.kind !== "object") return undefined;
    if (clip.particleSystem) return undefined;
    const isText2D = clip.kind === "title" && clip.textMode === "2d";
    const visual = applySceneClipEffects(clip);
    const previewPixelsPerWorldUnit = this.state.background.height
      / Math.max(0.001, this.state.background.scene.camera.orthographicHeight)
      * Math.max(0.001, this.state.background.scene.camera.zoom);
    const geometry = clip.kind === "title"
      ? isText2D
        ? {
            id: `${clip.id}:text2d`, kind: "text2d" as const, text: clip.text ?? clip.name,
            fontId: timelineFontId(clip), fontFamily: clip.fontFamily, fontVariations: clip.fontVariations, size: clip.fontSize ?? 1.2,
            letterSpacing: clip.letterSpacing ?? 0,
            color: clip.textColor ?? 0x202020, outlineColor: clip.textOutlineColor ?? 0xffffff,
            outlineWidth: clip.textOutlineWidth ?? 0,
            rasterPixelsPerUnit: previewPixelsPerWorldUnit * Math.max(visual.scaleX, visual.scaleY),
          }
        : {
            id: `${clip.id}:text`, kind: "text" as const, text: clip.text ?? clip.name,
            fontId: clip.fontId, fontFamily: clip.fontFamily, fontVariations: clip.fontVariations, size: clip.fontSize ?? 1.2, depth: clip.textDepth ?? 0.12,
            letterSpacing: clip.letterSpacing ?? 0,
            curveSegments: 8, bevelEnabled: false,
          }
      : clip.geometry;
    if (!geometry) return undefined;
    const instanceCount = Math.max(1, Math.min(1_000, Math.floor(clip.instanceCount ?? 1)));
    const instanceSpacing = clip.instanceSpacing ?? 2.5;
    return {
      id: `timeline:${clip.id}`,
      geometry,
      primitive: clip.primitive ?? "mesh",
      material: {
        kind: clip.kind === "title" ? "basic" : clip.material?.kind ?? "standard",
        color: clip.kind === "title" ? isText2D ? 0xffffff : clip.textColor ?? 0x202020 : clip.material?.color ?? clip.textColor ?? 0x3d73a0,
        ...clip.material,
        effects: clip.effects ?? [],
        opacity: visual.opacity,
        side: clip.kind === "title" ? "double" : clip.material?.side ?? "front",
        depthTest: true, depthWrite: isText2D ? false : (clip.opacity ?? 100) >= 100, transparent: true,
        outlineColor: clip.kind === "title" && !isText2D ? clip.textOutlineColor ?? 0xffffff : undefined,
        outlineWidth: clip.kind === "title" && !isText2D ? clip.textOutlineWidth ?? 0.02 : undefined,
      },
      transform: {
        position: [visual.positionX, visual.positionY, (clip.positionZ ?? 0) / 100],
        rotation: [((clip.rotationX ?? 0) * Math.PI) / 180, ((clip.rotationY ?? 0) * Math.PI) / 180, visual.rotation],
        scale: [
          visual.scaleX,
          visual.scaleY,
          Math.max(0.001, (clip.scale ?? 100) / 100),
        ],
      },
      renderOrder,
      visible: clip.visible ?? true,
      layer: clip.layer ?? 0,
      parentId: clip.parentId ? `timeline:${clip.parentId}` : undefined,
      instances: clip.kind === "object" && instanceCount > 1 ? Array.from({ length: instanceCount }, (_, index) => ({ position: [(index - (instanceCount - 1) / 2) * instanceSpacing, 0, 0] as [number, number, number] })) : undefined,
      castShadow: clip.castShadow ?? clip.kind === "object",
      receiveShadow: clip.receiveShadow ?? clip.kind === "object",
    };
  }

  setTime = (time: number) => {
    this.update({ currentTime: Math.max(0, Math.min(time, this.state.duration)) });
    if (this.state.playing) {
      this.playbackStartTime = this.state.currentTime;
      this.playbackStartedAt = performance.now();
    }
    this.renderPreview(true);
    this.syncAudioPlayback(this.state.playing, true);
  };

  togglePlayback = () => {
    const playing = !this.state.playing;
    const focusedAudio = this.state.clips.find((clip) => clip.id === this.state.activePreviewClipId && clip.kind === "audio");
    if (playing && focusedAudio && (this.state.currentTime < focusedAudio.start || this.state.currentTime >= focusedAudio.start + focusedAudio.duration)) {
      this.state = { ...this.state, currentTime: focusedAudio.start };
    }
    if (playing && this.state.loopPlayback && (this.state.currentTime < this.state.exportSettings.startTime || this.state.currentTime >= this.state.exportSettings.endTime)) {
      this.state = { ...this.state, currentTime: this.state.exportSettings.startTime };
    }
    this.update({ playing });
    if (playing) {
      const renderClips = this.getRenderClips();
      this.engine.syncTimeline(this.virtualTimeline.snapshot(renderClips));
      this.lastTick = performance.now();
      this.playbackStartedAt = this.lastTick;
      this.playbackStartTime = this.state.currentTime;
      this.renderPreview(false);
      this.frame = requestAnimationFrame(this.tick);
      this.syncAudioPlayback(true, true);
    } else {
      cancelAnimationFrame(this.frame);
      this.syncAudioPlayback(false);
      this.renderPreview(true);
    }
  };

  private tick = (now: number) => {
    if (!this.state.playing) return;
    this.lastTick = now;
    const next = this.playbackStartTime + (now - this.playbackStartedAt) / 1000;
    const playbackEnd = this.state.loopPlayback ? Math.min(this.state.duration, this.state.exportSettings.endTime) : this.state.duration;
    if (next >= playbackEnd && this.state.loopPlayback) {
      const start = Math.max(0, Math.min(this.state.exportSettings.startTime, playbackEnd - 1 / this.state.fps));
      this.playbackStartedAt = now;
      this.playbackStartTime = start;
      this.update({ currentTime: start });
      this.syncAudioPlayback(true, true);
      this.renderPreview(false);
      this.frame = requestAnimationFrame(this.tick);
      return;
    }
    if (next >= this.state.duration) {
      this.update({ currentTime: 0, playing: false });
      this.syncAudioPlayback(false);
      this.renderPreview(true);
      return;
    }
    const nextFrame = Math.floor(next * this.state.fps);
    const currentFrame = Math.floor(this.state.currentTime * this.state.fps);
    if (nextFrame !== currentFrame) {
      this.update({ currentTime: next });
      this.syncAudioPlayback(true);
      this.renderPreview(false);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  nudge = (frames: number) => this.setTime(this.state.currentTime + frames / this.state.fps);
  setZoom = (zoom: number) => this.update({ zoom: clampTimelineZoom(zoom) });
  setTimelineVerticalZoom = (zoom: number) => this.update({ timelineVerticalZoom: clampTimelineVerticalZoom(zoom) });
  toggleSnap = () => this.update({ snapEnabled: !this.state.snapEnabled });
  toggleLoopPlayback = () => this.update({ loopPlayback: !this.state.loopPlayback });
  addMarker = (time = this.state.currentTime, label?: string) => {
    const markerTime = this.snapTime(time);
    const existing = this.state.markers.find((marker) => Math.abs(marker.time - markerTime) < 0.5 / this.state.fps);
    if (existing) return;
    const colors = ["#f0c36a", "#72b7d2", "#c481d8", "#7dc58b"];
    this.update({ markers: [...this.state.markers, { id: crypto.randomUUID(), time: markerTime, label: label?.trim() || t("マーカー {number}", { number: this.state.markers.length + 1 }), color: colors[this.state.markers.length % colors.length] }].sort((a, b) => a.time - b.time) });
    this.schedulePersistence();
  };
  updateMarker = (id: string, patch: Partial<EditorState["markers"][number]>) => {
    this.update({ markers: this.state.markers.map((marker) => marker.id === id ? { ...marker, ...patch, id: marker.id } : marker).sort((a, b) => a.time - b.time) });
    this.schedulePersistence();
  };
  removeMarker = (id: string) => {
    this.update({ markers: this.state.markers.filter((marker) => marker.id !== id) });
    this.schedulePersistence();
  };
  selectClip = (id: string, additive = false) => {
    const clip = this.state.clips.find((item) => item.id === id);
    const selectedClipIds = additive
      ? this.state.selectedClipIds.includes(id) ? this.state.selectedClipIds.filter((item) => item !== id) : [...this.state.selectedClipIds, id]
      : [id];
    const selectedClipId = selectedClipIds.includes(id) ? id : selectedClipIds.at(-1) ?? null;
    const selectedClip = this.state.clips.find((item) => item.id === selectedClipId);
    const previewable = clip && clip.kind !== "group" && clip.kind !== "filter";
    this.update({
      selectedClipId,
      selectedClipIds,
      selectedCameraKeyframeIds: [],
      selectedAssetId: selectedClip?.assetId ?? null,
      backgroundSelected: false,
      ...(previewable ? {
        previewClipTabs: this.state.previewClipTabs.includes(id) ? this.state.previewClipTabs : [...this.state.previewClipTabs, id],
        activePreviewClipId: id,
      } : clip?.kind === "filter" ? { activePreviewClipId: null, activePreviewView: "camera" as const } : {}),
    });
    if (previewable || clip?.kind === "filter") this.renderPreview(false);
  };
  selectClips = (ids: string[], additive = false) => {
    const selectedClipIds = additive ? [...new Set([...this.state.selectedClipIds, ...ids])] : ids;
    const selectedClipId = selectedClipIds.at(-1) ?? null;
    const clip = this.state.clips.find((item) => item.id === selectedClipId);
    const previewable = clip && clip.kind !== "group" && clip.kind !== "filter";
    this.update({
      selectedClipIds, selectedClipId, selectedCameraKeyframeIds: [], selectedAssetId: clip?.assetId ?? null, backgroundSelected: false,
      ...(previewable ? {
        previewClipTabs: this.state.previewClipTabs.includes(clip.id) ? this.state.previewClipTabs : [...this.state.previewClipTabs, clip.id],
        activePreviewClipId: clip.id,
      } : clip?.kind === "filter" ? { activePreviewClipId: null, activePreviewView: "camera" as const } : {}),
    });
    if (previewable || clip?.kind === "filter") this.renderPreview(false);
  };
  setPreviewTab = (clipId: string | null) => {
    if (clipId === null) {
      this.update({ activePreviewClipId: null, activePreviewView: "inspector" });
      this.renderPreview(false);
      return;
    }
    if (!this.state.previewClipTabs.includes(clipId)) return;
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (!clip) return;
    this.update({
      activePreviewClipId: clipId,
      selectedClipId: clipId,
      selectedClipIds: [clipId],
      selectedCameraKeyframeIds: [],
      selectedAssetId: clip.assetId ?? null,
      backgroundSelected: false,
    });
    this.renderPreview(false);
  };
  setPreviewView = (view: "camera" | "inspector") => {
    this.update({
      activePreviewClipId: null,
      activePreviewView: view,
    });
    this.renderPreview(false);
  };
  closePreviewTab = (clipId: string) => {
    const previewClipTabs = this.state.previewClipTabs.filter((id) => id !== clipId);
    const activePreviewClipId = this.state.activePreviewClipId === clipId ? null : this.state.activePreviewClipId;
    this.update({ previewClipTabs, activePreviewClipId, ...(this.state.activePreviewClipId === clipId ? { activePreviewView: "inspector" as const } : {}) });
    if (activePreviewClipId !== this.state.activePreviewClipId) this.renderPreview(false);
  };
  selectAsset = (id: string | null) => this.update({ selectedAssetId: id, selectedClipId: null, selectedClipIds: [], selectedCameraKeyframeIds: [], backgroundSelected: false });
  renameAsset = (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.update({ assets: this.state.assets.map((asset) => asset.id === id ? { ...asset, name: trimmed } : asset) });
    this.schedulePersistence();
  };
  removeAsset = (id: string) => {
    const referenced = new Set(this.state.clips.filter((clip) => clip.assetId === id).map((clip) => clip.id));
    if (referenced.size) this.removeClipIds(referenced);
    this.engine.releaseMedia(id);
    this.runtimeFiles.delete(id);
    this.runtimeReadyAssetIds.delete(id);
    this.runtimeAssetLoads.delete(id);
    this.persistedHandleSignatures.delete(id);
    void removeHandleProject(id).catch(() => undefined);
    this.update({ assets: this.state.assets.filter((asset) => asset.id !== id), selectedAssetId: this.state.selectedAssetId === id ? null : this.state.selectedAssetId });
    this.schedulePersistence();
  };
  selectBackground = () => this.update({ backgroundSelected: true, selectedAssetId: null, selectedClipId: null, selectedClipIds: [], selectedCameraKeyframeIds: [] });
  selectCameraKeyframes = (ids: readonly string[]) => {
    const available = new Set((this.state.background.scene.keyframes ?? []).filter((keyframe) => keyframe.property.startsWith("camera.")).map((keyframe) => keyframe.id));
    const selectedCameraKeyframeIds = [...new Set(ids)].filter((id) => available.has(id));
    this.update({ selectedCameraKeyframeIds, selectedClipId: null, selectedClipIds: [], selectedAssetId: null, backgroundSelected: selectedCameraKeyframeIds.length === 0 });
  };
  updateBackground = (patch: Partial<EditorState["background"]>) => {
    const next = normalizeBackgroundSize({ ...this.state.background, ...patch });
    if (patch.color !== undefined) next.scene = { ...next.scene, background: { ...next.scene.background, color: patch.color } };
    const sizeChanged = next.width !== this.state.background.width || next.height !== this.state.background.height;
    this.update({
      background: next,
      backgroundSelected: true,
      ...(sizeChanged ? { exportSettings: { ...this.state.exportSettings, width: next.width, height: next.height } } : {}),
    });
    if (sizeChanged) this.engine.clearCache();
    this.renderPreview(true);
  };
  updateBackgroundSize = (width: number, height: number) => this.updateBackground({
    width: normalizeCompositionDimension(width, this.state.background.width),
    height: normalizeCompositionDimension(height, this.state.background.height),
  });
  updateSceneSettings = (patch: Partial<SceneSettings>) => {
    let cameras = patch.cameras ?? this.state.background.scene.cameras ?? [this.state.background.scene.camera];
    if (patch.camera) {
      const camera = { ...this.state.background.scene.camera, ...patch.camera };
      cameras = cameras.some((item) => item.id === camera.id)
        ? cameras.map((item) => item.id === camera.id ? camera : item)
        : [...cameras, camera];
    }
    const scene = {
      ...this.state.background.scene,
      ...patch,
      background: { ...this.state.background.scene.background, ...patch.background },
      camera: { ...this.state.background.scene.camera, ...patch.camera },
      cameras,
      cameraCuts: patch.cameraCuts ?? this.state.background.scene.cameraCuts ?? [],
      renderer: { ...this.state.background.scene.renderer, ...patch.renderer },
      lights: patch.lights ?? this.state.background.scene.lights,
    };
    const sceneKeyframeIds = new Set(scene.keyframes?.map((keyframe) => keyframe.id) ?? []);
    const selectedCameraKeyframeIds = this.state.selectedCameraKeyframeIds.filter((id) => sceneKeyframeIds.has(id));
    this.update({ background: { ...this.state.background, color: scene.background.color, scene }, selectedCameraKeyframeIds, backgroundSelected: selectedCameraKeyframeIds.length === 0 });
    this.renderPreview(true);
  };
  addCamera = () => {
    const current = this.state.background.scene.camera;
    const cameras = this.state.background.scene.cameras ?? [current];
    const camera: CameraSettings = { ...structuredClone(current), id: crypto.randomUUID(), name: t("Camera {number}", { number: cameras.length + 1 }) };
    this.updateSceneSettings({ camera, cameras: [...cameras, camera] });
    this.schedulePersistence();
  };
  selectCamera = (cameraId: string) => {
    const camera = (this.state.background.scene.cameras ?? []).find((item) => item.id === cameraId);
    if (!camera) return;
    this.updateSceneSettings({ camera: structuredClone(camera) });
  };
  removeCurrentCamera = () => {
    const scene = this.state.background.scene;
    const cameras = scene.cameras ?? [scene.camera];
    if (cameras.length <= 1) return;
    const remaining = cameras.filter((camera) => camera.id !== scene.camera.id);
    this.updateSceneSettings({ camera: remaining[0], cameras: remaining, cameraCuts: (scene.cameraCuts ?? []).filter((cut) => cut.cameraId !== scene.camera.id) });
    this.schedulePersistence();
  };
  addCameraCut = () => {
    const scene = this.state.background.scene;
    const tolerance = 0.5 / this.state.fps;
    const existing = (scene.cameraCuts ?? []).find((cut) => Math.abs(cut.time - this.state.currentTime) <= tolerance);
    const cut = { id: existing?.id ?? crypto.randomUUID(), time: this.state.currentTime, cameraId: scene.camera.id };
    const cameraCuts = [...(scene.cameraCuts ?? []).filter((item) => item.id !== cut.id), cut].sort((a, b) => a.time - b.time);
    this.updateSceneSettings({ cameraCuts });
    this.schedulePersistence();
  };
  removeCameraCut = (id: string) => {
    this.updateSceneSettings({ cameraCuts: (this.state.background.scene.cameraCuts ?? []).filter((cut) => cut.id !== id) });
    this.schedulePersistence();
  };
  updateCameraPositionAxis = (axis: 0 | 1 | 2, value: number) => {
    const camera = this.state.background.scene.camera;
    const position = [...camera.position] as [number, number, number];
    const target = [...camera.target] as [number, number, number];
    const delta = value - position[axis];
    position[axis] = value;
    // X/Y are world-space truck/pedestal controls. Moving the target by the
    // same amount preserves the viewing direction instead of orbiting it.
    if (axis === 0 || axis === 1) target[axis] += delta;
    this.updateSceneSettings({ camera: { ...camera, position, target } });
  };
  addSceneKeyframe = (property: string, value: number, interpolation: SceneKeyframe["interpolation"] = "smooth") => {
    const keys = (this.state.background.scene.keyframes ?? []).map((keyframe) => ({ ...keyframe, easing: keyframe.easing ? { ...keyframe.easing } : undefined }));
    const tolerance = 0.5 / this.state.fps;
    const existing = keys.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - this.state.currentTime) <= tolerance);
    const keyframes: SceneKeyframe[] = existing
      ? keys.map((keyframe) => keyframe.id === existing.id ? { ...keyframe, value, interpolation, time: this.state.currentTime } : keyframe)
      : [...keys, { id: crypto.randomUUID(), property, value, time: this.state.currentTime, interpolation }];
    keyframes.sort((a, b) => a.time - b.time || a.property.localeCompare(b.property));
    this.updateSceneSettings({ keyframes });
    this.schedulePersistence();
  };
  updateSceneKeyframe = (id: string, patch: Partial<SceneKeyframe>) => {
    const keyframes = this.state.background.scene.keyframes ?? [];
    const source = keyframes.find((keyframe) => keyframe.id === id);
    const positionAxis = source?.property.match(/^camera\.position\.([01])$/)?.[1];
    const positionDelta = source && positionAxis !== undefined && patch.value !== undefined ? patch.value - source.value : 0;
    const pairedTargetProperty = positionAxis === undefined ? undefined : `camera.target.${positionAxis}`;
    const tolerance = 0.5 / this.state.fps;
    this.updateSceneSettings({ keyframes: keyframes.map((keyframe) => {
      if (keyframe.id === id) return { ...keyframe, ...patch };
      if (pairedTargetProperty && source && keyframe.property === pairedTargetProperty && Math.abs(keyframe.time - source.time) <= tolerance) {
        return { ...keyframe, value: keyframe.value + positionDelta };
      }
      return keyframe;
    }).sort((a, b) => a.time - b.time) });
    this.schedulePersistence();
  };
  removeSceneKeyframe = (id: string) => {
    this.updateSceneSettings({ keyframes: (this.state.background.scene.keyframes ?? []).filter((keyframe) => keyframe.id !== id) });
    this.schedulePersistence();
  };
  addCameraKeyframe = (requestedTime = this.state.currentTime, interpolation: SceneKeyframe["interpolation"] = "smooth") => {
    const time = Math.max(0, Math.min(this.state.duration, requestedTime));
    const camera = this.state.background.scene.camera;
    const keys = (this.state.background.scene.keyframes ?? []).map((keyframe) => ({ ...keyframe, easing: keyframe.easing ? { ...keyframe.easing } : undefined }));
    const values: Array<[string, number]> = [
      ["camera.position.0", camera.position[0]],
      ["camera.position.1", camera.position[1]],
      ["camera.position.2", camera.position[2]],
      ["camera.target.0", camera.target[0]],
      ["camera.target.1", camera.target[1]],
      ["camera.target.2", camera.target[2]],
      ["camera.near", camera.near],
      ["camera.far", camera.far],
      ["camera.fov", camera.fov],
      ["camera.zoom", camera.zoom],
      ["camera.orthographicHeight", camera.orthographicHeight],
    ];
    const tolerance = 0.5 / this.state.fps;
    const keyframes: SceneKeyframe[] = [...keys];
    for (const [property, fallback] of values) {
      const value = evaluateSceneNumber(keys, property, time, fallback);
      const existingIndex = keyframes.findIndex((keyframe) => keyframe.property === property && Math.abs(keyframe.time - time) <= tolerance);
      if (existingIndex >= 0) keyframes[existingIndex] = { ...keyframes[existingIndex], time, value, interpolation };
      else keyframes.push({ id: crypto.randomUUID(), property, time, value, interpolation });
    }
    keyframes.sort((a, b) => a.time - b.time || a.property.localeCompare(b.property));
    this.updateSceneSettings({ keyframes });
    const selectedCameraKeyframeIds = keyframes.filter((keyframe) => keyframe.property.startsWith("camera.") && Math.abs(keyframe.time - time) <= tolerance).map((keyframe) => keyframe.id);
    this.selectCameraKeyframes(selectedCameraKeyframeIds);
    this.setTime(time);
    this.schedulePersistence();
  };
  updateCameraKeyframes = (ids: readonly string[], patch: Partial<Pick<SceneKeyframe, "interpolation" | "easing">>) => {
    const selected = new Set(ids);
    this.updateSceneSettings({
      keyframes: (this.state.background.scene.keyframes ?? []).map((keyframe) => selected.has(keyframe.id) ? { ...keyframe, ...patch } : keyframe),
    });
    this.schedulePersistence();
  };
  moveCameraKeyframes = (ids: readonly string[], requestedTime: number) => {
    const time = Math.max(0, Math.min(this.state.duration, requestedTime));
    const selected = new Set(ids);
    this.updateSceneSettings({
      keyframes: (this.state.background.scene.keyframes ?? [])
        .map((keyframe) => selected.has(keyframe.id) ? { ...keyframe, time } : keyframe)
        .sort((a, b) => a.time - b.time || a.property.localeCompare(b.property)),
    });
    this.setTime(time);
    this.schedulePersistence();
  };
  removeCameraKeyframes = (ids: readonly string[]) => {
    const selected = new Set(ids);
    this.updateSceneSettings({ keyframes: (this.state.background.scene.keyframes ?? []).filter((keyframe) => !selected.has(keyframe.id)) });
    this.selectCameraKeyframes([]);
    this.schedulePersistence();
  };
  openContextMenu = (menu: ContextMenuState) => this.update({ contextMenu: menu });
  closeContextMenu = () => this.update({ contextMenu: null });
  setLeftPanelTab = (tab: EditorState["leftPanelTab"]) => this.update({ leftPanelTab: tab });
  renameProject = (projectName: string) => this.update({ projectName });
  updateSequenceSettings = (patch: { fps?: number; duration?: number }) => {
    const fps = Math.max(1, Math.min(240, Math.round(patch.fps ?? this.state.fps)));
    const contentEnd = this.state.clips.length ? Math.max(...this.state.clips.map((clip) => clip.start + clip.duration)) : 1 / fps;
    const duration = Math.max(contentEnd, 1 / fps, Number.isFinite(patch.duration) ? patch.duration! : this.state.duration);
    this.update({ fps, duration, currentTime: Math.min(this.state.currentTime, duration) });
    this.schedulePersistence();
    this.renderPreview(false);
  };
  updateSettings = (patch: Partial<EditorSettings>) => {
    const previous = this.state.settings;
    const next: EditorSettings = {
      ...previous,
      ...patch,
      ramPreviewMaxBytes: Math.max(32 * MiB, Math.min(2_048 * MiB, Math.round((patch.ramPreviewMaxBytes ?? previous.ramPreviewMaxBytes) / MiB) * MiB)),
      audioChannels: patch.audioChannels === "mono" ? "mono" : patch.audioChannels === "stereo" ? "stereo" : previous.audioChannels,
    };
    const previewChanged = next.ramPreviewEnabled !== previous.ramPreviewEnabled || next.ramPreviewMaxBytes !== previous.ramPreviewMaxBytes;
    this.update({
      settings: next,
      cache: previewChanged ? { ...this.state.cache, maxBytes: next.ramPreviewMaxBytes, ...(next.ramPreviewEnabled ? {} : { usedBytes: 0, entries: 0 }) } : this.state.cache,
      ...(next.ramPreviewEnabled ? {} : { previewSource: "realtime" as const }),
    });
    try { localStorage.setItem("gfxutl:settings", JSON.stringify(next)); } catch { /* Storage may be blocked. */ }
    if (previewChanged) {
      this.engine.configurePreviewCache(next.ramPreviewEnabled, next.ramPreviewMaxBytes);
      this.renderPreview(false);
    }
    if (next.audioChannels !== previous.audioChannels && this.state.playing) this.syncAudioPlayback(true, true);
  };
  updateExportSettings = (patch: Partial<ExportSettings>) => {
    let next = { ...this.state.exportSettings, ...patch };
    next.width = Math.max(2, Math.min(7680, Math.floor(next.width / 2) * 2));
    next.height = Math.max(2, Math.min(4320, Math.floor(next.height / 2) * 2));
    next.startTime = Number.isFinite(next.startTime) ? Math.max(0, next.startTime) : this.state.exportSettings.startTime;
    const requestedDuration = patch.endTime !== undefined && Number.isFinite(patch.endTime)
      ? Math.max(1 / this.state.fps, patch.endTime, ...this.state.clips.map((clip) => clip.start + clip.duration))
      : this.state.duration;
    next = alignExportRangeToSequence(next, requestedDuration);
    if (patch.format === "mp4") {
      if (!["avc", "hevc", "av1"].includes(next.videoCodec)) next.videoCodec = "avc";
      if (!["aac", "opus", "none"].includes(next.audioCodec)) next.audioCodec = "aac";
    } else if (patch.format === "webm") {
      if (!["vp8", "vp9", "av1"].includes(next.videoCodec)) next.videoCodec = "vp9";
      if (!["opus", "vorbis", "none"].includes(next.audioCodec)) next.audioCodec = "opus";
    }
    this.update({
      exportSettings: next,
      ...(requestedDuration === this.state.duration ? {} : { duration: requestedDuration, currentTime: Math.min(this.state.currentTime, requestedDuration) }),
    });
  };

  getMediaThumbnail = async (assetId: string, time = 0, timeline?: { width: number; height: number }, signal?: AbortSignal) => {
    const cachedAsset = this.state.assets.find((item) => item.id === assetId);
    if (!timeline && cachedAsset?.kind === "audio" && cachedAsset.waveformVersion === AUDIO_WAVEFORM_VERSION && cachedAsset.waveformPeaks?.length) return { peaks: cachedAsset.waveformPeaks };
    await this.ensureAssetRuntime(assetId);
    const thumbnail = await this.engine.getMediaThumbnail(assetId, time, timeline, signal);
    if (thumbnail.peaks?.length) {
      const asset = this.state.assets.find((item) => item.id === assetId);
      if (asset && asset.waveformPeaks !== thumbnail.peaks) {
        this.updateRuntime({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, waveformPeaks: thumbnail.peaks, waveformVersion: AUDIO_WAVEFORM_VERSION } : item) });
        this.schedulePersistence();
      }
    }
    return thumbnail;
  };
  prepareMediaPreview = async (file: File, previewId: string, handle?: FileSystemFileHandle) => {
    const info = await this.engine.inspectMedia(file, previewId, handle);
    this.runtimeReadyAssetIds.add(previewId);
    return info;
  };
  releaseMediaPreview = (previewId: string) => {
    this.runtimeReadyAssetIds.delete(previewId);
    this.runtimeAssetLoads.delete(previewId);
    this.engine.releaseMedia(previewId);
  };
  pickPreview = async (ndcX: number, ndcY: number, coalesce = false) => (await this.engine.pick(ndcX, ndcY, coalesce)).clipId;
  pickPreviewTarget = (ndcX: number, ndcY: number, coalesce = false) => this.engine.pick(ndcX, ndcY, coalesce);
  moveInspectorCamera = (operation: "orbit" | "pan" | "walk", deltaX: number, deltaY: number) => this.engine.moveInspectorCamera(operation, deltaX, deltaY);
  moveCameraAtPlayhead = (operation: "orbit" | "pan" | "dolly", deltaX: number, deltaY: number, viewportHeight: number) => {
    if (this.state.playing || (!deltaX && !deltaY) || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const time = this.state.currentTime;
    const scene = this.state.background.scene;
    const camera = transformCamera(evaluateCameraAtTime(scene, time), operation, deltaX, deltaY, viewportHeight);
    this.writeCameraAtTime(camera, time);
  };
  beginCameraHandleInteraction = (handle: CameraHandleKind, ndcX: number, ndcY: number) => {
    if (this.state.playing) return;
    const generation = ++this.cameraHandleDragGeneration;
    this.cameraHandleDragTime = this.state.currentTime;
    this.cameraHandleDragQueue = this.cameraHandleDragQueue.then(() => this.engine.cameraHandleDrag("start", ndcX, ndcY, handle)).then(() => {
      if (generation !== this.cameraHandleDragGeneration) return;
    });
  };
  moveCameraHandleInteraction = (ndcX: number, ndcY: number) => {
    const generation = this.cameraHandleDragGeneration;
    const time = this.cameraHandleDragTime;
    this.cameraHandleDragQueue = this.cameraHandleDragQueue.then(async () => {
      const transform = await this.engine.cameraHandleDrag("move", ndcX, ndcY);
      if (!transform || generation !== this.cameraHandleDragGeneration) return;
      const camera = evaluateCameraAtTime(this.state.background.scene, time);
      this.writeCameraAtTime({ ...camera, position: transform.position, target: transform.target }, time);
    });
  };
  finishCameraHandleInteraction = (ndcX: number, ndcY: number, applyTransform = true) => {
    const generation = this.cameraHandleDragGeneration;
    const time = this.cameraHandleDragTime;
    this.cameraHandleDragQueue = this.cameraHandleDragQueue.then(async () => {
      const transform = await this.engine.cameraHandleDrag("end", ndcX, ndcY);
      if (generation !== this.cameraHandleDragGeneration) return;
      if (transform && applyTransform) {
        const camera = evaluateCameraAtTime(this.state.background.scene, time);
        this.writeCameraAtTime({ ...camera, position: transform.position, target: transform.target }, time);
      }
      if (applyTransform) this.finishCameraInteraction();
    });
  };
  private writeCameraAtTime(camera: CameraSettings, time: number) {
    const scene = this.state.background.scene;
    const keyframes = (scene.keyframes ?? []).map((keyframe) => ({ ...keyframe, easing: keyframe.easing ? { ...keyframe.easing } : undefined }));
    const tolerance = 0.5 / this.state.fps;
    const selectedCameraKeyframeIds: string[] = [];
    for (const [property, value] of cameraKeyframeValues(camera)) {
      const existingIndex = keyframes.findIndex((keyframe) => keyframe.property === property && Math.abs(keyframe.time - time) <= tolerance);
      if (existingIndex >= 0) {
        keyframes[existingIndex] = { ...keyframes[existingIndex], time, value };
        selectedCameraKeyframeIds.push(keyframes[existingIndex].id);
      } else {
        const keyframe = { id: crypto.randomUUID(), property, time, value, interpolation: "smooth" as const, easing: undefined };
        keyframes.push(keyframe);
        selectedCameraKeyframeIds.push(keyframe.id);
      }
    }
    keyframes.sort((left, right) => left.time - right.time || left.property.localeCompare(right.property));
    this.update({
      background: { ...this.state.background, scene: { ...scene, keyframes } },
      selectedCameraKeyframeIds,
      selectedClipId: null,
      selectedClipIds: [],
      selectedAssetId: null,
      backgroundSelected: false,
    });
    this.renderPreview(false);
  }
  finishCameraInteraction = () => {
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };
  setPreviewTransformHandles = (clipId?: string) => this.engine.setTransformHandles(clipId);
  setCameraHandles = (visible: boolean) => this.engine.setCameraHandles(visible);

  setLayout = (patch: Partial<EditorLayout>, persist = false) => {
    const layout = { ...this.state.layout, ...patch };
    this.update({ layout });
    if (persist) {
      try { localStorage.setItem("gfxutl:layout", JSON.stringify(layout)); } catch { /* Storage may be blocked. */ }
    }
  };

  resetLayout = (key?: keyof EditorLayout) => {
    const layout = key ? { ...this.state.layout, [key]: defaultLayout[key] } : defaultLayout;
    this.update({ layout });
    try { localStorage.setItem("gfxutl:layout", JSON.stringify(layout)); } catch { /* Storage may be blocked. */ }
  };

  moveClip = (id: string, start: number, y: number) => {
    const anchor = this.state.clips.find((clip) => clip.id === id);
    if (!anchor || anchor.locked) return;
    const selectedIds = this.state.selectedClipIds.includes(id) ? this.state.selectedClipIds : [id];
    const movingIds = timelineGroupDescendants(this.state.clips, selectedIds);
    for (const clip of this.state.clips) if (clip.locked) movingIds.delete(clip.id);
    if (!movingIds.size) return;
    const deltaStart = Math.max(0, start) - anchor.start;
    const deltaY = Math.max(0, y) - anchor.y;
    const minimumStart = Math.min(...this.state.clips.filter((clip) => movingIds.has(clip.id)).map((clip) => clip.start));
    const minimumY = Math.min(...this.state.clips.filter((clip) => movingIds.has(clip.id)).map((clip) => clip.y));
    const safeDeltaStart = Math.max(deltaStart, -minimumStart);
    const safeDeltaY = Math.max(deltaY, -minimumY);
    const proposed = this.state.clips.map((clip) => {
      if (!movingIds.has(clip.id)) return clip;
      const nextStart = clip.start + safeDeltaStart;
      const nextY = clip.y + safeDeltaY;
      return { ...clip, start: nextStart, y: nextY };
    });
    if (hasGroupBoundaryCrossing(proposed)) return;
    const clips = assignTimelineGroups(proposed);
    this.update({ clips, selectedClipId: id, selectedClipIds: selectedIds });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  };

  nudgeSelectedClips = (frames: number) => {
    const selectedIds = this.state.selectedClipIds.length
      ? this.state.selectedClipIds
      : this.state.selectedClipId ? [this.state.selectedClipId] : [];
    if (!selectedIds.length || !frames) return;
    const movingIds = timelineGroupDescendants(this.state.clips, selectedIds);
    const selected = this.state.clips.filter((clip) => movingIds.has(clip.id) && !clip.locked);
    if (!selected.length) return;
    const requestedDelta = frames / this.state.fps;
    const safeDelta = Math.max(requestedDelta, -Math.min(...selected.map((clip) => clip.start)));
    if (!safeDelta) return;
    const proposed = this.state.clips.map((clip) => {
      if (!movingIds.has(clip.id) || clip.locked) return clip;
      const start = Math.max(0, clip.start + safeDelta);
      return { ...clip, start };
    });
    if (hasGroupBoundaryCrossing(proposed)) return;
    const clips = assignTimelineGroups(proposed);
    this.update({ clips });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  };

  resizeStaticClip = (id: string, start: number, duration: number) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip || clip.locked) return;
    const asset = clip.assetId ? this.state.assets.find((item) => item.id === clip.assetId) : undefined;
    const minimumDuration = 1 / this.state.fps;
    const requestedStart = Math.max(0, start);
    const oldEnd = clip.start + clip.duration;
    const requestedEnd = requestedStart + Math.max(minimumDuration, duration);
    const isLeftTrim = Math.abs(requestedEnd - oldEnd) < minimumDuration / 2 && Math.abs(requestedStart - clip.start) >= minimumDuration / 2;
    const speed = Math.max(0.01, (clip.speed ?? 100) / 100);
    let nextStart = requestedStart;
    let nextOffset = clip.offset;
    if (isLeftTrim && asset && asset.kind !== "image") {
      const delta = requestedStart - clip.start;
      nextOffset = Math.max(0, clip.offset + delta * speed);
      // A left trim cannot expose media before source time zero.
      if (nextOffset === 0 && clip.offset + delta * speed < 0) nextStart = clip.start - clip.offset / speed;
    }
    let nextDuration = Math.max(minimumDuration, isLeftTrim ? oldEnd - nextStart : duration);
    if (asset && asset.kind !== "image" && asset.duration > 0) {
      nextDuration = Math.min(nextDuration, Math.max(minimumDuration, (asset.duration - nextOffset) / speed));
    }
    const proposed = this.state.clips.map((item) => item.id === id ? { ...item, start: nextStart, duration: nextDuration, offset: nextOffset } : item);
    if (hasGroupBoundaryCrossing(proposed)) return;
    this.update({
      clips: assignTimelineGroups(proposed),
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  };

  resizeTimelineGroup = (id: string, start: number, y: number, duration: number, height: number) => {
    const group = this.state.clips.find((clip) => clip.id === id && clip.kind === "group");
    if (!group || group.locked) return;
    const nextStart = Math.max(0, start);
    const nextY = Math.max(0, y);
    const nextDuration = Math.max(1 / this.state.fps, duration);
    const nextHeight = Math.max(MIN_GROUP_HEIGHT, height);
    const proposed = this.state.clips.map((clip) => clip.id === id
      ? { ...clip, start: nextStart, y: nextY, duration: nextDuration, groupHeight: nextHeight }
      : clip);
    if (hasGroupBoundaryCrossing(proposed)) return;
    this.update({
      clips: assignTimelineGroups(proposed),
    });
    this.schedulePersistence();
  };

  translatePreviewClip = (id: string, deltaX: number, deltaY: number, transient = false) => {
    if (!deltaX && !deltaY) return;
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip || clip.kind === "audio" || clip.locked) return;
    const clips = this.state.clips.map((item) => item.id === id ? {
      ...item,
      positionX: (item.positionX ?? 0) + deltaX,
      positionY: (item.positionY ?? 0) + deltaY,
      keyframes: item.keyframes?.map((keyframe) => keyframe.property === "positionX"
        ? { ...keyframe, value: keyframe.value + deltaX }
        : keyframe.property === "positionY" ? { ...keyframe, value: keyframe.value + deltaY } : keyframe),
    } : item);
    this.update({ clips, selectedClipId: id, selectedClipIds: [id], selectedCameraKeyframeIds: [], backgroundSelected: false });
    if (!transient) {
      this.invalidatePreviewCache();
      this.schedulePersistence();
    }
    this.renderPreview(false);
  };

  finishPreviewInteraction = () => {
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  arrangePreviewSelection = (placement: "front" | "forward" | "backward" | "back") => {
    const selected = new Set(this.state.selectedClipIds);
    const ordered = orderedVisualClips(this.state.clips).filter((clip) => clip.kind !== "audio");
    if (!ordered.some((clip) => selected.has(clip.id))) return;
    let arranged = [...ordered];
    if (placement === "front") {
      arranged = [...arranged.filter((clip) => !selected.has(clip.id)), ...arranged.filter((clip) => selected.has(clip.id))];
    } else if (placement === "back") {
      arranged = [...arranged.filter((clip) => selected.has(clip.id)), ...arranged.filter((clip) => !selected.has(clip.id))];
    } else if (placement === "forward") {
      for (let index = arranged.length - 2; index >= 0; index -= 1) {
        if (selected.has(arranged[index].id) && !selected.has(arranged[index + 1].id)) {
          [arranged[index], arranged[index + 1]] = [arranged[index + 1], arranged[index]];
        }
      }
    } else {
      for (let index = 1; index < arranged.length; index += 1) {
        if (selected.has(arranged[index].id) && !selected.has(arranged[index - 1].id)) {
          [arranged[index], arranged[index - 1]] = [arranged[index - 1], arranged[index]];
        }
      }
    }
    if (arranged.every((clip, index) => clip.id === ordered[index].id)) { this.closeContextMenu(); return; }
    const stackOrder = new Map(arranged.map((clip, index) => [clip.id, index]));
    this.update({
      clips: this.state.clips.map((clip) => stackOrder.has(clip.id) ? { ...clip, stackOrder: stackOrder.get(clip.id) } : clip),
      contextMenu: null,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  centerPreviewSelection = (axis: "both" | "vertical" | "horizontal") => {
    const selected = new Set(this.state.selectedClipIds);
    const centerX = axis === "both" || axis === "horizontal";
    const centerY = axis === "both" || axis === "vertical";
    let changed = false;
    const clips = this.state.clips.map((clip) => {
      if (!selected.has(clip.id) || clip.kind === "audio" || clip.kind === "group") return clip;
      const deltaX = centerX ? -evaluateClipNumber(clip, "positionX", this.state.currentTime, clip.positionX ?? 0) : 0;
      const deltaY = centerY ? -evaluateClipNumber(clip, "positionY", this.state.currentTime, clip.positionY ?? 0) : 0;
      if (!deltaX && !deltaY) return clip;
      changed = true;
      return {
        ...clip,
        positionX: (clip.positionX ?? 0) + deltaX,
        positionY: (clip.positionY ?? 0) + deltaY,
        keyframes: clip.keyframes?.map((keyframe) => keyframe.property === "positionX" && centerX
          ? { ...keyframe, value: keyframe.value + deltaX }
          : keyframe.property === "positionY" && centerY ? { ...keyframe, value: keyframe.value + deltaY } : keyframe),
      };
    });
    if (!changed) { this.closeContextMenu(); return; }
    this.update({ clips, contextMenu: null });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  updateClip = (id: string, patch: Partial<import("./types").TimelineClip>) => {
    const current = this.state.clips.find((clip) => clip.id === id);
    if (!current) return;
    const stateOnly = Object.keys(patch).every((key) => key === "locked" || key === "muted" || key === "solo" || key === "visible");
    if (current.locked && !stateOnly) return;
    if (this.state.settings.autoKeyEnabled) {
      const localTime = Math.max(0, Math.min(current.duration, this.state.currentTime - current.start));
      const tolerance = 0.5 / this.state.fps;
      const autoKeyProperties = new Set(["positionX", "positionY", "positionZ", "scale", "scaleX", "scaleY", "rotation", "rotationX", "rotationY", "opacity", "cropLeft", "cropRight", "cropTop", "cropBottom", "volume", "pan", "speed", "fontSize", "letterSpacing", "textDepth", "textOutlineWidth", "instanceCount", "instanceSpacing"]);
      const numeric = Object.entries(patch).filter(([key, value]) => autoKeyProperties.has(key) && typeof value === "number") as Array<[KeyframeProperty, number]>;
      if (numeric.length) {
        const keyframes = [...(current.keyframes ?? [])];
        for (const [property, value] of numeric) {
          const index = keyframes.findIndex((keyframe) => keyframe.property === property && Math.abs(keyframe.time - localTime) <= tolerance);
          if (index >= 0) keyframes[index] = { ...keyframes[index], time: localTime, value };
          else keyframes.push({ id: crypto.randomUUID(), property, time: localTime, value, interpolation: "smooth" });
        }
        patch = { ...patch, keyframes: keyframes.sort((a, b) => a.time - b.time) };
      }
    }
    let proposed = this.state.clips.map((clip) => clip.id === id ? { ...clip, ...patch } : clip);
    if (patch.speed !== undefined && current.kind !== "title" && current.kind !== "object" && (patch.ripple ?? current.ripple ?? true)) {
      const oldSpeed = Math.max(1, current.speed ?? 100);
      const newSpeed = Math.max(1, patch.speed);
      const duration = Math.max(1 / this.state.fps, current.duration * oldSpeed / newSpeed);
      const delta = duration - current.duration;
      const oldEnd = current.start + current.duration;
      const currentBottom = current.y + 46;
      proposed = proposed.map((clip) => {
        if (clip.id === id) return { ...clip, duration, ripple: true };
        const verticallyRelated = clip.y < currentBottom && clip.y + (clip.groupHeight ?? 46) > current.y;
        return verticallyRelated && clip.start >= oldEnd - 0.5 / this.state.fps ? { ...clip, start: Math.max(0, clip.start + delta) } : clip;
      });
    }
    if (hasGroupBoundaryCrossing(proposed)) return;
    this.update({ clips: assignTimelineGroups(proposed) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, "start" in patch || "duration" in patch || "offset" in patch || "speed" in patch);
  };

  updateAudioProcessing = (id: string, patch: Partial<AudioProcessingSpec>) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip) return;
    this.updateClip(id, { audioProcessing: { ...resolveAudioProcessing(clip.audioProcessing), ...patch } });
    if (this.state.playing && "reverbDecay" in patch) this.syncAudioPlayback(true, true);
  };

  addClipPropertyAction = (id: string, kind: ClipPropertyActionKind) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip || !applicableClipActionKinds(clip).includes(kind)) return;
    const actions = resolveClipPropertyActions(clip);
    if (actions.some((action) => action.kind === kind)) return;
    this.updateClip(id, {
      ...resetPatchForClipAction(kind),
      ...(kind === "colorGrading" ? { colorGrading: resolveColorGrading() } : {}),
      propertyActions: [...actions, { id: crypto.randomUUID(), kind }],
    });
  };

  removeClipPropertyAction = (id: string, actionId: string) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip) return;
    const actions = resolveClipPropertyActions(clip);
    const action = actions.find((item) => item.id === actionId);
    if (!action) return;
    this.updateClip(id, {
      ...resetPatchForClipAction(action.kind),
      ...(action.kind === "colorGrading" ? { keyframes: (clip.keyframes ?? []).filter((keyframe) => !keyframe.property.startsWith("colorGrading.")) } : {}),
      ...(action.kind === "effects" ? { keyframes: (clip.keyframes ?? []).filter((keyframe) => !keyframe.property.startsWith("effect.")) } : {}),
      propertyActions: actions.filter((item) => item.id !== actionId),
    });
  };

  moveClipPropertyAction = (id: string, actionId: string, direction: -1 | 1) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip) return;
    const actions = resolveClipPropertyActions(clip);
    const index = actions.findIndex((item) => item.id === actionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= actions.length) return;
    [actions[index], actions[target]] = [actions[target], actions[index]];
    this.updateClip(id, { propertyActions: actions });
  };

  private removeClipIds(ids: ReadonlySet<string>) {
    ids = new Set([...ids].filter((id) => !this.state.clips.find((clip) => clip.id === id)?.locked));
    if (!ids.size) return;
    const selectedClipIds = this.state.selectedClipIds.filter((item) => !ids.has(item));
    const clips = assignTimelineGroups(this.state.clips
      .filter((clip) => !ids.has(clip.id))
      .map((clip) => clip.parentId && ids.has(clip.parentId) ? { ...clip, parentId: undefined } : clip));
    const selectedClipId = this.state.selectedClipId && ids.has(this.state.selectedClipId) ? selectedClipIds.at(-1) ?? null : this.state.selectedClipId;
    this.update({
      clips,
      selectedClipId,
      selectedClipIds,
      selectedAssetId: clips.find((clip) => clip.id === selectedClipId)?.assetId ?? null,
      previewClipTabs: this.state.previewClipTabs.filter((clipId) => !ids.has(clipId)),
      activePreviewClipId: this.state.activePreviewClipId && ids.has(this.state.activePreviewClipId) ? null : this.state.activePreviewClipId,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  }

  removeClip = (id: string) => {
    this.removeClipIds(timelineGroupDescendants(this.state.clips, [id]));
  };

  removeSelection = () => {
    const selected = this.state.selectedClipIds.length ? this.state.selectedClipIds : this.state.selectedClipId ? [this.state.selectedClipId] : [];
    this.removeClipIds(timelineGroupDescendants(this.state.clips, selected));
  };

  selectAllClips = () => {
    const ids = this.state.clips.map((clip) => clip.id);
    this.selectClips(ids);
  };

  private duplicateClips = (sourceIds: ReadonlySet<string>, startOffset: number, yOffset: number) => {
    const sources = this.state.clips.filter((clip) => sourceIds.has(clip.id));
    if (!sources.length) return new Map<string, string>();
    const idMap = new Map(sources.map((source) => [source.id, crypto.randomUUID()]));
    const copies = sources.map((source) => {
      const id = idMap.get(source.id)!;
      const copy = structuredClone(source);
      const effectIdMap = new Map((copy.effects ?? []).map((effect) => [effect.id, crypto.randomUUID()]));
      return {
        ...copy,
        id,
        name: `${source.name} ${t("のコピー")}`,
        start: source.start + startOffset,
        y: source.y + yOffset,
        geometry: source.geometry ? { ...copy.geometry!, id: `${id}:geometry` } : undefined,
        groupId: source.groupId ? idMap.get(source.groupId) : undefined,
        parentId: source.parentId ? idMap.get(source.parentId) ?? source.parentId : undefined,
        propertyActions: copy.propertyActions?.map((action) => ({ ...action, id: crypto.randomUUID() })),
        effects: copy.effects?.map((effect) => ({ ...effect, id: effectIdMap.get(effect.id)! })),
        masks: copy.masks?.map((mask) => ({ ...mask, id: crypto.randomUUID() })),
        keyframes: copy.keyframes?.map((keyframe) => {
          const match = keyframe.property.match(/^effect\.([^.]+)\.(.+)$/);
          const mappedEffectId = match ? effectIdMap.get(match[1]) : undefined;
          return { ...keyframe, id: crypto.randomUUID(), property: mappedEffectId ? `effect.${mappedEffectId}.${match![2]}` as KeyframeProperty : keyframe.property };
        }),
      } satisfies TimelineClip;
    });
    const clips = assignTimelineGroups([...this.state.clips, ...copies]);
    this.update({ clips, selectedClipId: copies.at(-1)?.id ?? null, selectedClipIds: copies.map((clip) => clip.id) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    return idMap;
  };

  duplicateSelection = () => {
    const sourceIds = timelineGroupDescendants(this.state.clips, this.state.selectedClipIds.length ? this.state.selectedClipIds : this.state.selectedClipId ? [this.state.selectedClipId] : []);
    this.duplicateClips(sourceIds, 1 / this.state.fps, 12);
  };

  duplicateSelectionForDrag = (id: string) => {
    const sourceIds = timelineGroupDescendants(this.state.clips, this.state.selectedClipIds.includes(id) ? this.state.selectedClipIds : [id]);
    return this.duplicateClips(sourceIds, 0, 0).get(id) ?? null;
  };

  private addTextObjectWithMode = (textMode: "2d" | "3d", placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const stagger = this.objectStagger(start, placement?.positionX ?? 0, placement?.positionY ?? 0);
    const is2D = textMode === "2d";
    const clip: TimelineClip = {
      id, name: `${textMode.toUpperCase()} Text`, text: "Text", textMode, kind: "title", color: is2D ? "#5f8fb5" : "#9169b6", start,
      y: Math.max(0, placement?.timelineY ?? 32), duration: 5, offset: 0,
      positionX: (placement?.positionX ?? 0) + stagger.x, positionY: (placement?.positionY ?? 0) + stagger.y,
      positionZ: 0,
      scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100, fontSize: 1.2, letterSpacing: 0,
      textDepth: is2D ? undefined : 0.12, textColor: 0x202020, textOutlineColor: 0xffffff,
      textOutlineWidth: is2D ? 0 : 0.02, fontFamily: is2D ? "sans-serif" : "Helvetiker",
    };
    this.insertObjectClip(clip);
  };

  /** Backwards-compatible API: the original Text object is now explicitly 3D Text. */
  addTextObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => this.addText3DObject(placement);

  addText3DObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => this.addTextObjectWithMode("3d", placement);

  addText2DObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => this.addTextObjectWithMode("2d", placement);

  addGroupObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const source: TimelineClip = {
      id,
      name: t("グループ"),
      kind: "group",
      color: "#4f6880",
      start,
      y: Math.max(0, placement?.timelineY ?? 40),
      duration: 8,
      offset: 0,
      groupHeight: 156,
    };
    const group = expandGroupToValidBoundary(this.state.clips, source);
    const clips = assignTimelineGroups([...this.state.clips, group]);
    this.update({
      clips,
      selectedClipId: id,
      selectedClipIds: [id],
      selectedAssetId: null,
      currentTime: start,
      contextMenu: null,
    });
    this.schedulePersistence();
  };

  addFilterObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    let clip: TimelineClip = {
      id,
      name: t("フィルター"),
      kind: "filter",
      color: "#8b65a5",
      start,
      y: Math.max(0, placement?.timelineY ?? 32),
      duration: 5,
      offset: 0,
      visible: true,
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      scale: 100,
      scaleX: 100,
      scaleY: 100,
      rotation: 0,
      rotationX: 0,
      rotationY: 0,
      opacity: 100,
      effects: [],
      keyframes: [],
      propertyActions: [{ id: crypto.randomUUID(), kind: "transform" }, { id: crypto.randomUUID(), kind: "effects" }],
    };
    clip = placeTimelineClip(this.state.clips, clip);
    this.update({
      clips: assignTimelineGroups([...this.state.clips, clip]),
      selectedClipId: id,
      selectedClipIds: [id],
      selectedAssetId: null,
      activePreviewClipId: null,
      activePreviewView: "camera",
      currentTime: start,
      contextMenu: null,
      backgroundSelected: false,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  addParticleObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const clip: TimelineClip = {
      id, name: t("GPUパーティクル"), kind: "object", color: "#6ca6d9", start,
      y: Math.max(0, placement?.timelineY ?? 92), duration: 5, offset: 0,
      positionX: placement?.positionX ?? 0, positionY: placement?.positionY ?? 0, positionZ: 0,
      scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100,
      particleSystem: { count: 512, size: 0.06, spread: 3, speed: 1, color: 0x6ca6d9 },
    };
    this.insertObjectClip(clip);
  };

  addGeometryObject = (kind: GeometryKind, placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => {
    if (kind === "text") return this.addTextObject(placement);
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const stagger = this.objectStagger(start, placement?.positionX ?? 0, placement?.positionY ?? 0);
    const names: Partial<Record<GeometryKind, string>> = { box: t("立方体"), sphere: t("球体"), plane: t("平面"), torus: t("トーラス"), shape: t("シェイプ") };
    const args: Partial<Record<GeometryKind, number[]>> = { box: [2, 2, 0.5], sphere: [1.25, 32, 20], plane: [2.5, 2.5], torus: [1, 0.32, 16, 48] };
    const clip: TimelineClip = {
      id, name: names[kind] ?? kind, kind: "object", color: "#4f83a8", start,
      y: Math.max(0, placement?.timelineY ?? 92), duration: 5, offset: 0,
      positionX: (placement?.positionX ?? 0) + stagger.x, positionY: (placement?.positionY ?? 0) + stagger.y,
      positionZ: 0,
      scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: kind === "shape" ? 0 : 18, rotationY: kind === "shape" ? 0 : -24, opacity: 100, textColor: 0x3d73a0,
      material: { kind: kind === "shape" ? "basic" : "standard", color: 0x3d73a0, roughness: 0.55, metalness: 0.08, side: "double" }, castShadow: kind !== "shape", receiveShadow: kind !== "shape",
      geometry: { id: `${id}:geometry`, kind, args: args[kind], ...(kind === "shape" ? { points2D: [[-1.5, -1], [1.5, -1], [1.5, 1], [-1.5, 1]] as Array<[number, number]> } : {}) },
    };
    this.insertObjectClip(clip);
  };

  private objectStagger(time: number, x: number, y: number) {
    const overlapping = this.state.clips.filter((clip) => (clip.kind === "title" || clip.kind === "object") && time >= clip.start && time < clip.start + clip.duration && Math.abs((clip.positionX ?? 0) - x) < 1 && Math.abs((clip.positionY ?? 0) - y) < 1).length;
    return { x: overlapping * 160, y: overlapping * 90 };
  }

  private snapTime(time: number) {
    const safe = Math.max(0, time);
    return this.state.snapEnabled ? Math.round(safe * this.state.fps) / this.state.fps : safe;
  }

  private insertObjectClip(clip: TimelineClip) {
    clip = placeTimelineClip(this.state.clips, clip);
    this.update({
      clips: assignTimelineGroups([...this.state.clips, clip]), selectedClipId: clip.id, selectedClipIds: [clip.id], selectedAssetId: null,
      previewClipTabs: this.state.previewClipTabs.includes(clip.id) ? this.state.previewClipTabs : [...this.state.previewClipTabs, clip.id],
      activePreviewClipId: clip.id,
      currentTime: clip.start, contextMenu: null,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  }

  setTextFont = async (clipId: string, fontId: string) => {
    this.fontVariationUpdates.set(clipId, (this.fontVariationUpdates.get(clipId) ?? 0) + 1);
    const entry = this.fontEntries.get(fontId);
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (entry) {
      try {
        await this.registerFontVariant(fontId);
      } catch {
        this.toast(t("フォントデータを読み込めませんでした"));
        return;
      }
    }
    this.updateClip(clipId, { fontId: entry ? fontId : undefined, fontFamily: entry?.family ?? (clip?.textMode === "2d" ? "sans-serif" : "Helvetiker"), fontVariations: undefined });
  };

  setTextFontVariations = async (clipId: string, variations: FontVariationSettings) => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (!clip?.fontId) return;
    const normalized = normalizeFontVariations(variations);
    const revision = (this.fontVariationUpdates.get(clipId) ?? 0) + 1;
    this.fontVariationUpdates.set(clipId, revision);
    try {
      const isText2D = clip.textMode === "2d";
      await this.registerFontVariant(
        clip.fontId,
        isText2D ? normalized : undefined,
        isText2D ? timelineFontId({ ...clip, fontVariations: normalized }) : clip.fontId,
      );
      if (this.fontVariationUpdates.get(clipId) === revision) this.updateClip(clipId, { fontVariations: normalized });
    } catch {
      if (this.fontVariationUpdates.get(clipId) === revision) this.toast(t("フォントデータを読み込めませんでした"));
    }
  };

  loadFontPreview = (fontId: string, variations?: FontVariationSettings) => {
    const previewId = fontVariationId(fontId, variations);
    const cached = this.fontPreviewLoads.get(previewId);
    if (cached) return cached;
    const entry = this.fontEntries.get(fontId);
    if (!entry) return Promise.resolve(undefined);
    const family = `GfxUtl Preview ${previewId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const pending = entry.blob()
      .then((blob) => blob.arrayBuffer())
      .then(async (buffer) => {
        const variationSettings = fontVariationCss(variations);
        const face = new FontFace(family, buffer, variationSettings ? { variationSettings } : undefined);
        await face.load();
        document.fonts.add(face);
        if (variationSettings) {
          this.fontPreviewFaces.set(previewId, face);
          if (this.fontPreviewFaces.size > 64) {
            const oldest = this.fontPreviewFaces.keys().next().value;
            if (oldest) {
              const staleFace = this.fontPreviewFaces.get(oldest);
              if (staleFace) document.fonts.delete(staleFace);
              this.fontPreviewFaces.delete(oldest);
              this.fontPreviewLoads.delete(oldest);
            }
          }
        }
        return family;
      })
      .catch(() => {
        this.fontPreviewLoads.delete(previewId);
        return undefined;
      });
    this.fontPreviewLoads.set(previewId, pending);
    return pending;
  };

  loadFacetypeFont = (fontId: string, characters: string, variations?: FontVariationSettings) => {
    const characterSet = facetypeCharacterSet(characters);
    const cacheKey = `${fontId}\u0000${fontVariationKey(variations)}\u0000${characterSet}`;
    const cached = this.facetypeFontLoads.get(cacheKey);
    if (cached) return cached;
    const entry = this.fontEntries.get(fontId);
    if (!entry) return Promise.resolve(undefined);
    const pending = entry.blob()
      .then((blob) => blob.arrayBuffer())
      .then((buffer) => convertLocalFontWithFacetype(buffer, characterSet, variations))
      .catch(() => {
        this.facetypeFontLoads.delete(cacheKey);
        return undefined;
      });
    this.facetypeFontLoads.set(cacheKey, pending);
    if (this.facetypeFontLoads.size > 64) {
      const oldest = this.facetypeFontLoads.keys().next().value;
      if (oldest) this.facetypeFontLoads.delete(oldest);
    }
    return pending;
  };

  loadFontVariationAxes = (fontId: string) => {
    const cached = this.fontVariationAxisLoads.get(fontId);
    if (cached) return cached;
    const entry = this.fontEntries.get(fontId);
    if (!entry) return Promise.resolve([]);
    const pending = entry.blob()
      .then((blob) => blob.arrayBuffer())
      .then(readFontVariationAxes)
      .catch(() => {
        this.fontVariationAxisLoads.delete(fontId);
        return [];
      });
    this.fontVariationAxisLoads.set(fontId, pending);
    return pending;
  };

  loadRendererPlugin = async () => {
    const pickDirectory = window.showDirectoryPicker;
    if (!pickDirectory) {
      this.toast(t("このブラウザはディレクトリ選択に対応していません"));
      return;
    }
    let pendingPlugin: Awaited<ReturnType<typeof readRendererPluginPackage>> | undefined;
    try {
      const directory = await pickDirectory({ mode: "read" });
      const plugin = pendingPlugin = await readRendererPluginPackage(directory);
      this.pluginDirectories.set(plugin.id, directory);
      await savePluginDirectory(plugin.id, directory).catch(() => { /* The plugin remains active for this session. */ });
      this.update({ plugins: upsertPlugin(this.state.plugins, {
        id: plugin.id, name: plugin.name, version: plugin.version, entry: plugin.entry,
        status: "bundling", moduleCount: plugin.files.length,
      }) });
      const loaded = await this.engine.loadRendererPlugin(await bundleRendererPlugin(plugin));
      this.update({ plugins: upsertPlugin(this.state.plugins, loaded) });
      if (loaded.status === "active") this.toast(t("{name} を読み込みました", { name: loaded.name }));
      else this.toast(`${loaded.name}: ${loaded.error ?? t("プラグインを読み込めませんでした")}`);
    } catch (error) {
      if (pendingPlugin) this.update({ plugins: upsertPlugin(this.state.plugins, {
        id: pendingPlugin.id, name: pendingPlugin.name, version: pendingPlugin.version, entry: pendingPlugin.entry,
        status: "error", moduleCount: pendingPlugin.files.length,
        error: error instanceof Error ? error.message : t("プラグインを読み込めませんでした"),
      }) });
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? error.message : t("プラグインを読み込めませんでした"));
    }
  };

  reloadRendererPlugin = async (pluginId: string) => {
    const directory = this.pluginDirectories.get(pluginId);
    if (!directory) {
      this.toast(t("このプラグインのディレクトリをもう一度選択してください"));
      return;
    }
    try {
      const plugin = await readRendererPluginPackage(directory);
      this.update({ plugins: upsertPlugin(this.state.plugins, {
        id: pluginId, name: plugin.name, version: plugin.version, entry: plugin.entry,
        status: "bundling", moduleCount: plugin.files.length,
      }) });
      const loaded = await this.engine.loadRendererPlugin(await bundleRendererPlugin({ ...plugin, id: pluginId }));
      this.update({ plugins: upsertPlugin(this.state.plugins, loaded) });
      if (loaded.status === "active") this.toast(t("{name} を再読み込みしました", { name: loaded.name }));
    } catch (error) {
      const current = this.state.plugins.find((plugin) => plugin.id === pluginId);
      if (current) this.update({ plugins: upsertPlugin(this.state.plugins, { ...current, status: "error", error: error instanceof Error ? error.message : t("プラグインを再読み込みできませんでした") }) });
      this.toast(error instanceof Error ? error.message : t("プラグインを再読み込みできませんでした"));
    }
  };

  removeRendererPlugin = (pluginId: string) => {
    this.engine.unloadRendererPlugin(pluginId);
    this.pluginDirectories.delete(pluginId);
    void removePluginDirectory(pluginId).catch(() => undefined);
    this.update({ plugins: this.state.plugins.filter((plugin) => plugin.id !== pluginId) });
  };

  copySelection = async () => {
    const copiedIds = timelineGroupDescendants(this.state.clips, this.state.selectedClipIds);
    const clips = this.state.clips.filter((item) => copiedIds.has(item.id));
    if (!clips.length) return false;
    const payload: ClipboardPayload = { type: "gfxutl/timeline-object", version: 2, clips };
    this.memoryClipboard = payload;
    try { await navigator.clipboard?.writeText(JSON.stringify(payload)); } catch { /* In-memory fallback remains available. */ }
    this.toast(clips.length === 1 ? t("{name} をコピーしました", { name: clips[0].name }) : t("{count} 個のオブジェクトをコピーしました", { count: clips.length }));
    return true;
  };

  cutSelection = async () => {
    const ids = [...timelineGroupDescendants(this.state.clips, this.state.selectedClipIds)];
    if (!ids.length || !(await this.copySelection())) return;
    this.update({
      clips: assignTimelineGroups(this.state.clips.filter((clip) => !ids.includes(clip.id))),
      selectedClipId: null,
      selectedClipIds: [],
      selectedAssetId: null,
      previewClipTabs: this.state.previewClipTabs.filter((id) => !ids.includes(id)),
      activePreviewClipId: this.state.activePreviewClipId && ids.includes(this.state.activePreviewClipId) ? null : this.state.activePreviewClipId,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  pasteFromClipboard = async () => {
    let payload = this.memoryClipboard;
    try {
      const text = await navigator.clipboard?.readText();
      if (text) {
        const parsed = JSON.parse(text) as Partial<ClipboardPayload>;
        if (parsed.type === "gfxutl/timeline-object" && parsed.version === 2 && parsed.clips?.length) payload = parsed as ClipboardPayload;
      }
    } catch { /* Clipboard permission may be unavailable; use the session fallback. */ }
    if (!payload) { this.toast(t("貼り付け可能なGfxUtlオブジェクトがありません")); return; }
    const menu = this.state.contextMenu;
    const minStart = Math.min(...payload.clips.map((clip) => clip.start));
    const minY = Math.min(...payload.clips.map((clip) => clip.y));
    const targetStart = this.snapTime(menu?.time ?? this.state.currentTime);
    const targetY = Math.max(0, menu?.timelineY ?? minY + 24);
    const idMap = new Map(payload.clips.map((source) => [source.id, crypto.randomUUID()]));
    let pasted = payload.clips.map((source) => {
      const id = idMap.get(source.id)!;
      return {
        ...structuredClone(source), id,
        geometry: source.geometry ? { ...structuredClone(source.geometry), id: `${id}:geometry` } : undefined,
        groupId: source.groupId ? idMap.get(source.groupId) : undefined,
        start: targetStart + source.start - minStart,
        y: targetY + source.y - minY,
        positionX: menu?.scope === "preview" ? menu.positionX : source.positionX,
        positionY: menu?.scope === "preview" ? menu.positionY : source.positionY,
      } satisfies TimelineClip;
    });
    // Keep a pasted block intact, moving it down until it no longer straddles
    // any existing container boundary.
    for (let attempt = 0; attempt < 100 && hasGroupBoundaryCrossing([...this.state.clips, ...pasted]); attempt += 1) {
      pasted = pasted.map((clip) => ({ ...clip, y: clip.y + 40 }));
    }
    if (hasGroupBoundaryCrossing([...this.state.clips, ...pasted])) {
      const existingBottom = Math.max(0, ...this.state.clips.filter((clip) => clip.kind === "group").map((clip) => clip.y + (clip.groupHeight ?? 156)));
      const pastedTop = Math.min(...pasted.map((clip) => clip.y));
      pasted = pasted.map((clip) => ({ ...clip, y: clip.y + existingBottom + 40 - pastedTop }));
    }
    const clips = assignTimelineGroups([...this.state.clips, ...pasted]);
    this.update({
      clips, selectedClipId: pasted.at(-1)?.id ?? null, selectedClipIds: pasted.map((clip) => clip.id), contextMenu: null,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    this.toast(pasted.length === 1 ? t("{name} を貼り付けました", { name: pasted[0].name }) : t("{count} 個のオブジェクトを貼り付けました", { count: pasted.length }));
  };

  splitSelectionAt = (time = this.state.contextMenu?.time ?? this.state.currentTime) => {
    const frame = 1 / this.state.fps;
    const selected = new Set(this.state.selectedClipIds);
    const created: TimelineClip[] = [];
    const clips = this.state.clips.flatMap((clip) => {
      if (clip.kind === "group" || clip.locked || !selected.has(clip.id) || time <= clip.start + frame / 2 || time >= clip.start + clip.duration - frame / 2) return [clip];
      const leftDuration = time - clip.start;
      const id = crypto.randomUUID();
      const right: TimelineClip = {
        ...structuredClone(clip), id, start: time, duration: clip.duration - leftDuration,
        offset: clip.offset + leftDuration * ((clip.speed ?? 100) / 100),
        geometry: clip.geometry ? { ...structuredClone(clip.geometry), id: `${id}:geometry` } : undefined,
      };
      created.push(right);
      return [{ ...clip, duration: leftDuration }, right];
    });
    if (!created.length) { this.toast(t("カット位置がクリップの範囲外です")); return; }
    this.update({ clips, selectedClipId: created.at(-1)!.id, selectedClipIds: created.map((clip) => clip.id), contextMenu: null });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  addMask = (clipId: string, shape: ClipMask["shape"] = "rectangle") => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (!clip || clip.kind !== "video") return;
    const mask: ClipMask = { id: crypto.randomUUID(), name: t("マスク {number}", { number: (clip.masks?.length ?? 0) + 1 }), enabled: true, shape, mode: "add", inverted: false, x: 50, y: 50, width: 70, height: 70, feather: 0, opacity: 100 };
    this.updateClip(clipId, { masks: [...(clip.masks ?? []), mask] });
  };

  updateMask = (clipId: string, maskId: string, patch: Partial<ClipMask>) => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (clip) this.updateClip(clipId, { masks: (clip.masks ?? []).map((mask) => mask.id === maskId ? { ...mask, ...patch } : mask) });
  };

  removeMask = (clipId: string, maskId: string) => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (clip) this.updateClip(clipId, { masks: (clip.masks ?? []).filter((mask) => mask.id !== maskId) });
  };

  addEffect = (clipId: string, kind: ClipEffectKind) => {
    const effect = createEffect(kind);
    this.update({ clips: this.state.clips.map((clip) => clip.id === clipId ? { ...clip, effects: [...(clip.effects ?? []), effect] } : clip) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  updateEffect = (clipId: string, effectId: string, patch: Partial<ClipEffect>) => {
    this.update({ clips: this.state.clips.map((clip) => clip.id === clipId ? { ...clip, effects: (clip.effects ?? []).map((effect) => effect.id === effectId ? { ...effect, ...patch } : effect) } : clip) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  removeEffect = (clipId: string, effectId: string) => {
    this.update({ clips: this.state.clips.map((clip) => clip.id === clipId ? {
      ...clip,
      effects: (clip.effects ?? []).filter((effect) => effect.id !== effectId),
      keyframes: (clip.keyframes ?? []).filter((keyframe) => !keyframe.property.startsWith(`effect.${effectId}.`)),
    } : clip) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  moveEffect = (clipId: string, effectId: string, direction: -1 | 1) => {
    this.update({ clips: this.state.clips.map((clip) => {
      if (clip.id !== clipId) return clip;
      const effects = [...(clip.effects ?? [])];
      const index = effects.findIndex((effect) => effect.id === effectId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= effects.length) return clip;
      [effects[index], effects[target]] = [effects[target], effects[index]];
      return { ...clip, effects };
    }) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  addKeyframe = (clipId: string, property: KeyframeProperty, value: number, interpolation: ClipKeyframe["interpolation"] = "smooth") => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (!clip) return;
    const time = Math.max(0, Math.min(clip.duration, this.state.currentTime - clip.start));
    const tolerance = 0.5 / this.state.fps;
    let keyframes: ClipKeyframe[] = (clip.keyframes ?? []).map((keyframe) => ({ ...keyframe, easing: keyframe.easing ? { ...keyframe.easing } : undefined }));
    const existing = keyframes.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - time) <= tolerance);
    if (existing) keyframes = keyframes.map((keyframe) => keyframe.id === existing.id ? { ...keyframe, value, interpolation, time } : keyframe);
    else keyframes.push({ id: crypto.randomUUID(), property, value, time, interpolation });
    keyframes.sort((a, b) => a.time - b.time || a.property.localeCompare(b.property));
    this.updateClip(clipId, { keyframes });
  };

  updateKeyframe = (clipId: string, keyframeId: string, patch: Partial<ClipKeyframe>) => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (!clip) return;
    this.updateClip(clipId, { keyframes: (clip.keyframes ?? []).map((keyframe) => keyframe.id === keyframeId ? { ...keyframe, ...patch } : keyframe).sort((a, b) => a.time - b.time) });
  };

  removeKeyframe = (clipId: string, keyframeId: string) => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (clip) this.updateClip(clipId, { keyframes: (clip.keyframes ?? []).filter((keyframe) => keyframe.id !== keyframeId) });
  };

  addAssetToTimeline = (assetId: string, start: number, y: number) => {
    const asset = this.state.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const duration = asset.kind === "image" || asset.kind === "model" ? Math.max(5, asset.duration || 0) : Math.max(0.1, asset.duration || 5);
    const nextStart = this.state.snapEnabled ? Math.round(Math.max(0, start) * this.state.fps) / this.state.fps : Math.max(0, start);
    const id = crypto.randomUUID();
    const clip = placeTimelineClip(this.state.clips, { id, assetId, y: Math.max(0, y), name: asset.name, start: nextStart, duration, offset: 0, color: asset.color, kind: asset.kind === "audio" ? "audio" : asset.kind === "model" ? "object" : "video", positionX: 0, positionY: 0, positionZ: 0, scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100, castShadow: true, receiveShadow: true });
    this.update({
      clips: assignTimelineGroups([...this.state.clips, clip]),
      selectedClipId: id,
      selectedClipIds: [id],
      previewClipTabs: this.state.previewClipTabs.includes(id) ? this.state.previewClipTabs : [...this.state.previewClipTabs, id],
      activePreviewClipId: id,
      currentTime: clip.start,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  exportVideo = async () => {
    if (this.state.exportStatus === "exporting") return;
    const settings = this.state.exportSettings;
    const extension = settings.format;
    const filename = `${settings.filename.trim() || "GfxUtl Export"}.${extension}`;
    let handle: FileSystemFileHandle | undefined;
    try {
      if (window.showSaveFilePicker) {
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: settings.format === "mp4" ? "MPEG-4 Video" : "WebM Video", accept: { [settings.format === "mp4" ? "video/mp4" : "video/webm"]: [`.${extension}`] } }],
        });
      }
      this.update({ exportStatus: "exporting", exportProgress: 0 });
      const result = await this.engine.exportVideo(settings, Math.max(1 / settings.fps, settings.endTime - settings.startTime), this.getRenderClips(), this.state.background.scene, this.state.settings.audioChannels);
      const blob = new Blob([result.buffer], { type: result.mimeType });
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      this.update({ exportStatus: "done", exportProgress: 1 });
      this.toast(t("{name} を書き出しました", { name: filename }));
    } catch (error) {
      if ((error as DOMException).name === "AbortError") { this.update({ exportStatus: "idle", exportProgress: 0 }); return; }
      this.update({ exportStatus: "error" });
      this.toast(error instanceof Error ? t("書き出し失敗: {message}", { message: error.message }) : t("書き出しに失敗しました"));
    }
  };

  cancelExport = () => {
    if (this.state.exportStatus !== "exporting") return;
    this.engine.cancelExport();
  };

  exportCurrentFrame = async () => {
    const filename = `${this.state.exportSettings.filename.trim() || "GfxUtl Frame"}-${Math.round(this.state.currentTime * this.state.fps).toString().padStart(6, "0")}.png`;
    try {
      let handle: FileSystemFileHandle | undefined;
      if (window.showSaveFilePicker) handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "PNG Image", accept: { "image/png": [".png"] } }] });
      const result = await this.engine.exportStill(this.state.exportSettings.width, this.state.exportSettings.height, this.state.currentTime, this.getRenderClips(), this.state.background.scene);
      const blob = new Blob([result.buffer], { type: result.mimeType });
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      this.toast(t("{name} を書き出しました", { name: filename }));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? t("静止画の書き出し失敗: {message}", { message: error.message }) : t("静止画を書き出せませんでした"));
    }
  };

  private toast(message: string) {
    this.update({ notice: message });
    window.setTimeout(() => {
      if (this.state.notice === message) this.update({ notice: null });
    }, 3200);
  }

  openModel = async () => {
    try {
      let file: File;
      let handle: FileSystemFileHandle | undefined;
      if (window.showOpenFilePicker) {
        [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: "glTF", accept: { "model/gltf-binary": [".glb"], "model/gltf+json": [".gltf"] } }] });
        file = await handle.getFile();
      } else {
        file = await this.openWithInput(".glb,.gltf,model/gltf-binary,model/gltf+json");
      }
      await this.importMediaFile(file, handle);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? t("3Dモデルを開けませんでした: {message}", { message: error.message }) : t("3Dモデルを開けませんでした"));
    }
  };

  openMedia = async () => {
    try {
      let file: File;
      let handle: FileSystemFileHandle | undefined;
      if (window.showOpenFilePicker) {
        [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: "Media", accept: { "video/*": [".mp4", ".mov", ".webm", ".mkv"], "audio/*": [".wav", ".mp3", ".aac", ".flac"], "image/*": [".png", ".jpg", ".jpeg", ".webp", ".hdr", ".exr"] } }],
        });
        file = await handle.getFile();
      } else {
        file = await this.openWithInput("video/*,audio/*,image/*,.hdr,.exr");
      }

      await this.importMediaFile(file, handle);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(t("メディアを開けませんでした"));
    }
  };

  importMediaFile = async (file: File, handle?: FileSystemFileHandle, sourcePath?: string) => {
    const kind = mediaKindForFile(file);
    if (!kind) {
      this.toast(t("{name} は対応していないファイルです", { name: file.name }));
      return null;
    }
    const existing = this.state.assets.find((asset) => sourcePath
      ? asset.sourcePath === sourcePath
      : asset.name === file.name && asset.size === file.size && asset.lastModified === file.lastModified);
    const id = existing?.id ?? crypto.randomUUID();
    const extension = file.name.split(".").pop()?.toLowerCase();
    const asset: MediaAsset = existing
      ? { ...existing, handle: handle ?? existing.handle, sourcePath: sourcePath ?? existing.sourcePath, fileStatus: "loading" }
      : {
          id, name: file.name, kind, duration: kind === "image" ? 0 : kind === "model" ? 5 : 10,
          size: file.size, lastModified: file.lastModified, sourcePath, color: mediaColor(kind), handle, fileStatus: "loading",
        };
    this.update({
      assets: existing ? this.state.assets.map((item) => item.id === id ? asset : item) : [...this.state.assets, asset],
      selectedAssetId: id, selectedClipId: null, selectedClipIds: [],
    });
    try {
      const info = await this.registerRuntimeFile(asset, file);
      // Waveforms are requested by the first visible thumbnail and persisted
      // afterwards; they are not part of the file-import critical path.
      const retainWaveform = kind === "audio" && existing?.size === file.size && existing.lastModified === file.lastModified && existing.waveformVersion === AUDIO_WAVEFORM_VERSION;
      const readyAsset = { ...asset, ...info, waveformPeaks: retainWaveform ? existing.waveformPeaks : undefined, waveformVersion: retainWaveform ? existing.waveformVersion : undefined, fileStatus: "ready" as const };
      this.update({ assets: this.state.assets.map((item) => item.id === id ? readyAsset : item) });
      this.renderPreview(true);
      if (handle) {
        const { assets: _assets, clips: _clips, ...project } = this.currentProjectDocument();
        await saveHandleProject(readyAsset, this.state.clips, project).catch(() => { /* Persistence failure must not invalidate a decoded asset. */ });
      }
      this.toast(t("{name} を読み込みました{extension}", { name: file.name, extension: extension ? ` · ${extension.toUpperCase()}` : "" }));
      return id;
    } catch (error) {
      this.update({ assets: this.state.assets.map((item) => item.id === id ? { ...item, fileStatus: "missing" } : item) });
      this.toast(error instanceof Error ? `${file.name}: ${error.message}` : t("{name} を読み込めませんでした", { name: file.name }));
      return null;
    }
  };

  stageExplorerFile = (sourcePath: string, file?: File, handle?: FileSystemFileHandle) => {
    this.explorerFiles.set(sourcePath, { file, handle });
  };

  loadTextureImageFile = async (assetId?: string, sourcePath?: string) => {
    let file: File | undefined;
    if (assetId) {
      const asset = this.state.assets.find((item) => item.id === assetId);
      if (!asset || asset.kind !== "image") return undefined;
      file = this.runtimeFiles.get(assetId)
        ?? (asset.sourcePath ? this.explorerFiles.get(asset.sourcePath)?.file : undefined)
        ?? await asset.handle?.getFile();
    } else if (sourcePath) {
      const source = this.explorerFiles.get(sourcePath);
      file = source?.file ?? await source?.handle?.getFile();
    }
    if (!file || !isTextureImageFile(file)) return undefined;
    return file;
  };

  addExplorerFileToTimeline = async (sourcePath: string, start: number, y: number) => {
    const existing = this.state.assets.find((asset) => asset.sourcePath === sourcePath);
    let assetId = existing?.fileStatus === "ready" ? existing.id : null;
    if (!assetId) {
      const source = this.explorerFiles.get(sourcePath);
      const file = source?.file ?? await source?.handle?.getFile();
      if (!file) return;
      assetId = await this.importMediaFile(file, source?.handle, sourcePath);
    }
    if (assetId) this.addAssetToTimeline(assetId, start, y);
  };

  private openWithInput(accept: string) {
    return new Promise<File>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = () => input.files?.[0] ? resolve(input.files[0]) : reject(new DOMException("No file", "AbortError"));
      input.click();
    });
  }

  loadFonts = async () => {
    void this.restoreGoogleFonts().catch(() => this.toast(t("Google Fontsの一覧を読み込めませんでした")));
    if (!window.queryLocalFonts) {
      this.toast(t("このブラウザはLocal Font Access APIに対応していません"));
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      this.fontCatalogRevision += 1;
      this.facetypeFontLoads.clear();
      this.fontVariationAxisLoads.clear();
      const unique = new Map<string, { info: FontFaceInfo; entry: FontEntry }>();
      for (const [fontId, entry] of this.fontEntries) if (entry.source === "local") this.fontEntries.delete(fontId);
      fonts.forEach((font) => {
        const info: FontFaceInfo = {
          postscriptName: font.postscriptName,
          fullName: font.fullName,
          family: font.family,
          style: font.style,
          source: "local",
        };
        unique.set(font.postscriptName, {
          info,
          entry: {
            ...info,
            source: "local",
            blob: async () => {
              const blob = await font.blob();
              await saveLocalFontData(info.postscriptName, blob).catch(() => { /* Font use must not depend on persistent storage. */ });
              return blob;
            },
          },
        });
      });
      const available = [...unique.values()].slice(0, 500);
      available.forEach(({ info, entry }) => this.fontEntries.set(info.postscriptName, entry));
      const catalog = available.map(({ info }) => info);
      await saveLocalFontCatalog(catalog).catch(() => { /* Fonts remain available for the current page session. */ });
      this.update({ fonts: mergeFontCatalog(this.state.fonts, catalog, "local") });
      await this.registerTimelineFonts();
      this.toast(t("{count} 個のローカルフォントを利用できます", { count: unique.size }));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(t("ローカルフォントへのアクセスが拒否されました"));
    }
  };

  private async restoreLocalFonts() {
    try {
      const revision = this.fontCatalogRevision;
      const fonts = (await loadLocalFontCatalog()).slice(0, 500).map((font) => ({ ...font, source: "local" as const }));
      if (!fonts.length || revision !== this.fontCatalogRevision) return;
      fonts.forEach((font) => this.fontEntries.set(font.postscriptName, {
        ...font,
        source: "local",
        blob: async () => {
          const blob = await loadLocalFontData(font.postscriptName);
          if (!blob) throw new Error("Local font data is not cached");
          return blob;
        },
      }));
      this.updateRuntime({ fonts: mergeFontCatalog(this.state.fonts, fonts, "local") });
      await this.registerTimelineFonts();
    } catch {
      // IndexedDB may be unavailable in private browsing. Opening the font
      // picker can still load the catalog for the current session.
    }
  }

  private restoreGoogleFonts() {
    if (this.googleFontCatalogLoad) return this.googleFontCatalogLoad;
    this.googleFontCatalogLoad = (async () => {
      const fonts = await loadGoogleFontCatalog();
      this.hydrateGoogleFontEntries(fonts);
      this.updateRuntime({ fonts: mergeFontCatalog(this.state.fonts, fonts, "google") });
      await this.registerTimelineFonts();
    })().catch((error) => {
      this.googleFontCatalogLoad = undefined;
      throw error;
    });
    return this.googleFontCatalogLoad;
  }

  private hydrateGoogleFontEntries(fonts: FontFaceInfo[]) {
    fonts.forEach((font) => {
      if (font.source !== "google" || !font.googleFontsPath) return;
      this.fontEntries.set(font.postscriptName, {
        ...font,
        source: "google",
        blob: () => loadGoogleFontData(font.googleFontsPath!, font.family),
      });
    });
  }

  private async registerFontVariant(fontId: string, variations?: FontVariationSettings, requestedRuntimeId?: string) {
    const entry = this.fontEntries.get(fontId);
    if (!entry) return;
    if (!this.registeredFonts.has(fontId)) {
      const buffer = await (await entry.blob()).arrayBuffer();
      this.engine.registerFont(fontId, buffer);
      this.registeredFonts.add(fontId);
    }
    const normalized = normalizeFontVariations(variations);
    const runtimeId = requestedRuntimeId ?? fontVariationId(fontId, normalized);
    const variationKey = fontVariationKey(normalized);
    if (runtimeId === fontId || this.registeredFontVariations.get(runtimeId) === variationKey) return;
    this.engine.registerFontVariation(runtimeId, fontId, normalized);
    this.registeredFontVariations.set(runtimeId, variationKey);
  }

  private async registerTimelineFonts() {
    const fonts = new Map(this.state.clips
      .filter((clip): clip is TimelineClip & { fontId: string } => Boolean(clip.fontId))
      .map((clip) => clip.textMode === "2d"
        ? [timelineFontId(clip)!, { fontId: clip.fontId, variations: clip.fontVariations }] as const
        : [clip.fontId, { fontId: clip.fontId, variations: undefined }] as const));
    let registered = false;
    await Promise.all([...fonts].map(async ([runtimeId, font]) => {
      if (runtimeId === font.fontId ? this.registeredFonts.has(runtimeId) : this.registeredFontVariations.get(runtimeId) === fontVariationKey(font.variations)) return;
      try {
        await this.registerFontVariant(font.fontId, font.variations, runtimeId);
        registered = true;
      } catch {
        // Catalog metadata can outlive lazily cached binary font data.
      }
    }));
    if (registered) this.renderPreview(true);
  }

  clearCache = () => this.engine.clearCache();
  upsertGeometry = (object: SceneObjectSpec) => this.engine.upsertGeometry(object);
  removeGeometry = (id: string) => this.engine.removeGeometry(id);
}

const MEDIA_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "wav", "mp3", "aac", "flac", "png", "jpg", "jpeg", "webp", "hdr", "exr", "glb", "gltf"]);

function mediaKindForFile(file: File): MediaAsset["kind"] | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!MEDIA_EXTENSIONS.has(extension) && !file.type.startsWith("video/") && !file.type.startsWith("audio/") && !file.type.startsWith("image/")) return null;
  if (extension === "glb" || extension === "gltf" || file.type === "model/gltf-binary" || file.type === "model/gltf+json") return "model";
  if (file.type.startsWith("audio/") || ["wav", "mp3", "aac", "flac"].includes(extension)) return "audio";
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "hdr", "exr"].includes(extension)) return "image";
  return "video";
}

function mergeFontCatalog(current: FontFaceInfo[], incoming: FontFaceInfo[], source: "local" | "google") {
  const retained = current.filter((font) => source === "local" ? font.source === "google" : font.source !== "google");
  return combineFontCatalog(retained, incoming);
}

function combineFontCatalog(...catalogs: FontFaceInfo[][]) {
  return [...new Map(catalogs.flat().map((font) => [font.postscriptName, font])).values()].sort((left, right) => (
    left.family.localeCompare(right.family) || left.style.localeCompare(right.style)
  ));
}

function timelineFontId(clip: Pick<TimelineClip, "id" | "fontId" | "fontVariations">) {
  if (!clip.fontId) return undefined;
  return fontVariationKey(clip.fontVariations) ? `${clip.fontId}#timeline:${clip.id}` : clip.fontId;
}

function isTextureImageFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "webp"].includes(extension)
    || ["image/png", "image/jpeg", "image/webp"].includes(file.type.toLowerCase());
}

function mediaColor(kind: MediaAsset["kind"]) {
  if (kind === "audio") return "#50766c";
  if (kind === "model") return "#557f9d";
  if (kind === "image") return "#817869";
  return "#7e8072";
}

function evaluateClipNumber(clip: TimelineClip, property: KeyframeProperty, timelineTime: number, fallback: number) {
  const keys = (clip.keyframes ?? []).filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
  if (!keys.length) return fallback;
  const localTime = Math.max(0, Math.min(clip.duration, timelineTime - clip.start));
  const left = [...keys].reverse().find((keyframe) => keyframe.time <= localTime) ?? keys[0];
  const right = keys.find((keyframe) => keyframe.time >= localTime) ?? keys.at(-1)!;
  if (left === right || left.interpolation === "step") return left.value;
  let alpha = Math.max(0, Math.min(1, (localTime - left.time) / Math.max(0.000001, right.time - left.time)));
  if (left.interpolation === "smooth") alpha = alpha * alpha * (3 - 2 * alpha);
  else if (left.interpolation === "bezier") alpha = cubicBezierAt(left.easing, alpha);
  return left.value + (right.value - left.value) * alpha;
}

function evaluateSceneNumber(keyframes: readonly SceneKeyframe[], property: string, time: number, fallback: number) {
  const keys = keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
  if (!keys.length) return fallback;
  const left = [...keys].reverse().find((keyframe) => keyframe.time <= time) ?? keys[0];
  const right = keys.find((keyframe) => keyframe.time >= time) ?? keys.at(-1)!;
  if (left === right || left.interpolation === "step") return left.value;
  let alpha = Math.max(0, Math.min(1, (time - left.time) / Math.max(0.000001, right.time - left.time)));
  if (left.interpolation === "smooth") alpha = alpha * alpha * (3 - 2 * alpha);
  else if (left.interpolation === "bezier") alpha = cubicBezierAt(left.easing, alpha);
  return left.value + (right.value - left.value) * alpha;
}

function evaluateCameraAtTime(scene: SceneSettings, time: number): CameraSettings {
  const keys = scene.keyframes ?? [];
  const camera = scene.camera;
  return {
    ...camera,
    position: camera.position.map((value, axis) => evaluateSceneNumber(keys, `camera.position.${axis}`, time, value)) as [number, number, number],
    target: camera.target.map((value, axis) => evaluateSceneNumber(keys, `camera.target.${axis}`, time, value)) as [number, number, number],
    near: evaluateSceneNumber(keys, "camera.near", time, camera.near),
    far: evaluateSceneNumber(keys, "camera.far", time, camera.far),
    fov: evaluateSceneNumber(keys, "camera.fov", time, camera.fov),
    zoom: evaluateSceneNumber(keys, "camera.zoom", time, camera.zoom),
    orthographicHeight: evaluateSceneNumber(keys, "camera.orthographicHeight", time, camera.orthographicHeight),
  };
}

function transformCamera(camera: CameraSettings, operation: "orbit" | "pan" | "dolly", deltaX: number, deltaY: number, viewportHeight: number): CameraSettings {
  const position = [...camera.position] as [number, number, number];
  const target = [...camera.target] as [number, number, number];
  const offset = subtractVector(position, target);
  const distance = Math.max(0.01, vectorLength(offset));
  if (operation === "orbit") {
    const theta = Math.atan2(offset[0], offset[2]) - deltaX * 0.008;
    const phi = Math.max(0.05, Math.min(Math.PI - 0.05, Math.acos(Math.max(-1, Math.min(1, offset[1] / distance))) - deltaY * 0.008));
    const radiusAtY = distance * Math.sin(phi);
    position[0] = target[0] + radiusAtY * Math.sin(theta);
    position[1] = target[1] + distance * Math.cos(phi);
    position[2] = target[2] + radiusAtY * Math.cos(theta);
  } else if (operation === "pan") {
    const forward = normalizeVector(subtractVector(target, position));
    let right = normalizeVector(crossVector(forward, [0, 1, 0]));
    if (vectorLength(right) < 0.000001) right = [1, 0, 0];
    const up = normalizeVector(crossVector(right, forward));
    const height = Math.max(1, viewportHeight);
    const worldUnitsPerPixel = camera.projection === "orthographic"
      ? Math.max(0.001, camera.orthographicHeight) / (height * Math.max(0.001, camera.zoom))
      : 2 * distance * Math.tan(Math.max(0.01, Math.min(Math.PI - 0.01, camera.fov * Math.PI / 180)) / 2) / (height * Math.max(0.001, camera.zoom));
    const translation = addVector(scaleVector(right, -deltaX * worldUnitsPerPixel), scaleVector(up, deltaY * worldUnitsPerPixel));
    for (let axis = 0; axis < 3; axis++) {
      position[axis] += translation[axis];
      target[axis] += translation[axis];
    }
  } else if (camera.projection === "orthographic") {
    return { ...camera, zoom: Math.max(0.01, Math.min(1_000, camera.zoom * Math.exp(-deltaY * 0.002))) };
  } else {
    const nextDistance = Math.max(0.01, Math.min(100_000, distance * Math.exp(deltaY * 0.002)));
    const direction = scaleVector(offset, 1 / distance);
    for (let axis = 0; axis < 3; axis++) position[axis] = target[axis] + direction[axis] * nextDistance;
  }
  return { ...camera, position, target };
}

function cameraKeyframeValues(camera: CameraSettings): Array<[string, number]> {
  return [
    ["camera.position.0", camera.position[0]],
    ["camera.position.1", camera.position[1]],
    ["camera.position.2", camera.position[2]],
    ["camera.target.0", camera.target[0]],
    ["camera.target.1", camera.target[1]],
    ["camera.target.2", camera.target[2]],
    ["camera.near", camera.near],
    ["camera.far", camera.far],
    ["camera.fov", camera.fov],
    ["camera.zoom", camera.zoom],
    ["camera.orthographicHeight", camera.orthographicHeight],
  ];
}

type Vector3 = [number, number, number];

function subtractVector(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function addVector(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function scaleVector(vector: Vector3, scale: number): Vector3 {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function crossVector(left: Vector3, right: Vector3): Vector3 {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function vectorLength(vector: Vector3) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizeVector(vector: Vector3): Vector3 {
  const length = vectorLength(vector);
  return length > 0.000001 ? scaleVector(vector, 1 / length) : [0, 0, 0];
}

function clipHasAudio(clip: TimelineClip, assets: readonly MediaAsset[]) {
  if (!clip.assetId) return false;
  const asset = assets.find((item) => item.id === clip.assetId);
  return asset?.kind === "audio" || asset?.hasAudio === true;
}

function orderedVisualClips(clips: readonly TimelineClip[]) {
  const visualClips = clips.filter((clip) => clip.kind !== "group" && clip.kind !== "filter");
  const legacyOrder = new Map([...visualClips]
    .sort((a, b) => (a.positionZ ?? 0) - (b.positionZ ?? 0) || b.y - a.y)
    .map((clip, index) => [clip.id, index]));
  return [...visualClips].sort((a, b) => {
    const aOrder = Number.isFinite(a.stackOrder) ? a.stackOrder! : legacyOrder.get(a.id) ?? 0;
    const bOrder = Number.isFinite(b.stackOrder) ? b.stackOrder! : legacyOrder.get(b.id) ?? 0;
    return aOrder - bOrder || (legacyOrder.get(a.id) ?? 0) - (legacyOrder.get(b.id) ?? 0);
  });
}

function cubicBezierAt(easing: ClipKeyframe["easing"], x: number) {
  const { x1, y1, x2, y2 } = easing ?? { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
  let t = x;
  for (let index = 0; index < 6; index++) {
    const inverse = 1 - t;
    const estimate = 3 * inverse * inverse * t * x1 + 3 * inverse * t * t * x2 + t * t * t;
    const derivative = 3 * inverse * inverse * x1 + 6 * inverse * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(derivative) < 0.000001) break;
    t = Math.max(0, Math.min(1, t - (estimate - x) / derivative));
  }
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * y1 + 3 * inverse * t * t * y2 + t * t * t;
}

function createEffect(kind: ClipEffectKind): ClipEffect {
  const definitions: Record<ClipEffectKind, Omit<ClipEffect, "id" | "kind">> = {
    transform: { name: t("変形"), enabled: true, params: { x: 0, y: 0, scale: 100, rotation: 0 } },
    meshDeform: { name: t("メッシュ変形"), enabled: true, params: { amount: 25, frequency: 2, angle: 0, phase: 0 } },
    brightness: { name: t("明るさ"), enabled: true, params: { amount: 0 } },
    tint: { name: t("色調"), enabled: true, params: { red: 100, green: 100, blue: 100 } },
    opacity: { name: t("透明度"), enabled: true, params: { amount: 100 } },
    contrast: { name: t("コントラスト"), enabled: true, params: { amount: 0 } },
    saturation: { name: t("彩度"), enabled: true, params: { amount: 100 } },
    gamma: { name: t("ガンマ"), enabled: true, params: { amount: 100 } },
    hue: { name: t("色相"), enabled: true, params: { angle: 0 } },
    chromaKey: { name: t("クロマキー"), enabled: true, params: { red: 0, green: 100, blue: 0, threshold: 20, softness: 10 } },
    vignette: { name: t("ビネット"), enabled: true, params: { amount: 35, size: 65 } },
    pixelate: { name: t("ピクセル化"), enabled: true, params: { size: 8 } },
  };
  return { id: crypto.randomUUID(), kind, ...definitions[kind], params: { ...definitions[kind].params } };
}

function applySceneClipEffects(clip: TimelineClip) {
  let positionX = (clip.positionX ?? 0) / 100;
  let positionY = -(clip.positionY ?? 0) / 100;
  let scaleX = (clip.scale ?? 100) / 100 * (clip.scaleX ?? 100) / 100;
  let scaleY = (clip.scale ?? 100) / 100 * (clip.scaleY ?? 100) / 100;
  let rotation = -((clip.rotation ?? 0) * Math.PI) / 180;
  let opacity = (clip.opacity ?? 100) / 100;
  const base = clip.kind === "title" ? clip.textColor ?? 0x202020 : clip.material?.color ?? clip.textColor ?? 0x3d73a0;
  let rgb = [((base >> 16) & 255) / 255, ((base >> 8) & 255) / 255, (base & 255) / 255];
  for (const effect of clip.effects ?? []) {
    if (!effect.enabled) continue;
    if (effect.kind === "transform") {
      const x = (effect.params.x ?? 0) / 100;
      const y = -(effect.params.y ?? 0) / 100;
      positionX += (Math.cos(rotation) * x - Math.sin(rotation) * y) * scaleX;
      positionY += (Math.sin(rotation) * x + Math.cos(rotation) * y) * scaleY;
      const scale = (effect.params.scale ?? 100) / 100;
      scaleX *= scale; scaleY *= scale;
      rotation -= ((effect.params.rotation ?? 0) * Math.PI) / 180;
    } else if (effect.kind === "brightness") rgb = rgb.map((value) => value * Math.max(0, 1 + (effect.params.amount ?? 0) / 100));
    else if (effect.kind === "tint") rgb = rgb.map((value, index) => value * ([effect.params.red, effect.params.green, effect.params.blue][index] ?? 100) / 100);
    else if (effect.kind === "contrast") rgb = rgb.map((value) => (value - 0.5) * Math.max(0, 1 + (effect.params.amount ?? 0) / 100) + 0.5);
    else if (effect.kind === "saturation") {
      const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      const amount = Math.max(0, (effect.params.amount ?? 100) / 100);
      rgb = rgb.map((value) => luma + (value - luma) * amount);
    } else if (effect.kind === "gamma") rgb = rgb.map((value) => Math.max(0, value) ** (1 / Math.max(0.01, (effect.params.amount ?? 100) / 100)));
    else if (effect.kind === "opacity") opacity *= (effect.params.amount ?? 100) / 100;
  }
  const color = rgb.reduce((value, channel) => (value << 8) | Math.round(Math.max(0, Math.min(1, channel)) * 255), 0);
  return { positionX, positionY, scaleX: Math.max(0.001, scaleX), scaleY: Math.max(0.001, scaleY), rotation, opacity: Math.max(0, Math.min(1, opacity)), color };
}

async function queryReadPermission(handle: FileSystemFileHandle) {
  const permissionHandle = handle as FileSystemFileHandle & { queryPermission?: (options: { mode: "read" }) => Promise<PermissionState> };
  return permissionHandle.queryPermission ? permissionHandle.queryPermission({ mode: "read" }) : "prompt";
}

async function requestReadPermission(handle: FileSystemFileHandle) {
  const permissionHandle = handle as FileSystemFileHandle & { requestPermission?: (options: { mode: "read" }) => Promise<PermissionState> };
  return permissionHandle.requestPermission ? permissionHandle.requestPermission({ mode: "read" }) : "prompt";
}

async function queryDirectoryReadPermission(handle: FileSystemDirectoryHandle) {
  const permissionHandle = handle as FileSystemDirectoryHandle & { queryPermission?: (options: { mode: "read" }) => Promise<PermissionState> };
  return permissionHandle.queryPermission ? permissionHandle.queryPermission({ mode: "read" }) : "prompt";
}

async function runWithConcurrency<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<unknown>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      try { await task(item); } catch { /* Each restore updates its own availability state. */ }
    }
  });
  await Promise.all(workers);
}

function handleAssetSignature(asset: Omit<MediaAsset, "handle"> | MediaAsset) {
  return JSON.stringify([asset.name, asset.kind, asset.size, asset.lastModified, asset.sourcePath ?? null]);
}
