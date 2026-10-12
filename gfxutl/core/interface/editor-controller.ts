import type { AudioProcessingSpec, ClipEffect, ClipEffectKind, ClipKeyframe, ClipMask, ClipPostProcess, ClipPropertyActionKind, ContextMenuState, EditorLayout, EditorSettings, EditorState, EngineResponse, ExportSettings, FontFaceInfo, GeometryKind, KeyframeProperty, MediaAsset, RenderClip, SceneKeyframe, SceneObjectSpec, SceneSettings, TimelineClip } from "./types";
import { applicableClipActionKinds, DEFAULT_POST_PROCESS_GLSL, resetPatchForClipAction, resolveClipPropertyActions } from "./clip-actions";
import { EngineClient } from "./engine-client";
import { VirtualTimeline } from "./virtual-timeline";
import { assignTimelineGroups, expandGroupToValidBoundary, hasGroupBoundaryCrossing, MIN_GROUP_HEIGHT, placeTimelineClip, timelineGroupDescendants } from "./timeline-groups";
import { loadHandleProjects, saveHandleProject } from "../persistence/handle-project-store";
import { createProjectDocument, parseProjectDocument, type ProjectDocument } from "../project/project-document";
import { clampTimelineZoom } from "./timeline-zoom";
import { MediaReadPlanner } from "./media-read-graph";
import { resolveAudioProcessing } from "./audio-processing";

type Listener = () => void;

const MiB = 1024 * 1024;

const defaultLayout: EditorLayout = { leftPanelWidth: 286, rightPanelWidth: 294, timelineHeight: 309 };
const defaultSettings: EditorSettings = { ramPreviewEnabled: true, ramPreviewMaxBytes: 128 * MiB, audioChannels: "stereo" };

const defaultSceneSettings: SceneSettings = {
  background: { color: 0xffffff, alpha: 1, fogEnabled: false, fogColor: 0xffffff, fogNear: 5, fogFar: 30, environmentIntensity: 1, environmentRotation: 0, backgroundBlurriness: 0 },
  camera: { projection: "orthographic", position: [0, 0, 10], target: [0, 0, 0], near: 0.01, far: 1_000, fov: 50, zoom: 1, orthographicHeight: 9 },
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
    };
  } catch {
    return defaultSettings;
  }
}

const loadedSettings = loadSettings();

const initialState: EditorState = {
  projectName: "Untitled Project",
  canUndo: false,
  canRedo: false,
  markers: [],
  loopPlayback: false,
  fps: 30,
  duration: 32,
  currentTime: 0,
  playing: false,
  zoom: 1,
  snapEnabled: true,
  selectedClipId: null,
  selectedClipIds: [],
  previewClipTabs: [],
  activePreviewClipId: null,
  selectedAssetId: null,
  backgroundSelected: false,
  background: { id: "background", name: "背景オブジェクト", color: 0xffffff, scene: structuredClone(defaultSceneSettings) },
  assets: [],
  clips: [],
  fonts: [],
  cache: { usedBytes: 0, maxBytes: loadedSettings.ramPreviewMaxBytes, entries: 0, codec: "H.264" },
  mediaBuffer: { usedBytes: 0, maxBytes: 128 * MiB, entries: 0, pending: 0, instances: 0 },
  engine: "initializing",
  cameraProjection: "orthographic",
  mediaBunnyReady: false,
  fileSystemAccess: "showDirectoryPicker" in window || "showOpenFilePicker" in window,
  localFontAccess: "queryLocalFonts" in window,
  notice: null,
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

type LocalFontEntry = {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
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
  private previewMetricTimer = 0;
  private pendingPreviewFrames = 0;
  private pendingCachedFrames = 0;
  private pendingPreviewSource: "realtime" | "cache" = "realtime";
  private previewCacheDirty = false;
  private previewCacheTimer = 0;
  private persistenceTimer = 0;
  private localFontEntries = new Map<string, LocalFontEntry>();
  private registeredFonts = new Set<string>();
  private fontPreviewLoads = new Map<string, Promise<string | undefined>>();
  private memoryClipboard: ClipboardPayload | null = null;
  private audioContext: AudioContext | null = null;
  private audioVoices = new Map<string, PreviewAudioVoice>();
  private audioPreviewToken = 0;
  private activeAudioSignature = "";
  private explorerFiles = new Map<string, { file?: File; handle?: FileSystemFileHandle }>();
  private undoStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];
  private historySuspended = false;
  private lastHistorySignature = "";
  private lastHistoryAt = 0;
  private projectFileHandle?: FileSystemFileHandle;

  constructor(worker: Worker) {
    this.engine = new EngineClient(worker, (message) => this.onEngineMessage(message));
    this.engine.configurePreviewCache(this.state.settings.ramPreviewEnabled, this.state.settings.ramPreviewMaxBytes);
    void this.restoreHandleProjects();
  }

  getSnapshot = () => this.state;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<EditorState>) {
    this.recordHistory(patch);
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
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
    this.historySuspended = true;
    this.state = {
      ...this.state,
      ...snapshot,
      canUndo,
      canRedo,
      selectedClipId: snapshot.clips.some((clip) => clip.id === this.state.selectedClipId) ? this.state.selectedClipId : null,
      selectedClipIds: this.state.selectedClipIds.filter((id) => snapshot.clips.some((clip) => clip.id === id)),
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
      for (const asset of this.state.assets) void saveHandleProject(asset, this.state.clips, project).catch(() => { /* Editing remains available if handle persistence is blocked. */ });
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
    });
  }

  private async restoreHandleProjects() {
    try {
      const records = await loadHandleProjects();
      if (!records.length) return;
      const assets = records.map((record) => ({ ...record.asset, handle: record.handle, fileStatus: "loading" as const }));
      const clips = [...new Map(records.flatMap((record) => record.clips).map((clip) => [clip.id, clip])).values()];
      const project = [...records].sort((a, b) => b.savedAt - a.savedAt).find((record) => record.project)?.project;
      this.historySuspended = true;
      this.update({
        assets,
        clips,
        markers: project?.markers ?? [],
        loopPlayback: project?.loopPlayback ?? false,
        projectName: project?.name ?? this.state.projectName,
        fps: project?.fps ?? this.state.fps,
        duration: project?.duration ?? Math.max(32, ...clips.map((clip) => clip.start + clip.duration + 2)),
        background: project?.background ?? this.state.background,
        settings: project?.settings ?? this.state.settings,
        exportSettings: project?.exportSettings ?? this.state.exportSettings,
      });
      this.historySuspended = false;
      await Promise.allSettled(assets.map((asset) => this.restoreAssetFile(asset.id, false)));
      this.renderPreview(true);
    } catch {
      // IndexedDB or a persisted handle may be unavailable in private browsing.
    } finally {
      this.historySuspended = false;
    }
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
      this.toast(`${filename} を保存しました`);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? `保存失敗: ${error.message}` : "プロジェクトを保存できませんでした");
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
      const assets = project.assets.map((asset) => {
        const connected = this.state.assets.find((item) => item.sourcePath && item.sourcePath === asset.sourcePath)
          ?? this.state.assets.find((item) => item.name === asset.name && item.size === asset.size);
        return connected ? { ...asset, handle: connected.handle, fileStatus: connected.fileStatus } : { ...asset, fileStatus: "missing" as const };
      });
      this.update({
        projectName: project.name,
        fps: project.fps,
        duration: project.duration,
        background: project.background,
        assets,
        clips: project.clips,
        markers: project.markers,
        loopPlayback: project.loopPlayback,
        settings: project.settings,
        exportSettings: project.exportSettings,
        selectedClipId: null,
        selectedClipIds: [],
        previewClipTabs: [],
        activePreviewClipId: null,
        selectedAssetId: null,
        backgroundSelected: false,
      });
      this.renderClipSource = null;
      this.engine.configurePreviewCache(project.settings.ramPreviewEnabled, project.settings.ramPreviewMaxBytes);
      this.engine.clearCache();
      this.renderPreview(true);
      this.schedulePersistence();
      this.toast(`${project.name} を開きました`);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? error.message : "プロジェクトを開けませんでした");
    }
  };

  newProject = () => {
    if ((this.state.clips.length || this.state.assets.length) && !window.confirm("現在の編集内容を閉じて新規プロジェクトを作成しますか？")) return;
    this.projectFileHandle = undefined;
    this.update({
      projectName: "Untitled Project",
      fps: 30,
      duration: 32,
      currentTime: 0,
      playing: false,
      background: { id: "background", name: "背景オブジェクト", color: 0xffffff, scene: structuredClone(defaultSceneSettings) },
      assets: [],
      clips: [],
      markers: [],
      loopPlayback: false,
      selectedClipId: null,
      selectedClipIds: [],
      previewClipTabs: [],
      activePreviewClipId: null,
      selectedAssetId: null,
      backgroundSelected: false,
      exportSettings: { ...initialState.exportSettings },
    });
    this.stopAudioPreview();
    this.engine.clearCache();
    this.renderClipSource = null;
    this.renderPreview(true);
  };

  private async restoreAssetFile(assetId: string, requestPermission: boolean) {
    const asset = this.state.assets.find((item) => item.id === assetId);
    if (!asset?.handle) return false;
    try {
      let permission = await queryReadPermission(asset.handle);
      if (permission !== "granted" && requestPermission) permission = await requestReadPermission(asset.handle);
      if (permission !== "granted") {
        this.update({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, fileStatus: "permission-required" } : item) });
        return false;
      }
      const file = await asset.handle.getFile();
      const info: Partial<MediaAsset> = { size: file.size, lastModified: file.lastModified, ...await this.registerRuntimeFile(asset, file) };
      if (asset.kind === "audio") {
        try { info.waveformPeaks = (await this.engine.getMediaThumbnail(asset.id)).peaks; } catch { /* Waveform is an optional visual aid. */ }
      }
      this.update({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, ...info, fileStatus: "ready" } : item) });
      return true;
    } catch {
      this.update({ assets: this.state.assets.map((item) => item.id === assetId ? { ...item, fileStatus: "missing" } : item) });
      return false;
    }
  }

  restoreMediaAccess = async (assetId?: string) => {
    const targets = this.state.assets.filter((asset) => asset.handle && (!assetId || asset.id === assetId) && asset.fileStatus !== "ready");
    if (!targets.length) return;
    this.update({ assets: this.state.assets.map((asset) => targets.some((target) => target.id === asset.id) ? { ...asset, fileStatus: "loading" } : asset) });
    const results = await Promise.all(targets.map((asset) => this.restoreAssetFile(asset.id, true)));
    const restored = results.filter(Boolean).length;
    this.toast(restored ? `${restored} 件のメディアを再接続しました` : "ファイルへのアクセス許可が必要です");
    this.renderPreview(true);
  };

  private async registerRuntimeFile(asset: MediaAsset, file: File) {
    if (asset.kind === "image") return this.engine.inspectImage(file, asset.id, asset.handle);
    if (asset.kind === "model") return this.engine.inspectModel(file, asset.id, asset.handle);
    const info = await this.engine.inspectMedia(file, asset.id, asset.handle);
    return info;
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
    const active = this.state.clips.filter((clip) => {
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
    voice.gain.gain.value = volume <= -60 ? 0 : Math.max(0, Math.min(4, 10 ** (volume / 20) * fadeIn * fadeOut));
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
      if (token === this.audioPreviewToken) this.toast("音声プレビューをデコードできませんでした");
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
    // Retina displays otherwise multiply fill-rate by 4–9x. Export resolution is
    // unaffected; this only caps the interactive proxy surface.
    return Math.min(window.devicePixelRatio || 1, 1.5);
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
    this.engine.setMediaReadGraph(this.mediaReadPlanner.build(this.state.clips, this.state.assets, this.state.currentTime));
    if (this.state.playing) {
      const frame = Math.floor(this.state.currentTime * this.state.fps);
      if (frame === this.lastPlaybackFrame) return;
      this.lastPlaybackFrame = frame;
    } else {
      this.lastPlaybackFrame = -1;
    }
    const renderClips = this.getRenderClips();
    const patch = this.virtualTimeline.reconcile(renderClips);
    if (patch) this.engine.patchTimeline(patch);
    this.engine.render(this.state.currentTime, cache && this.state.settings.ramPreviewEnabled && !this.state.activePreviewClipId, this.state.playing ? "playback" : "realtime", this.state.fps, this.state.background.scene, this.state.activePreviewClipId ?? undefined);
  }

  private getRenderClips(): RenderClip[] {
    if (this.renderClipSource === this.state.clips) return this.renderClipCache;
    const visualClips = this.state.clips.filter((clip) => clip.kind !== "group");
    const depth = new Map([...visualClips]
      .sort((a, b) => (a.positionZ ?? 0) - (b.positionZ ?? 0) || b.y - a.y)
      .map((clip, index) => [clip.id, 1_000 + index]));
    this.renderClipSource = this.state.clips;
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
      visible: clip.visible ?? true,
      layer: clip.layer ?? 0,
      parentId: clip.parentId,
      opacity: clip.opacity ?? 100,
      volume: clip.volume ?? 0,
      pan: clip.pan ?? 0,
      speed: clip.speed ?? 100,
      audioProcessing: clip.audioProcessing,
      cropLeft: clip.cropLeft ?? 0,
      cropRight: clip.cropRight ?? 0,
      cropTop: clip.cropTop ?? 0,
      cropBottom: clip.cropBottom ?? 0,
      effects: clip.effects ?? [],
      postProcess: clip.postProcess,
      masks: clip.masks ?? [],
      keyframes: clip.keyframes ?? [],
      particleSystem: clip.particleSystem,
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
    const geometry = clip.kind === "title"
      ? {
          id: `${clip.id}:text`, kind: "text" as const, text: clip.text ?? clip.name,
          fontId: clip.fontId, size: clip.fontSize ?? 1.2, depth: clip.textDepth ?? 0.12,
          curveSegments: 8, bevelEnabled: false,
        }
      : clip.geometry;
    if (!geometry) return undefined;
    const visual = applySceneClipEffects(clip);
    const instanceCount = Math.max(1, Math.min(1_000, Math.floor(clip.instanceCount ?? 1)));
    const instanceSpacing = clip.instanceSpacing ?? 2.5;
    return {
      id: `timeline:${clip.id}`,
      geometry,
      primitive: clip.primitive ?? "mesh",
      material: {
        kind: clip.kind === "title" ? "basic" : clip.material?.kind ?? "standard",
        color: clip.kind === "title" ? clip.textColor ?? 0x202020 : clip.material?.color ?? clip.textColor ?? 0x3d73a0,
        ...clip.material,
        effects: clip.effects ?? [],
        opacity: visual.opacity,
        side: clip.kind === "title" ? "double" : clip.material?.side ?? "front",
        depthTest: true, depthWrite: (clip.opacity ?? 100) >= 100, transparent: true,
        outlineColor: clip.kind === "title" ? clip.textOutlineColor ?? 0xffffff : undefined,
        outlineWidth: clip.kind === "title" ? clip.textOutlineWidth ?? 0.02 : undefined,
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
  toggleSnap = () => this.update({ snapEnabled: !this.state.snapEnabled });
  toggleLoopPlayback = () => this.update({ loopPlayback: !this.state.loopPlayback });
  addMarker = (time = this.state.currentTime, label?: string) => {
    const markerTime = this.snapTime(time);
    const existing = this.state.markers.find((marker) => Math.abs(marker.time - markerTime) < 0.5 / this.state.fps);
    if (existing) return;
    const colors = ["#f0c36a", "#72b7d2", "#c481d8", "#7dc58b"];
    this.update({ markers: [...this.state.markers, { id: crypto.randomUUID(), time: markerTime, label: label?.trim() || `マーカー ${this.state.markers.length + 1}`, color: colors[this.state.markers.length % colors.length] }].sort((a, b) => a.time - b.time) });
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
    const previewable = clip && clip.kind !== "group";
    this.update({
      selectedClipId: selectedClipIds.includes(id) ? id : selectedClipIds.at(-1) ?? null,
      selectedClipIds,
      selectedAssetId: clip?.assetId ?? null,
      backgroundSelected: false,
      ...(previewable ? {
        previewClipTabs: this.state.previewClipTabs.includes(id) ? this.state.previewClipTabs : [...this.state.previewClipTabs, id],
        activePreviewClipId: id,
      } : {}),
    });
    if (previewable) this.renderPreview(false);
  };
  selectClips = (ids: string[], additive = false) => {
    const selectedClipIds = additive ? [...new Set([...this.state.selectedClipIds, ...ids])] : ids;
    const selectedClipId = selectedClipIds.at(-1) ?? null;
    const clip = this.state.clips.find((item) => item.id === selectedClipId);
    const previewable = clip && clip.kind !== "group";
    this.update({
      selectedClipIds, selectedClipId, selectedAssetId: clip?.assetId ?? null, backgroundSelected: false,
      ...(previewable ? {
        previewClipTabs: this.state.previewClipTabs.includes(clip.id) ? this.state.previewClipTabs : [...this.state.previewClipTabs, clip.id],
        activePreviewClipId: clip.id,
      } : {}),
    });
    if (previewable) this.renderPreview(false);
  };
  setPreviewTab = (clipId: string | null) => {
    if (clipId !== null && !this.state.previewClipTabs.includes(clipId)) return;
    this.update({ activePreviewClipId: clipId });
    this.renderPreview(false);
  };
  closePreviewTab = (clipId: string) => {
    const previewClipTabs = this.state.previewClipTabs.filter((id) => id !== clipId);
    const activePreviewClipId = this.state.activePreviewClipId === clipId ? null : this.state.activePreviewClipId;
    this.update({ previewClipTabs, activePreviewClipId });
    if (activePreviewClipId !== this.state.activePreviewClipId) this.renderPreview(false);
  };
  selectAsset = (id: string | null) => this.update({ selectedAssetId: id, selectedClipId: null, selectedClipIds: [], backgroundSelected: false });
  selectBackground = () => this.update({ backgroundSelected: true, selectedAssetId: null, selectedClipId: null, selectedClipIds: [] });
  updateBackground = (patch: Partial<EditorState["background"]>) => {
    const next = { ...this.state.background, ...patch };
    if (patch.color !== undefined) next.scene = { ...next.scene, background: { ...next.scene.background, color: patch.color } };
    this.update({ background: next, backgroundSelected: true });
    this.renderPreview(true);
  };
  updateSceneSettings = (patch: Partial<SceneSettings>) => {
    const scene = {
      ...this.state.background.scene,
      ...patch,
      background: { ...this.state.background.scene.background, ...patch.background },
      camera: { ...this.state.background.scene.camera, ...patch.camera },
      renderer: { ...this.state.background.scene.renderer, ...patch.renderer },
      lights: patch.lights ?? this.state.background.scene.lights,
    };
    this.update({ background: { ...this.state.background, color: scene.background.color, scene }, backgroundSelected: true });
    this.renderPreview(true);
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
    this.updateSceneSettings({ keyframes: (this.state.background.scene.keyframes ?? []).map((keyframe) => keyframe.id === id ? { ...keyframe, ...patch } : keyframe).sort((a, b) => a.time - b.time) });
    this.schedulePersistence();
  };
  removeSceneKeyframe = (id: string) => {
    this.updateSceneSettings({ keyframes: (this.state.background.scene.keyframes ?? []).filter((keyframe) => keyframe.id !== id) });
    this.schedulePersistence();
  };
  openContextMenu = (menu: ContextMenuState) => this.update({ contextMenu: menu });
  closeContextMenu = () => this.update({ contextMenu: null });
  setLeftPanelTab = (tab: EditorState["leftPanelTab"]) => this.update({ leftPanelTab: tab });
  renameProject = (projectName: string) => this.update({ projectName });
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
    const next = { ...this.state.exportSettings, ...patch };
    const minimumDuration = 1 / Math.max(1, next.fps);
    next.startTime = Number.isFinite(next.startTime) ? Math.max(0, next.startTime) : this.state.exportSettings.startTime;
    next.endTime = Number.isFinite(next.endTime) ? Math.max(next.startTime + minimumDuration, next.endTime) : this.state.exportSettings.endTime;
    if (patch.format === "mp4") {
      if (!["avc", "hevc", "av1"].includes(next.videoCodec)) next.videoCodec = "avc";
      if (!["aac", "opus", "none"].includes(next.audioCodec)) next.audioCodec = "aac";
    } else if (patch.format === "webm") {
      if (!["vp8", "vp9", "av1"].includes(next.videoCodec)) next.videoCodec = "vp9";
      if (!["opus", "vorbis", "none"].includes(next.audioCodec)) next.audioCodec = "opus";
    }
    this.update({ exportSettings: next });
  };

  getMediaThumbnail = (assetId: string, time = 0) => this.engine.getMediaThumbnail(assetId, time);
  prepareMediaPreview = (file: File, previewId: string, handle?: FileSystemFileHandle) => this.engine.inspectMedia(file, previewId, handle);
  releaseMediaPreview = (previewId: string) => this.engine.releaseMedia(previewId);
  pickPreview = (ndcX: number, ndcY: number, coalesce = false) => this.engine.pick(ndcX, ndcY, coalesce);

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
    if (!anchor) return;
    const selectedIds = this.state.selectedClipIds.includes(id) ? this.state.selectedClipIds : [id];
    const movingIds = timelineGroupDescendants(this.state.clips, selectedIds);
    const deltaStart = Math.max(0, start) - anchor.start;
    const deltaY = Math.max(0, y) - anchor.y;
    const minimumStart = Math.min(...this.state.clips.filter((clip) => movingIds.has(clip.id)).map((clip) => clip.start));
    const minimumY = Math.min(...this.state.clips.filter((clip) => movingIds.has(clip.id)).map((clip) => clip.y));
    const safeDeltaStart = Math.max(deltaStart, -minimumStart);
    const safeDeltaY = Math.max(deltaY, -minimumY);
    let end = this.state.duration;
    const proposed = this.state.clips.map((clip) => {
      if (!movingIds.has(clip.id)) return clip;
      const nextStart = clip.start + safeDeltaStart;
      const nextY = clip.y + safeDeltaY;
      end = Math.max(end, nextStart + clip.duration + 2);
      return { ...clip, start: nextStart, y: nextY };
    });
    if (hasGroupBoundaryCrossing(proposed)) return;
    const clips = assignTimelineGroups(proposed);
    this.update({ clips, duration: end, selectedClipId: id, selectedClipIds: selectedIds });
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
    const selected = this.state.clips.filter((clip) => movingIds.has(clip.id));
    if (!selected.length) return;
    const requestedDelta = frames / this.state.fps;
    const safeDelta = Math.max(requestedDelta, -Math.min(...selected.map((clip) => clip.start)));
    if (!safeDelta) return;
    let end = this.state.duration;
    const proposed = this.state.clips.map((clip) => {
      if (!movingIds.has(clip.id)) return clip;
      const start = Math.max(0, clip.start + safeDelta);
      end = Math.max(end, start + clip.duration + 2);
      return { ...clip, start };
    });
    if (hasGroupBoundaryCrossing(proposed)) return;
    const clips = assignTimelineGroups(proposed);
    this.update({ clips, duration: end });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  };

  resizeStaticClip = (id: string, start: number, duration: number) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip) return;
    const asset = clip.assetId ? this.state.assets.find((item) => item.id === clip.assetId) : undefined;
    if (clip.kind !== "title" && clip.kind !== "object" && clip.kind !== "group" && asset?.kind !== "image") return;
    const minimumDuration = 1 / this.state.fps;
    const nextStart = Math.max(0, start);
    const nextDuration = Math.max(minimumDuration, duration);
    const proposed = this.state.clips.map((item) => item.id === id ? { ...item, start: nextStart, duration: nextDuration } : item);
    if (hasGroupBoundaryCrossing(proposed)) return;
    this.update({
      clips: assignTimelineGroups(proposed),
      duration: Math.max(this.state.duration, nextStart + nextDuration + 2),
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  resizeTimelineGroup = (id: string, start: number, y: number, duration: number, height: number) => {
    const group = this.state.clips.find((clip) => clip.id === id && clip.kind === "group");
    if (!group) return;
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
      duration: Math.max(this.state.duration, nextStart + nextDuration + 2),
    });
    this.schedulePersistence();
  };

  translatePreviewClip = (id: string, deltaX: number, deltaY: number, transient = false) => {
    if (!deltaX && !deltaY) return;
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip || clip.kind === "audio") return;
    const clips = this.state.clips.map((item) => item.id === id ? {
      ...item,
      positionX: (item.positionX ?? 0) + deltaX,
      positionY: (item.positionY ?? 0) + deltaY,
      keyframes: item.keyframes?.map((keyframe) => keyframe.property === "positionX"
        ? { ...keyframe, value: keyframe.value + deltaX }
        : keyframe.property === "positionY" ? { ...keyframe, value: keyframe.value + deltaY } : keyframe),
    } : item);
    this.update({ clips, selectedClipId: id, selectedClipIds: [id], backgroundSelected: false });
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

  updateClip = (id: string, patch: Partial<import("./types").TimelineClip>) => {
    const current = this.state.clips.find((clip) => clip.id === id);
    if (!current) return;
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
    const postProcess: ClipPostProcess | undefined = kind === "postProcess" ? {
      id: crypto.randomUUID(), name: "GLSLシェーダー", enabled: true,
      glsl: DEFAULT_POST_PROCESS_GLSL, compileStatus: "draft",
    } : undefined;
    this.updateClip(id, {
      ...resetPatchForClipAction(kind),
      ...(postProcess ? { postProcess } : {}),
      propertyActions: [...actions, { id: crypto.randomUUID(), kind }],
    });
    if (postProcess) void this.compileClipPostProcess(id, postProcess.glsl);
  };

  removeClipPropertyAction = (id: string, actionId: string) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip) return;
    const actions = resolveClipPropertyActions(clip);
    const action = actions.find((item) => item.id === actionId);
    if (!action) return;
    this.updateClip(id, {
      ...resetPatchForClipAction(action.kind),
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

  updateClipPostProcess = (id: string, patch: Partial<ClipPostProcess>) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip?.postProcess) return;
    this.updateClip(id, { postProcess: { ...clip.postProcess, ...patch } });
  };

  compileClipPostProcess = async (id: string, glsl: string) => {
    const clip = this.state.clips.find((item) => item.id === id);
    if (!clip?.postProcess) return;
    const compiling: ClipPostProcess = { ...clip.postProcess, glsl, wgsl: undefined, compileStatus: "compiling", compileError: undefined };
    this.updateClip(id, { postProcess: compiling });
    try {
      const wgsl = await this.engine.compileGlsl(glsl);
      const current = this.state.clips.find((item) => item.id === id)?.postProcess;
      if (!current || current.glsl !== glsl) return;
      this.updateClip(id, { postProcess: { ...current, wgsl, compileStatus: "ready", compileError: undefined } });
    } catch (error) {
      const current = this.state.clips.find((item) => item.id === id)?.postProcess;
      if (!current || current.glsl !== glsl) return;
      this.updateClip(id, { postProcess: { ...current, wgsl: undefined, compileStatus: "error", compileError: error instanceof Error ? error.message : String(error) } });
    }
  };

  removeClip = (id: string) => {
    const selectedClipIds = this.state.selectedClipIds.filter((item) => item !== id);
    const clips = assignTimelineGroups(this.state.clips.filter((clip) => clip.id !== id));
    this.update({
      clips,
      selectedClipId: this.state.selectedClipId === id ? selectedClipIds.at(-1) ?? null : this.state.selectedClipId,
      selectedClipIds,
      previewClipTabs: this.state.previewClipTabs.filter((clipId) => clipId !== id),
      activePreviewClipId: this.state.activePreviewClipId === id ? null : this.state.activePreviewClipId,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  };

  addTextObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const stagger = this.objectStagger(start, placement?.positionX ?? 0, placement?.positionY ?? 0);
    const clip: TimelineClip = {
      id, name: "Text", text: "Text", kind: "title", color: "#9169b6", start,
      y: Math.max(0, placement?.timelineY ?? 32), duration: 5, offset: 0,
      positionX: (placement?.positionX ?? 0) + stagger.x, positionY: (placement?.positionY ?? 0) + stagger.y,
      positionZ: 0,
      scale: 100, scaleX: 100, scaleY: 100, rotation: 0, opacity: 100, fontSize: 1.2, textDepth: 0.12,
      textColor: 0x202020, textOutlineColor: 0xffffff, textOutlineWidth: 0.02, fontFamily: "Helvetiker",
    };
    this.insertObjectClip(clip);
  };

  addGroupObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const source: TimelineClip = {
      id,
      name: "グループ",
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
      duration: Math.max(this.state.duration, group.start + group.duration + 2),
      contextMenu: null,
    });
    this.schedulePersistence();
  };

  addParticleObject = (placement?: Partial<Pick<ContextMenuState, "time" | "timelineY" | "positionX" | "positionY">>) => {
    const id = crypto.randomUUID();
    const start = this.snapTime(placement?.time ?? this.state.currentTime);
    const clip: TimelineClip = {
      id, name: "GPUパーティクル", kind: "object", color: "#6ca6d9", start,
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
    const names: Partial<Record<GeometryKind, string>> = { box: "立方体", sphere: "球体", plane: "平面", torus: "トーラス", shape: "シェイプ" };
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
      currentTime: clip.start, duration: Math.max(this.state.duration, clip.start + clip.duration + 2), contextMenu: null,
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  }

  setTextFont = async (clipId: string, fontId: string) => {
    const entry = this.localFontEntries.get(fontId);
    if (entry && !this.registeredFonts.has(fontId)) {
      try {
        const buffer = await (await entry.blob()).arrayBuffer();
        this.engine.registerFont(fontId, buffer);
        this.registeredFonts.add(fontId);
      } catch {
        this.toast("フォントデータを読み込めませんでした");
        return;
      }
    }
    this.updateClip(clipId, { fontId: entry ? fontId : undefined, fontFamily: entry?.family ?? "Helvetiker" });
  };

  loadFontPreview = (fontId: string) => {
    const cached = this.fontPreviewLoads.get(fontId);
    if (cached) return cached;
    const entry = this.localFontEntries.get(fontId);
    if (!entry) return Promise.resolve(undefined);
    const family = `GfxUtl Preview ${fontId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const pending = entry.blob()
      .then((blob) => blob.arrayBuffer())
      .then(async (buffer) => {
        const face = new FontFace(family, buffer);
        await face.load();
        document.fonts.add(face);
        return family;
      })
      .catch(() => {
        this.fontPreviewLoads.delete(fontId);
        return undefined;
      });
    this.fontPreviewLoads.set(fontId, pending);
    return pending;
  };

  copySelection = async () => {
    const copiedIds = timelineGroupDescendants(this.state.clips, this.state.selectedClipIds);
    const clips = this.state.clips.filter((item) => copiedIds.has(item.id));
    if (!clips.length) return false;
    const payload: ClipboardPayload = { type: "gfxutl/timeline-object", version: 2, clips };
    this.memoryClipboard = payload;
    try { await navigator.clipboard?.writeText(JSON.stringify(payload)); } catch { /* In-memory fallback remains available. */ }
    this.toast(clips.length === 1 ? `${clips[0].name} をコピーしました` : `${clips.length} 個のオブジェクトをコピーしました`);
    return true;
  };

  cutSelection = async () => {
    const ids = [...timelineGroupDescendants(this.state.clips, this.state.selectedClipIds)];
    if (!ids.length || !(await this.copySelection())) return;
    this.update({
      clips: assignTimelineGroups(this.state.clips.filter((clip) => !ids.includes(clip.id))),
      selectedClipId: null,
      selectedClipIds: [],
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
    if (!payload) { this.toast("貼り付け可能なGfxUtlオブジェクトがありません"); return; }
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
      duration: Math.max(this.state.duration, ...pasted.map((clip) => clip.start + clip.duration + 2)),
    });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    this.toast(pasted.length === 1 ? `${pasted[0].name} を貼り付けました` : `${pasted.length} 個のオブジェクトを貼り付けました`);
  };

  splitSelectionAt = (time = this.state.contextMenu?.time ?? this.state.currentTime) => {
    const frame = 1 / this.state.fps;
    const selected = new Set(this.state.selectedClipIds);
    const created: TimelineClip[] = [];
    const clips = this.state.clips.flatMap((clip) => {
      if (clip.kind === "group" || !selected.has(clip.id) || time <= clip.start + frame / 2 || time >= clip.start + clip.duration - frame / 2) return [clip];
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
    if (!created.length) { this.toast("カット位置がクリップの範囲外です"); return; }
    this.update({ clips, selectedClipId: created.at(-1)!.id, selectedClipIds: created.map((clip) => clip.id), contextMenu: null });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
  };

  addMask = (clipId: string, shape: ClipMask["shape"] = "rectangle") => {
    const clip = this.state.clips.find((item) => item.id === clipId);
    if (!clip || clip.kind !== "video") return;
    const mask: ClipMask = { id: crypto.randomUUID(), name: `マスク ${(clip.masks?.length ?? 0) + 1}`, enabled: true, shape, mode: "add", inverted: false, x: 50, y: 50, width: 70, height: 70, feather: 0, opacity: 100 };
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
    this.update({ clips: this.state.clips.map((clip) => clip.id === clipId ? { ...clip, effects: (clip.effects ?? []).filter((effect) => effect.id !== effectId) } : clip) });
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
      duration: Math.max(this.state.duration, clip.start + duration + 2),
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
      this.toast(`${filename} を書き出しました`);
    } catch (error) {
      if ((error as DOMException).name === "AbortError") return;
      this.update({ exportStatus: "error" });
      this.toast(error instanceof Error ? `書き出し失敗: ${error.message}` : "書き出しに失敗しました");
    }
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
      this.toast(`${filename} を書き出しました`);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? `静止画の書き出し失敗: ${error.message}` : "静止画を書き出せませんでした");
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
        [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: "glTF Binary", accept: { "model/gltf-binary": [".glb"] } }] });
        file = await handle.getFile();
      } else {
        file = await this.openWithInput(".glb,model/gltf-binary");
      }
      await this.importMediaFile(file, handle);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast(error instanceof Error ? `3Dモデルを開けませんでした: ${error.message}` : "3Dモデルを開けませんでした");
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
      if ((error as DOMException).name !== "AbortError") this.toast("メディアを開けませんでした");
    }
  };

  importMediaFile = async (file: File, handle?: FileSystemFileHandle, sourcePath?: string) => {
    const kind = mediaKindForFile(file);
    if (!kind) {
      this.toast(`${file.name} は対応していないファイルです`);
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
      const waveformPeaks = kind === "audio" ? await this.engine.getMediaThumbnail(id).then((thumbnail) => thumbnail.peaks).catch(() => undefined) : undefined;
      const readyAsset = { ...asset, ...info, waveformPeaks, fileStatus: "ready" as const };
      this.update({ assets: this.state.assets.map((item) => item.id === id ? readyAsset : item) });
      this.renderPreview(true);
      if (handle) {
        const { assets: _assets, clips: _clips, ...project } = this.currentProjectDocument();
        await saveHandleProject(readyAsset, this.state.clips, project).catch(() => { /* Persistence failure must not invalidate a decoded asset. */ });
      }
      this.toast(`${file.name} を読み込みました${extension ? ` · ${extension.toUpperCase()}` : ""}`);
      return id;
    } catch (error) {
      this.update({ assets: this.state.assets.map((item) => item.id === id ? { ...item, fileStatus: "missing" } : item) });
      this.toast(error instanceof Error ? `${file.name}: ${error.message}` : `${file.name} を読み込めませんでした`);
      return null;
    }
  };

  stageExplorerFile = (sourcePath: string, file?: File, handle?: FileSystemFileHandle) => {
    this.explorerFiles.set(sourcePath, { file, handle });
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
    if (!window.queryLocalFonts) {
      this.toast("このブラウザはLocal Font Access APIに対応していません");
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const unique = new Map<string, FontFaceInfo>();
      this.localFontEntries.clear();
      fonts.forEach((font) => {
        unique.set(font.postscriptName, font);
        this.localFontEntries.set(font.postscriptName, font);
      });
      this.update({ fonts: [...unique.values()].slice(0, 500) });
      this.toast(`${unique.size} 個のローカルフォントを利用できます`);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast("ローカルフォントへのアクセスが拒否されました");
    }
  };

  clearCache = () => this.engine.clearCache();
  upsertGeometry = (object: SceneObjectSpec) => this.engine.upsertGeometry(object);
  removeGeometry = (id: string) => this.engine.removeGeometry(id);
}

const MEDIA_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "wav", "mp3", "aac", "flac", "png", "jpg", "jpeg", "webp", "hdr", "exr", "glb"]);

function mediaKindForFile(file: File): MediaAsset["kind"] | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!MEDIA_EXTENSIONS.has(extension) && !file.type.startsWith("video/") && !file.type.startsWith("audio/") && !file.type.startsWith("image/")) return null;
  if (extension === "glb" || file.type === "model/gltf-binary") return "model";
  if (file.type.startsWith("audio/") || ["wav", "mp3", "aac", "flac"].includes(extension)) return "audio";
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "hdr", "exr"].includes(extension)) return "image";
  return "video";
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
    transform: { name: "変形", enabled: true, params: { x: 0, y: 0, scale: 100, rotation: 0 } },
    brightness: { name: "明るさ", enabled: true, params: { amount: 0 } },
    tint: { name: "色調", enabled: true, params: { red: 100, green: 100, blue: 100 } },
    opacity: { name: "透明度", enabled: true, params: { amount: 100 } },
    contrast: { name: "コントラスト", enabled: true, params: { amount: 0 } },
    saturation: { name: "彩度", enabled: true, params: { amount: 100 } },
    gamma: { name: "ガンマ", enabled: true, params: { amount: 100 } },
    hue: { name: "色相", enabled: true, params: { angle: 0 } },
    chromaKey: { name: "クロマキー", enabled: true, params: { red: 0, green: 100, blue: 0, threshold: 20, softness: 10 } },
    vignette: { name: "ビネット", enabled: true, params: { amount: 35, size: 65 } },
    pixelate: { name: "ピクセル化", enabled: true, params: { size: 8 } },
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
