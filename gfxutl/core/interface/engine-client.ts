import type { EngineRequest, EngineResponse, ExportSettings, RenderClip, SceneObjectSpec, SceneSettings, TimelinePatch } from "../protocol/engine-protocol";

type MediaInfo = { duration: number; width?: number; height?: number; codec?: string; hasAudio?: boolean };
type ExportResult = { buffer: ArrayBuffer; mimeType: string };
export type AudioPreviewChunk = { timestamp: number; duration: number; sampleRate: number; channels: ArrayBuffer[] };
export type MediaThumbnail = { bitmap?: ImageBitmap; peaks?: number[] };

export class EngineClient {
  private port: MessagePort | null = null;
  private outbox: Array<{ message: Exclude<EngineRequest, { type: "init" }>; transfer: Transferable[] }> = [];
  private pending = new Map<string, { resolve: (value: MediaInfo) => void; reject: (reason: Error) => void }>();
  private pendingExports = new Map<string, { resolve: (value: ExportResult) => void; reject: (reason: Error) => void }>();
  private pendingAudio = new Map<string, { resolve: (value: AudioPreviewChunk[]) => void; reject: (reason: Error) => void }>();
  private pendingThumbnails = new Map<string, { resolve: (value: MediaThumbnail) => void; reject: (reason: Error) => void }>();
  private pendingPicks = new Map<string, (clipId: string | undefined) => void>();
  private renderSequence = 0;
  private renderInFlight = false;
  private pendingRender: { time: number; cache: boolean; mode: "realtime" | "playback"; fps: number; sceneSettings: SceneSettings } | null = null;
  private pendingTimelinePatch: TimelinePatch | null = null;
  private lastSceneSettings: SceneSettings | null = null;

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
      this.pendingPicks.get(message.requestId)?.(message.clipId);
      this.pendingPicks.delete(message.requestId);
    } else if (message.type === "render-complete") {
      this.renderInFlight = false;
      this.flushPendingRender();
    } else if (message.type === "error" && message.requestId) {
      this.pending.get(message.requestId)?.reject(new Error(message.message));
      this.pendingExports.get(message.requestId)?.reject(new Error(message.message));
      this.pendingAudio.get(message.requestId)?.reject(new Error(message.message));
      this.pendingThumbnails.get(message.requestId)?.reject(new Error(message.message));
      this.pending.delete(message.requestId);
      this.pendingExports.delete(message.requestId);
      this.pendingAudio.delete(message.requestId);
      this.pendingThumbnails.delete(message.requestId);
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
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = this.receive;
    this.port.start();
    const message: Extract<EngineRequest, { type: "init" }> = { type: "init", canvas, port: channel.port2, width, height, dpr };
    this.worker.postMessage(message, [canvas, channel.port2]);
    for (const queued of this.outbox.splice(0)) this.port.postMessage(queued.message, queued.transfer);
  }

  attachCanvas(canvas: OffscreenCanvas, width: number, height: number, dpr: number) {
    this.post({ type: "attach-canvas", canvas, width, height, dpr }, [canvas]);
  }

  resize(width: number, height: number, dpr: number) { this.post({ type: "resize", width, height, dpr }); }
  patchTimeline(patch: TimelinePatch) { this.pendingTimelinePatch = mergeTimelinePatches(this.pendingTimelinePatch, patch); }
  render(time: number, cache: boolean, mode: "realtime" | "playback", fps: number, sceneSettings: SceneSettings) {
    // Keep at most one GPU/decode operation in flight. During a slow frame the
    // newest playhead position supersedes every intermediate request.
    this.pendingRender = { time, cache, mode, fps, sceneSettings };
    this.flushPendingRender();
  }

  private flushPendingRender() {
    if (this.renderInFlight || !this.pendingRender) return;
    const next = this.pendingRender;
    this.pendingRender = null;
    const sequence = ++this.renderSequence;
    const settingsChanged = next.sceneSettings !== this.lastSceneSettings;
    if (settingsChanged) this.lastSceneSettings = next.sceneSettings;
    const patch = this.pendingTimelinePatch;
    this.pendingTimelinePatch = null;
    if (patch) this.post({ type: "timeline-patch", patch });
    this.renderInFlight = true;
    this.post({
      type: "render", sequence, time: next.time, cache: next.cache,
      mode: next.mode, fps: next.fps,
      ...(settingsChanged ? { sceneSettings: next.sceneSettings } : {}),
    });
  }

  inspectMedia(file: File, assetId: string) {
    const requestId = crypto.randomUUID();
    return new Promise<MediaInfo>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.post({ type: "inspect-media", requestId, assetId, file });
    });
  }

  inspectImage(file: File, assetId: string) {
    const requestId = crypto.randomUUID();
    return new Promise<MediaInfo>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.post({ type: "inspect-image", requestId, assetId, file });
    });
  }

  inspectModel(file: File, assetId: string) {
    const requestId = crypto.randomUUID();
    return new Promise<MediaInfo>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.post({ type: "inspect-model", requestId, assetId, file });
    });
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

  pick(ndcX: number, ndcY: number) {
    const requestId = crypto.randomUUID();
    return new Promise<string | undefined>((resolve) => {
      this.pendingPicks.set(requestId, resolve);
      this.post({ type: "pick", requestId, ndcX, ndcY });
    });
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

  configurePreviewCache(enabled: boolean, maxBytes: number) { this.post({ type: "preview-cache-settings", enabled, maxBytes }); }
  clearCache() { this.post({ type: "clear-cache" }); }
  upsertGeometry(object: SceneObjectSpec) { this.post({ type: "geometry-upsert", object }); }
  removeGeometry(id: string) { this.post({ type: "geometry-remove", id }); }
  registerFont(fontId: string, buffer: ArrayBuffer) { this.post({ type: "font-register", fontId, buffer }, [buffer]); }
}

function mergeTimelinePatches(previous: TimelinePatch | null, next: TimelinePatch): TimelinePatch {
  if (!previous) return next;
  const upserts = new Map(previous.upserts.map((clip) => [clip.id, clip]));
  const removes = new Set(previous.removes);
  for (const id of next.removes) { upserts.delete(id); removes.add(id); }
  for (const clip of next.upserts) { removes.delete(clip.id); upserts.set(clip.id, clip); }
  return {
    revision: next.revision,
    upserts: [...upserts.values()],
    removes: [...removes],
    invalidatedRanges: mergeInvalidatedRanges([...previous.invalidatedRanges, ...next.invalidatedRanges]),
  };
}

function mergeInvalidatedRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const tail = merged.at(-1);
    if (tail && range.start <= tail.end) tail.end = Math.max(tail.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
