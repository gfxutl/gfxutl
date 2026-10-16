import { CustomSource } from "mediabunny";
import type { MediaFileSource, MediaReadGraph, SourceIoProfile } from "../protocol/engine-protocol";

export const MEDIA_BUFFER_MAX_BYTES = 128 * 1024 * 1024;

interface MediaBufferEntry {
  source: MediaFileSource;
  bytes: Uint8Array<ArrayBuffer>;
  profile: SourceIoProfile;
  touched: number;
  instances: Map<string, MediaBufferInstance>;
}

interface MediaBufferInstance {
  value: unknown;
  dispose: (value: unknown) => void;
}

export interface BufferedMediaSource {
  source: MediaFileSource;
  mediaSource: CustomSource;
  profile: SourceIoProfile;
  readAll(): Uint8Array<ArrayBuffer>;
}

export interface MediaBufferState {
  usedBytes: number;
  maxBytes: number;
  instanceCount: number;
  residentAssetIds: string[];
  requestedAssetIds: string[];
  skippedAssetIds: string[];
}

/**
 * Renderer-worker-owned asset residency. Each entry owns both the transferred
 * whole-file data and every decoded/Three.js instance built from that data.
 */
export class MediaBuffer {
  private entries = new Map<string, MediaBufferEntry>();
  private graph: MediaReadGraph = { revision: 0, roots: [], nodes: [], edges: [] };
  private clock = 0;
  private requestedAssetIds: string[] = [];
  private skippedAssetIds: string[] = [];

  constructor(readonly maxBytes = MEDIA_BUFFER_MAX_BYTES, private readonly onEvict?: (assetId: string) => void) {}

  get usedBytes() {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes.byteLength;
    return total;
  }

  has(assetId: string) { return this.entries.has(assetId); }

  setGraph(graph: MediaReadGraph) {
    this.graph = graph;
    const selected: string[] = [];
    const skipped: string[] = [];
    let available = this.maxBytes;
    for (const node of this.prioritizedNodes()) {
      if (node.size <= 0 || node.size > this.maxBytes || node.size > available) {
        skipped.push(node.assetId);
        continue;
      }
      selected.push(node.assetId);
      available -= node.size;
    }
    const selectedSet = new Set(selected);

    // Files outside the current timeline graph remain a best-effort LRU tail.
    const tail = [...this.entries.entries()]
      .filter(([assetId]) => !selectedSet.has(assetId))
      .sort((left, right) => right[1].touched - left[1].touched);
    for (const [assetId, entry] of tail) {
      if (entry.bytes.byteLength > available) continue;
      selected.push(assetId);
      selectedSet.add(assetId);
      available -= entry.bytes.byteLength;
    }

    for (const assetId of [...this.entries.keys()]) if (!selectedSet.has(assetId)) this.evict(assetId);
    this.requestedAssetIds = selected.filter((assetId) => !this.entries.has(assetId));
    this.skippedAssetIds = skipped;
    return this.state();
  }

  reconcile() { return this.setGraph(this.graph); }

  async load(assetId: string, source: MediaFileSource, stream: ReadableStream<Uint8Array>) {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error(`${source.name}: ファイルサイズが不正です`);
    if (source.size > this.maxBytes) throw new Error(`${source.name}: 128 MiBのメディアバッファに収まりません`);
    this.ensureCapacity(source.size, assetId);

    const bytes = new Uint8Array(source.size);
    const reader = stream.getReader();
    let offset = 0;
    let operations = 0;
    let largestRead = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) throw new Error(`${source.name}: ストリームがバイト列ではありません`);
        if (offset + chunk.byteLength > bytes.byteLength) throw new Error(`${source.name}: 読み出し中にファイルサイズが変わりました`);
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
        operations++;
        largestRead = Math.max(largestRead, chunk.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== bytes.byteLength) throw new Error(`${source.name}: ${offset} / ${bytes.byteLength} bytesしか受信できませんでした`);

    if (this.entries.has(assetId)) this.evict(assetId);
    const profile: SourceIoProfile = { backend: "media-buffer", bytesRead: offset, readOperations: operations, largestRead };
    this.entries.set(assetId, { source, bytes, profile, touched: ++this.clock, instances: new Map() });
    this.requestedAssetIds = this.requestedAssetIds.filter((id) => id !== assetId);
    return this.open(assetId);
  }

  open(assetId: string): BufferedMediaSource {
    const entry = this.entries.get(assetId);
    if (!entry) throw new Error(`メディアバッファに ${assetId} がありません`);
    entry.touched = ++this.clock;
    const mediaSource = new CustomSource({
      getSize: () => entry.bytes.byteLength,
      read: (start, end) => entry.bytes.subarray(start, end),
      maxCacheSize: 0,
      prefetchProfile: "none",
    });
    return { source: entry.source, mediaSource, profile: entry.profile, readAll: () => entry.bytes };
  }

  getInstance<T>(assetId: string, key: string) {
    return this.entries.get(assetId)?.instances.get(key)?.value as T | undefined;
  }

  /** Builds a decoder or Three.js resource once and binds its lifetime to the buffered file. */
  async instantiate<T>(
    assetId: string,
    key: string,
    create: (source: BufferedMediaSource) => T | Promise<T>,
    dispose: (value: T) => void,
  ) {
    const entry = this.entries.get(assetId);
    if (!entry) throw new Error(`メディアバッファに ${assetId} がありません`);
    const existing = entry.instances.get(key);
    if (existing) return existing.value as T;
    const value = await create(this.open(assetId));
    entry.instances.set(key, { value, dispose: dispose as (value: unknown) => void });
    return value;
  }

  instantiateSync<T>(assetId: string, key: string, create: (source: BufferedMediaSource) => T, dispose: (value: T) => void) {
    const entry = this.entries.get(assetId);
    if (!entry) throw new Error(`メディアバッファに ${assetId} がありません`);
    const existing = entry.instances.get(key);
    if (existing) return existing.value as T;
    const value = create(this.open(assetId));
    entry.instances.set(key, { value, dispose: dispose as (value: unknown) => void });
    return value;
  }

  releaseInstance(assetId: string, key: string) {
    const instances = this.entries.get(assetId)?.instances;
    const instance = instances?.get(key);
    if (!instance) return false;
    instances!.delete(key);
    instance.dispose(instance.value);
    return true;
  }

  release(assetId: string) {
    this.evict(assetId);
    this.requestedAssetIds = this.requestedAssetIds.filter((id) => id !== assetId);
  }

  state(): MediaBufferState {
    return {
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      instanceCount: [...this.entries.values()].reduce((total, entry) => total + entry.instances.size, 0),
      residentAssetIds: [...this.entries.keys()],
      requestedAssetIds: [...this.requestedAssetIds],
      skippedAssetIds: [...this.skippedAssetIds],
    };
  }

  private prioritizedNodes() {
    const byId = new Map(this.graph.nodes.map((node) => [node.assetId, node]));
    const outgoing = new Map<string, string[]>();
    for (const edge of this.graph.edges) {
      const targets = outgoing.get(edge.fromAssetId) ?? [];
      targets.push(edge.toAssetId);
      outgoing.set(edge.fromAssetId, targets);
    }
    const distance = new Map<string, number>();
    const queue = this.graph.roots.map((assetId) => ({ assetId, value: 0 }));
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if ((distance.get(current.assetId) ?? Infinity) <= current.value) continue;
      distance.set(current.assetId, current.value);
      for (const assetId of outgoing.get(current.assetId) ?? []) queue.push({ assetId, value: current.value + 1 });
    }
    return [...byId.values()].sort((left, right) => Number(right.active) - Number(left.active)
      || (distance.get(left.assetId) ?? Infinity) - (distance.get(right.assetId) ?? Infinity)
      || left.priority - right.priority);
  }

  private ensureCapacity(size: number, protectedAssetId: string) {
    if (this.entries.has(protectedAssetId)) this.evict(protectedAssetId);
    const priorities = new Map(this.prioritizedNodes().map((node, index) => [node.assetId, index]));
    const candidates = [...this.entries.entries()].sort((left, right) =>
      (priorities.get(right[0]) ?? Number.MAX_SAFE_INTEGER) - (priorities.get(left[0]) ?? Number.MAX_SAFE_INTEGER)
      || left[1].touched - right[1].touched);
    while (this.usedBytes + size > this.maxBytes && candidates.length) this.evict(candidates.shift()![0]);
    if (this.usedBytes + size > this.maxBytes) throw new Error("メディアバッファの空き容量を確保できませんでした");
  }

  private evict(assetId: string) {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    this.onEvict?.(assetId);
    for (const instance of [...entry.instances.values()].reverse()) instance.dispose(instance.value);
    entry.instances.clear();
    this.entries.delete(assetId);
  }
}
