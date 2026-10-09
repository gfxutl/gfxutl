import type { ClipEffect, ClipEffectKind, ClipKeyframe, ContextMenuState, EditorLayout, EditorState, EngineResponse, ExportSettings, FontFaceInfo, GeometryKind, KeyframeProperty, MediaAsset, RenderClip, SceneObjectSpec, SceneSettings, TimelineClip } from "./types";
import { EngineClient } from "./engine-client";
import { VirtualTimeline } from "./virtual-timeline";
import { loadHandleProjects, saveHandleProject } from "../persistence/handle-project-store";

type Listener = () => void;

const MiB = 1024 * 1024;

const defaultLayout: EditorLayout = { leftPanelWidth: 286, rightPanelWidth: 294, timelineHeight: 309 };

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

const initialState: EditorState = {
  fps: 30,
  duration: 32,
  currentTime: 0,
  playing: false,
  zoom: 1,
  snapEnabled: true,
  selectedClipId: null,
  selectedClipIds: [],
  selectedAssetId: null,
  backgroundSelected: false,
  background: { id: "background", name: "背景オブジェクト", color: 0xffffff, scene: structuredClone(defaultSceneSettings) },
  assets: [],
  clips: [],
  fonts: [],
  cache: { usedBytes: 0, maxBytes: 128 * MiB, entries: 0, codec: "H.264" },
  engine: "initializing",
  cameraProjection: "orthographic",
  mediaBunnyReady: false,
  fileSystemAccess: "showOpenFilePicker" in window,
  localFontAccess: "queryLocalFonts" in window,
  notice: null,
  layout: loadLayout(),
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
  gain: GainNode;
  panner: StereoPannerNode;
}

export class EditorController {
  private state = initialState;
  private listeners = new Set<Listener>();
  private engine: EngineClient;
  private virtualTimeline = new VirtualTimeline();
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
  private memoryClipboard: ClipboardPayload | null = null;
  private audioContext: AudioContext | null = null;
  private audioVoices = new Map<string, PreviewAudioVoice>();
  private audioPreviewToken = 0;
  private activeAudioSignature = "";

  constructor(worker: Worker) {
    this.engine = new EngineClient(worker, (message) => this.onEngineMessage(message));
    void this.restoreHandleProjects();
  }

  getSnapshot = () => this.state;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

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
      for (const asset of this.state.assets) void saveHandleProject(asset, this.state.clips);
    }, 200);
  }

  private async restoreHandleProjects() {
    try {
      const records = await loadHandleProjects();
      if (!records.length) return;
      const assets = records.map((record) => ({ ...record.asset, handle: record.handle, fileStatus: "loading" as const }));
      const clips = [...new Map(records.flatMap((record) => record.clips).map((clip) => [clip.id, clip])).values()];
      this.update({ assets, clips, duration: Math.max(32, ...clips.map((clip) => clip.start + clip.duration + 2)) });
      await Promise.allSettled(assets.map((asset) => this.restoreAssetFile(asset.id, false)));
      this.renderPreview(true);
    } catch {
      // IndexedDB or a persisted handle may be unavailable in private browsing.
    }
  }

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
      const info = { size: file.size, lastModified: file.lastModified, ...await this.registerRuntimeFile(asset, file) };
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
    if (asset.kind === "image") return this.engine.inspectImage(file, asset.id);
    if (asset.kind === "model") return this.engine.inspectModel(file, asset.id);
    const info = await this.engine.inspectMedia(file, asset.id);
    return info;
  }

  private stopAudioPreview() {
    this.audioPreviewToken++;
    this.activeAudioSignature = "";
    for (const voice of this.audioVoices.values()) {
      for (const source of voice.sources) { try { source.stop(); } catch { /* Already stopped. */ } }
      voice.sources.clear();
      voice.gain.disconnect();
      voice.panner.disconnect();
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
    voice.gain.gain.value = Math.max(0, Math.min(4, 10 ** ((clip.volume ?? 0) / 20)));
    voice.panner.pan.value = Math.max(-1, Math.min(1, (clip.pan ?? 0) / 100));
  }

  private async scheduleAudioPreview(clip: TimelineClip, token: number) {
    if (!clip.assetId) return;
    const context = this.audioContext ??= new AudioContext({ latencyHint: "interactive" });
    await context.resume();
    if (token !== this.audioPreviewToken || !this.state.playing) return;
    const speed = Math.max(0.25, Math.min(4, (clip.speed ?? 100) / 100));
    const mediaStart = Math.max(0, clip.offset + (this.state.currentTime - clip.start) * speed);
    const mediaEnd = mediaStart + Math.max(0, clip.start + clip.duration - this.state.currentTime) * speed;
    const contextStart = context.currentTime + 0.04;
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    gain.connect(panner).connect(context.destination);
    const voice: PreviewAudioVoice = { token, sources: new Set(), gain, panner };
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
          const buffer = context.createBuffer(sample.channels.length, frameCount, sample.sampleRate);
          sample.channels.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index));
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = speed;
          source.connect(gain);
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
    } else if (message.type === "preview-source") {
      this.pendingPreviewFrames++;
      this.pendingCachedFrames += message.source === "cache" ? 1 : 0;
      this.pendingPreviewSource = message.source;
      if (message.source !== this.state.previewSource) this.flushPreviewMetrics();
      else if (!this.previewMetricTimer) this.previewMetricTimer = window.setTimeout(() => this.flushPreviewMetrics(), 250);
    } else if (message.type === "renderer-stats") {
      this.update({ rendererStats: message.stats });
    } else if (message.type === "error") {
      this.toast(message.message);
    }
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
    this.engine.render(this.state.currentTime, cache, this.state.playing ? "playback" : "realtime", this.state.fps, this.state.background.scene);
  }

  private getRenderClips(): RenderClip[] {
    if (this.renderClipSource === this.state.clips) return this.renderClipCache;
    const depth = new Map([...this.state.clips]
      .sort((a, b) => (a.positionZ ?? 0) - (b.positionZ ?? 0) || b.y - a.y)
      .map((clip, index) => [clip.id, 1_000 + index]));
    this.renderClipSource = this.state.clips;
    this.renderClipCache = this.state.clips.map((clip) => ({
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
      volume: clip.volume ?? 100,
      pan: clip.pan ?? 0,
      speed: clip.speed ?? 100,
      cropLeft: clip.cropLeft ?? 0,
      cropRight: clip.cropRight ?? 0,
      cropTop: clip.cropTop ?? 0,
      cropBottom: clip.cropBottom ?? 0,
      effects: clip.effects ?? [],
      keyframes: clip.keyframes ?? [],
      particleSystem: clip.particleSystem,
      timelineY: clip.y,
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
        depthTest: true, depthWrite: (clip.opacity ?? 100) >= 100, transparent: (clip.opacity ?? 100) < 100,
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
  setZoom = (zoom: number) => this.update({ zoom: Math.max(0.6, Math.min(2.4, zoom)) });
  toggleSnap = () => this.update({ snapEnabled: !this.state.snapEnabled });
  selectClip = (id: string, additive = false) => {
    const clip = this.state.clips.find((item) => item.id === id);
    const selectedClipIds = additive
      ? this.state.selectedClipIds.includes(id) ? this.state.selectedClipIds.filter((item) => item !== id) : [...this.state.selectedClipIds, id]
      : [id];
    this.update({ selectedClipId: selectedClipIds.includes(id) ? id : selectedClipIds.at(-1) ?? null, selectedClipIds, selectedAssetId: clip?.assetId ?? null, backgroundSelected: false });
  };
  selectClips = (ids: string[], additive = false) => {
    const selectedClipIds = additive ? [...new Set([...this.state.selectedClipIds, ...ids])] : ids;
    const selectedClipId = selectedClipIds.at(-1) ?? null;
    const clip = this.state.clips.find((item) => item.id === selectedClipId);
    this.update({ selectedClipIds, selectedClipId, selectedAssetId: clip?.assetId ?? null, backgroundSelected: false });
  };
  selectAsset = (id: string | null) => this.update({ selectedAssetId: id, selectedClipId: null, selectedClipIds: [], backgroundSelected: false });
  selectBackground = () => this.update({ backgroundSelected: true, selectedAssetId: null, selectedClipId: null, selectedClipIds: [] });
  updateBackground = (patch: Partial<EditorState["background"]>) => {
    const next = { ...this.state.background, ...patch };
    if (patch.color !== undefined) next.scene = { ...next.scene, background: { ...next.scene.background, color: patch.color } };
    this.update({ background: next, backgroundSelected: true });
    this.engine.clearCache();
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
    this.engine.clearCache();
    this.renderPreview(true);
  };
  openContextMenu = (menu: ContextMenuState) => this.update({ contextMenu: menu });
  closeContextMenu = () => this.update({ contextMenu: null });
  setLeftPanelTab = (tab: EditorState["leftPanelTab"]) => this.update({ leftPanelTab: tab });
  updateExportSettings = (patch: Partial<ExportSettings>) => {
    const next = { ...this.state.exportSettings, ...patch };
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
  pickPreview = (ndcX: number, ndcY: number) => this.engine.pick(ndcX, ndcY);

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
    const deltaStart = Math.max(0, start) - anchor.start;
    const deltaY = Math.max(0, y) - anchor.y;
    const minimumStart = Math.min(...this.state.clips.filter((clip) => selectedIds.includes(clip.id)).map((clip) => clip.start));
    const minimumY = Math.min(...this.state.clips.filter((clip) => selectedIds.includes(clip.id)).map((clip) => clip.y));
    const safeDeltaStart = Math.max(deltaStart, -minimumStart);
    const safeDeltaY = Math.max(deltaY, -minimumY);
    let end = this.state.duration;
    const clips = this.state.clips.map((clip) => {
      if (!selectedIds.includes(clip.id)) return clip;
      const nextStart = clip.start + safeDeltaStart;
      const nextY = clip.y + safeDeltaY;
      end = Math.max(end, nextStart + clip.duration + 2);
      return { ...clip, start: nextStart, y: nextY };
    });
    this.update({ clips, duration: end, selectedClipId: id, selectedClipIds: selectedIds });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, true);
  };

  updateClip = (id: string, patch: Partial<import("./types").TimelineClip>) => {
    this.update({ clips: this.state.clips.map((clip) => clip.id === id ? { ...clip, ...patch } : clip) });
    this.invalidatePreviewCache();
    this.schedulePersistence();
    this.renderPreview(false);
    if (this.state.playing) this.syncAudioPlayback(true, "start" in patch || "duration" in patch || "offset" in patch || "speed" in patch);
  };

  removeClip = (id: string) => {
    const selectedClipIds = this.state.selectedClipIds.filter((item) => item !== id);
    this.update({ clips: this.state.clips.filter((clip) => clip.id !== id), selectedClipId: this.state.selectedClipId === id ? selectedClipIds.at(-1) ?? null : this.state.selectedClipId, selectedClipIds });
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
    const names: Partial<Record<GeometryKind, string>> = { box: "立方体", sphere: "球体", plane: "平面", torus: "トーラス" };
    const args: Partial<Record<GeometryKind, number[]>> = { box: [2, 2, 0.5], sphere: [1.25, 32, 20], plane: [2.5, 2.5], torus: [1, 0.32, 16, 48] };
    const clip: TimelineClip = {
      id, name: names[kind] ?? kind, kind: "object", color: "#4f83a8", start,
      y: Math.max(0, placement?.timelineY ?? 92), duration: 5, offset: 0,
      positionX: (placement?.positionX ?? 0) + stagger.x, positionY: (placement?.positionY ?? 0) + stagger.y,
      positionZ: 0,
      scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 18, rotationY: -24, opacity: 100, textColor: 0x3d73a0,
      material: { kind: "standard", color: 0x3d73a0, roughness: 0.55, metalness: 0.08 }, castShadow: true, receiveShadow: true,
      geometry: { id: `${id}:geometry`, kind, args: args[kind] },
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
    this.update({
      clips: [...this.state.clips, clip], selectedClipId: clip.id, selectedClipIds: [clip.id], selectedAssetId: null,
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

  copySelection = async () => {
    const clips = this.state.clips.filter((item) => this.state.selectedClipIds.includes(item.id));
    if (!clips.length) return false;
    const payload: ClipboardPayload = { type: "gfxutl/timeline-object", version: 2, clips };
    this.memoryClipboard = payload;
    try { await navigator.clipboard?.writeText(JSON.stringify(payload)); } catch { /* In-memory fallback remains available. */ }
    this.toast(clips.length === 1 ? `${clips[0].name} をコピーしました` : `${clips.length} 個のオブジェクトをコピーしました`);
    return true;
  };

  cutSelection = async () => {
    const ids = [...this.state.selectedClipIds];
    if (!ids.length || !(await this.copySelection())) return;
    this.update({ clips: this.state.clips.filter((clip) => !ids.includes(clip.id)), selectedClipId: null, selectedClipIds: [] });
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
    const pasted = payload.clips.map((source) => {
      const id = crypto.randomUUID();
      return {
        ...structuredClone(source), id,
        geometry: source.geometry ? { ...structuredClone(source.geometry), id: `${id}:geometry` } : undefined,
        start: targetStart + source.start - minStart,
        y: targetY + source.y - minY,
        positionX: menu?.scope === "preview" ? menu.positionX : source.positionX,
        positionY: menu?.scope === "preview" ? menu.positionY : source.positionY,
      } satisfies TimelineClip;
    });
    this.update({
      clips: [...this.state.clips, ...pasted], selectedClipId: pasted.at(-1)?.id ?? null, selectedClipIds: pasted.map((clip) => clip.id), contextMenu: null,
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
      if (!selected.has(clip.id) || time <= clip.start + frame / 2 || time >= clip.start + clip.duration - frame / 2) return [clip];
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
    const keyframes = [...(clip.keyframes ?? [])];
    const existing = keyframes.find((keyframe) => keyframe.property === property && Math.abs(keyframe.time - time) <= tolerance);
    if (existing) Object.assign(existing, { value, interpolation, time });
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
    this.update({
      clips: [...this.state.clips, { id, assetId, y: Math.max(0, y), name: asset.name, start: nextStart, duration, offset: 0, color: asset.color, kind: asset.kind === "audio" ? "audio" : asset.kind === "model" ? "object" : "video", positionX: 0, positionY: 0, positionZ: 0, scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100, castShadow: true, receiveShadow: true }],
      selectedClipId: id,
      selectedClipIds: [id],
      currentTime: nextStart,
      duration: Math.max(this.state.duration, nextStart + duration + 2),
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
      const result = await this.engine.exportVideo(settings, Math.max(1 / settings.fps, settings.endTime - settings.startTime), this.getRenderClips(), this.state.background.scene);
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
      const id = crypto.randomUUID();
      const asset: MediaAsset = { id, name: file.name, kind: "model", duration: 5, size: file.size, lastModified: file.lastModified, color: "#557f9d", handle, fileStatus: "loading" };
      this.update({ assets: [...this.state.assets, asset], selectedAssetId: id, selectedClipId: null, selectedClipIds: [] });
      const info = await this.registerRuntimeFile(asset, file);
      this.update({ assets: this.state.assets.map((item) => item.id === id ? { ...item, ...info, fileStatus: "ready" } : item) });
      if (handle) await saveHandleProject(this.state.assets.find((item) => item.id === id)!, this.state.clips);
      this.toast(`${file.name} を3Dモデルとして読み込みました`);
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

      const extension = file.name.split(".").pop()?.toLowerCase();
      const kind: MediaAsset["kind"] = file.type.startsWith("audio") ? "audio" : file.type.startsWith("image") || extension === "hdr" || extension === "exr" ? "image" : "video";
      const id = crypto.randomUUID();
      const asset: MediaAsset = { id, name: file.name, kind, duration: kind === "image" ? 0 : 10, size: file.size, lastModified: file.lastModified, color: kind === "audio" ? "#50766c" : "#7e8072", handle, fileStatus: "loading" };
      this.update({ assets: [...this.state.assets, asset], selectedAssetId: id, selectedClipId: null, selectedClipIds: [] });
      const info = await this.registerRuntimeFile(asset, file);
      this.update({ assets: this.state.assets.map((item) => item.id === id ? { ...item, ...info, fileStatus: "ready" } : item) });
      this.renderPreview(true);
      if (handle) await saveHandleProject(this.state.assets.find((item) => item.id === id)!, this.state.clips);
      this.toast(`${file.name} を読み込みました${extension ? ` · ${extension.toUpperCase()}` : ""}`);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") this.toast("メディアを開けませんでした");
    }
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
