import type { EngineRequest, EngineResponse, ExportSettings, MediaFileSource, MediaReadGraph, PreviewPickResult, PreviewView, RenderClip, SceneObjectSpec, SceneSettings, SceneSettingsPatch, TimelinePatch, TimelineSnapshot } from "../protocol/engine-protocol";
import type { RendererPluginBundle, RendererPluginInfo } from "../plugins/plugin-types";
import nagaWasmUrl from "../naga-wasm/pkg/naga_wasm_bg.wasm?url";

type MediaInfo = Extract<EngineResponse, { type: "media-info" }>;
type ExportResult = { buffer: ArrayBuffer; mimeType: string };
export type AudioPreviewChunk = { timestamp: number; duration: number; sampleRate: number; channels: ArrayBuffer[] };
export type MediaThumbnail = { bitmap?: ImageBitmap; frame?: VideoFrame; peaks?: number[] };

export class EngineClient {
  private port: MessagePort | null = null;
  private outbox: Array<{ message: Exclude<EngineRequest, { type: "init" }>; transfer: Transferable[] }> = [];
  private pending = new Map<string, { resolve: (value: MediaInfo) => void; reject: (reason: Error) => void }>();
  private pendingExports = new Map<string, { resolve: (value: ExportResult) => void; reject: (reason: Error) => void }>();
  private pendingAudio = new Map<string, { resolve: (value: AudioPreviewChunk[]) => void; reject: (reason: Error) => void }>();
  private pendingThumbnails = new Map<string, { resolve: (value: MediaThumbnail) => void; reject: (reason: Error) => void }>();
  private pendingPicks = new Map<string, (result: PreviewPickResult) => void>();
  private pendingShaders = new Map<string, { resolve: (wgsl: string) => void; reject: (reason: Error) => void }>();
  private pendingPlugins = new Map<string, { resolve: (plugin: RendererPluginInfo) => void; reject: (reason: Error) => void }>();
  private pickInFlight = false;
  private pickQueue: Array<{ ndcX: number; ndcY: number; coalescible: boolean; resolves: Array<(result: PreviewPickResult) => void> }> = [];
  private renderSequence = 0;
  private renderInFlight = false;
  private pendingRender: { time: number; cache: boolean; mode: "realtime" | "playback"; fps: number; sceneSettings: SceneSettings; previewView: PreviewView; focusClipId?: string } | null = null;
  private pendingTimelinePatch: TimelinePatch | null = null;
  private lastSceneSettings: SceneSettings | null = null;
  private lastResize = "";
  private initialPreviewCache: { enabled: boolean; maxBytes: number } | undefined;
  private mediaFiles = new Map<string, File>();
  private mediaBufferLoads = new Set<string>();
  private mediaGraphRevision = 0;
  private mediaGraphSignature = "";
  private initializing = false;

  constructor(private worker: Worker, private onMessage: (message: EngineResponse) => void) {
    this.worker.onerror = (event) => this.onMessage({ type: "error", message: event.message || "Workerの初期化に失敗しました" });
  }

  private receive = (event: MessageEvent<EngineResponse>) => {
    const message = event.data;
    if (message.type === "media-info") {
      this.pending.get(message.requestId)?.resolve(message);
      this.pending.delete(message.requestId);
    } else if (message.type === "export-complete") {
      this.pendingExports.get(message.requestId)?.resolve(message);
      this.pendingExports.delete(message.requestId);
    } else if (message.type === "audio-preview-data") {
      this.pendingAudio.get(message.requestId)?.resolve(message.chunks);
      this.pendingAudio.delete(message.requestId);
    } else if (message.type === "media-thumbnail") {
      this.pendingThumbnails.get(message.requestId)?.resolve(message);
      this.pendingThumbnails.delete(message.requestId);
    } else if (message.type === "pick-result") {
      this.pendingPicks.get(message.requestId)?.({ clipId: message.clipId, handle: message.handle, camera: message.camera });
      this.pendingPicks.delete(message.requestId);
    } else if (message.type === "glsl-compiled") {
      this.pendingShaders.get(message.requestId)?.resolve(message.wgsl);
      this.pendingShaders.delete(message.requestId);
    } else if (message.type === "plugin-state" && message.requestId) {
      this.pendingPlugins.get(message.requestId)?.resolve(message.plugin);
      this.pendingPlugins.delete(message.requestId);
    } else if (message.type === "render-complete") {
      this.renderInFlight = false;
      this.flushPendingRender();
    } else if (message.type === "media-buffer-state") {
      for (const assetId of message.residentAssetIds) this.mediaBufferLoads.delete(assetId);
      for (const assetId of message.requestedAssetIds) this.loadMediaBufferAsset(assetId);
    } else if (message.type === "error" && message.requestId) {
      this.pending.get(message.requestId)?.reject(new Error(message.message));
      this.pendingExports.get(message.requestId)?.reject(new Error(message.message));
      this.pendingAudio.get(message.requestId)?.reject(new Error(message.message));
      this.pendingThumbnails.get(message.requestId)?.reject(new Error(message.message));
      this.pendingPicks.get(message.requestId)?.({});
      this.pendingShaders.get(message.requestId)?.reject(new Error(message.message));
      this.pendingPlugins.get(message.requestId)?.reject(new Error(message.message));
      this.pending.delete(message.requestId);
      this.pendingExports.delete(message.requestId);
      this.pendingAudio.delete(message.requestId);
      this.pendingThumbnails.delete(message.requestId);
      this.pendingPicks.delete(message.requestId);
      this.pendingShaders.delete(message.requestId);
      this.pendingPlugins.delete(message.requestId);
    }
    this.onMessage(message);
  };

  private post(message: Exclude<EngineRequest, { type: "init" }>, transfer: Transferable[] = []) {
    if (!this.port) { this.outbox.push({ message, transfer }); return; }
    this.port.postMessage(message, transfer);
  }

  init(canvas: OffscreenCanvas, width: number, height: number, dpr: number) {
    if (this.port) {
      this.attachCanvas(canvas, width, height, dpr);
      return;
    }
    if (this.initializing) return;
    this.initializing = true;
    void this.initialize(canvas, width, height, dpr);
  }

  private async initialize(canvas: OffscreenCanvas, width: number, height: number, dpr: number) {
    try {
      const response = await fetch(nagaWasmUrl);
      if (!response.ok) throw new Error(`Naga WASMを取得できませんでした (${response.status})`);
      const nagaWasm = await response.arrayBuffer();
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = this.receive;
      this.port.start();
      const message: Extract<EngineRequest, { type: "init" }> = {
        type: "init", canvas, port: channel.port2, width, height, dpr, nagaWasm,
        ...(this.initialPreviewCache ? { previewCache: this.initialPreviewCache } : {}),
      };
      this.worker.postMessage(message, [canvas, channel.port2, nagaWasm]);
      this.lastResize = `${width}:${height}:${dpr}`;
      for (const queued of this.outbox.splice(0)) this.port.postMessage(queued.message, queued.transfer);
    } catch (error) {
      this.onMessage({ type: "error", message: error instanceof Error ? error.message : "レンダラーを初期化できませんでした" });
    } finally {
      this.initializing = false;
    }
  }

  attachCanvas(canvas: OffscreenCanvas, width: number, height: number, dpr: number) {
    this.lastResize = `${width}:${height}:${dpr}`;
    this.post({ type: "attach-canvas", canvas, width, height, dpr }, [canvas]);
  }

  resize(width: number, height: number, dpr: number) {
    const signature = `${width}:${height}:${dpr}`;
    if (signature === this.lastResize) return;
    this.lastResize = signature;
    this.post({ type: "resize", width, height, dpr });
  }
  syncTimeline(snapshot: TimelineSnapshot) {
    this.pendingTimelinePatch = null;
    this.post({ type: "timeline-sync", snapshot });
  }
  patchTimeline(patch: TimelinePatch) {
    this.pendingTimelinePatch = mergeTimelinePatches(this.pendingTimelinePatch, patch);
    if (!this.renderInFlight) this.flushPendingTimeline();
  }
  render(time: number, cache: boolean, mode: "realtime" | "playback", fps: number, sceneSettings: SceneSettings, previewView: PreviewView, focusClipId?: string) {
    // Keep at most one GPU/decode operation in flight. During a slow frame the
    // newest playhead position supersedes every intermediate request.
    this.pendingRender = { time, cache, mode, fps, sceneSettings, previewView, focusClipId };
    this.flushPendingRender();
  }

  private flushPendingRender() {
    if (this.renderInFlight) return;
    this.flushPendingTimeline();
    if (!this.pendingRender) return;
    const next = this.pendingRender;
    this.pendingRender = null;
    const sequence = ++this.renderSequence;
    const sceneSettingsPatch = diffSceneSettings(this.lastSceneSettings, next.sceneSettings);
    this.lastSceneSettings = next.sceneSettings;
    this.renderInFlight = true;
    this.post({
      type: "render", sequence, time: next.time, cache: next.cache,
      mode: next.mode, fps: next.fps, previewView: next.previewView,
      ...(next.focusClipId ? { focusClipId: next.focusClipId } : {}),
      ...(sceneSettingsPatch ? { sceneSettingsPatch } : {}),
    });
  }

  private flushPendingTimeline() {
    if (!this.pendingTimelinePatch) return;
    const patch = this.pendingTimelinePatch;
    this.pendingTimelinePatch = null;
    this.post({ type: "timeline-patch", patch });
  }

  inspectMedia(file: File, assetId: string, handle?: FileSystemFileHandle) {
    const requestId = crypto.randomUUID();
    this.mediaFiles.set(assetId, file);
    return new Promise<MediaInfo>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const stream = file.stream();
      this.post({ type: "inspect-media", requestId, assetId, source: mediaFileSource(file), stream }, [stream as unknown as Transferable]);
    });
  }

  inspectImage(file: File, assetId: string, handle?: FileSystemFileHandle) {
    const requestId = crypto.randomUUID();
    this.mediaFiles.set(assetId, file);
    return new Promise<MediaInfo>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const stream = file.stream();
      this.post({ type: "inspect-image", requestId, assetId, source: mediaFileSource(file), stream }, [stream as unknown as Transferable]);
    });
  }

  inspectModel(file: File, assetId: string, handle?: FileSystemFileHandle) {
    const requestId = crypto.randomUUID();
    this.mediaFiles.set(assetId, file);
    return new Promise<MediaInfo>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const stream = file.stream();
      this.post({ type: "inspect-model", requestId, assetId, source: mediaFileSource(file), stream }, [stream as unknown as Transferable]);
    });
  }

  releaseMedia(assetId: string) {
    this.mediaFiles.delete(assetId);
    this.mediaBufferLoads.delete(assetId);
    this.post({ type: "release-media", assetId });
  }

  setMediaReadGraph(graph: Omit<MediaReadGraph, "revision">) {
    const signature = JSON.stringify(graph);
    if (signature === this.mediaGraphSignature) return;
    this.mediaGraphSignature = signature;
    this.post({ type: "media-buffer-plan", graph: { ...graph, revision: ++this.mediaGraphRevision } });
  }

  private loadMediaBufferAsset(assetId: string) {
    const file = this.mediaFiles.get(assetId);
    if (!file || this.mediaBufferLoads.has(assetId)) return;
    this.mediaBufferLoads.add(assetId);
    const stream = file.stream();
    this.post({ type: "media-buffer-load", assetId, source: mediaFileSource(file), stream }, [stream as unknown as Transferable]);
  }

  decodeAudioPreview(assetId: string, startTime: number, endTime: number) {
    const requestId = crypto.randomUUID();
    return new Promise<AudioPreviewChunk[]>((resolve, reject) => {
      this.pendingAudio.set(requestId, { resolve, reject });
      this.post({ type: "decode-audio-preview", requestId, assetId, startTime, endTime });
    });
  }

  getMediaThumbnail(assetId: string, time = 0) {
    const requestId = crypto.randomUUID();
    return new Promise<MediaThumbnail>((resolve, reject) => {
      this.pendingThumbnails.set(requestId, { resolve, reject });
      this.post({ type: "media-thumbnail", requestId, assetId, time });
    });
  }

  pick(ndcX: number, ndcY: number, coalesce = false) {
    return new Promise<PreviewPickResult>((resolve) => {
      const tail = this.pickQueue.at(-1);
      if (coalesce && tail?.coalescible) {
        tail.ndcX = ndcX;
        tail.ndcY = ndcY;
        tail.resolves.push(resolve);
      } else {
        this.pickQueue.push({ ndcX, ndcY, coalescible: coalesce, resolves: [resolve] });
      }
      this.flushPendingPick();
    });
  }

  moveInspectorCamera(operation: "orbit" | "pan", deltaX: number, deltaY: number) {
    this.post({ type: "inspector-camera", operation, deltaX, deltaY });
  }

  setTransformHandles(clipId?: string) {
    this.post({ type: "transform-handles", clipId });
  }

  setCameraHandles(visible: boolean) {
    this.post({ type: "camera-handles", visible });
  }

  compileGlsl(source: string) {
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      this.pendingShaders.set(requestId, { resolve, reject });
      this.post({ type: "compile-glsl", requestId, source });
    });
  }

  loadRendererPlugin(plugin: RendererPluginBundle) {
    const requestId = crypto.randomUUID();
    return new Promise<RendererPluginInfo>((resolve, reject) => {
      this.pendingPlugins.set(requestId, { resolve, reject });
      this.post({ type: "plugin-load", requestId, plugin });
    });
  }

  unloadRendererPlugin(pluginId: string) {
    this.post({ type: "plugin-unload", pluginId });
  }

  private flushPendingPick() {
    if (this.pickInFlight || !this.pickQueue.length) return;
    const next = this.pickQueue.shift()!;
    this.pickInFlight = true;
    const requestId = crypto.randomUUID();
    this.pendingPicks.set(requestId, (result) => {
      for (const resolve of next.resolves) resolve(result);
      this.pickInFlight = false;
      this.flushPendingPick();
    });
    this.post({ type: "pick", requestId, ndcX: next.ndcX, ndcY: next.ndcY });
  }

  exportVideo(settings: ExportSettings, duration: number, clips: RenderClip[], sceneSettings: SceneSettings, audioChannels: "stereo" | "mono") {
    const requestId = crypto.randomUUID();
    return new Promise<ExportResult>((resolve, reject) => {
      this.pendingExports.set(requestId, { resolve, reject });
      this.post({ type: "export", requestId, settings, duration, clips, sceneSettings, audioChannels });
    });
  }

  exportStill(width: number, height: number, time: number, clips: RenderClip[], sceneSettings: SceneSettings) {
    const requestId = crypto.randomUUID();
    return new Promise<ExportResult>((resolve, reject) => {
      this.pendingExports.set(requestId, { resolve, reject });
      this.post({ type: "export-still", requestId, width, height, time, clips, sceneSettings });
    });
  }

  configurePreviewCache(enabled: boolean, maxBytes: number) {
    if (!this.port) {
      this.initialPreviewCache = { enabled, maxBytes };
      return;
    }
    this.post({ type: "preview-cache-settings", enabled, maxBytes });
  }
  clearCache() { this.post({ type: "clear-cache" }); }
  upsertGeometry(object: SceneObjectSpec) { this.post({ type: "geometry-upsert", object }); }
  removeGeometry(id: string) { this.post({ type: "geometry-remove", id }); }
  registerFont(fontId: string, buffer: ArrayBuffer) { this.post({ type: "font-register", fontId, buffer }, [buffer]); }
}

function mediaFileSource(file: File): MediaFileSource {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
}

function mergeTimelinePatches(previous: TimelinePatch | null, next: TimelinePatch): TimelinePatch {
  if (!previous) return next;
  const upserts = new Map(previous.upserts.map((clip) => [clip.id, clip]));
  const removes = new Set(previous.removes);
  for (const id of next.removes) { upserts.delete(id); removes.add(id); }
  for (const clip of next.upserts) { removes.delete(clip.id); upserts.set(clip.id, clip); }
  return { revision: next.revision, upserts: [...upserts.values()], removes: [...removes] };
}

function diffSceneSettings(previous: SceneSettings | null, next: SceneSettings): SceneSettingsPatch | null {
  if (!previous) return {
    background: next.background,
    camera: next.camera,
    renderer: next.renderer,
    lights: next.lights,
    keyframes: next.keyframes ?? null,
  };
  const patch: SceneSettingsPatch = {};
  const background = diffRecord(previous.background, next.background);
  const camera = diffRecord(previous.camera, next.camera);
  const renderer = diffRecord(previous.renderer, next.renderer);
  if (background) patch.background = background;
  if (camera) patch.camera = camera;
  if (renderer) patch.renderer = renderer;
  if (!sameValue(previous.lights, next.lights)) patch.lights = next.lights;
  if (!sameValue(previous.keyframes, next.keyframes)) patch.keyframes = next.keyframes ?? null;
  return Object.keys(patch).length ? patch : null;
}

function diffRecord<T extends object>(previous: T, next: T): Partial<T> | null {
  const patch: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (!sameValue(previous[key], next[key])) patch[key] = next[key];
  }
  return Object.keys(patch).length ? patch : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (Object.is(a, b)) continue;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null || JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}
