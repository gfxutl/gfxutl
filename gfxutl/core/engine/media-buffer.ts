import { BlobSource } from "mediabunny";
import type { MediaFileSource, MediaReadGraph, SourceIoProfile } from "../protocol/engine-protocol";

export const MEDIA_BUFFER_MAX_BYTES = 128 * 1024 * 1024;

interface MediaBufferEntry {
  source: MediaFileSource;
  file: File;
  profile: SourceIoProfile;
  touched: number;
  generation: number;
  retainCount: number;
  evictionPending: boolean;
  evictionNotified: boolean;
  deletePending: boolean;
  instances: Map<string, MediaBufferInstance>;
  pendingInstances: Map<string, Promise<unknown>>;
}

interface MediaBufferInstance {
  value: unknown;
  dispose: (value: unknown) => void;
}

export interface BufferedMediaSource {
  source: MediaFileSource;
  blob: Blob;
  mediaSource: BlobSource;
  profile: SourceIoProfile;
  readAll(): Promise<Uint8Array<ArrayBuffer>>;
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

  constructor(public maxBytes = MEDIA_BUFFER_MAX_BYTES, private readonly onEvict?: (assetId: string) => void) {}

  setMaxBytes(maxBytes: number) {
    this.maxBytes = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxBytes)));
    return this.reconcile();
  }

  get usedBytes() {
    let total = 0;
    for (const assetId of this.residentAssetIds) total += this.entries.get(assetId)?.source.size ?? 0;
    return total;
  }

  private residentAssetIds = new Set<string>();

  has(assetId: string) { return this.entries.has(assetId); }

  setGraph(graph: MediaReadGraph) {
    this.graph = graph;
    const selected: string[] = [];
    const skipped: string[] = [];
    let available = this.maxBytes;
    for (const node of this.prioritizedNodes()) {
      if (node.size <= 0 || (!node.active && (node.size > this.maxBytes || node.size > available))) {
        skipped.push(node.assetId);
        continue;
      }
      selected.push(node.assetId);
      available = Math.max(0, available - node.size);
    }
    const selectedSet = new Set(selected);
    for (const assetId of selectedSet) {
      const entry = this.entries.get(assetId);
      if (entry && !entry.deletePending && !entry.evictionNotified) entry.evictionPending = false;
    }

    // Files outside the current timeline graph remain a best-effort LRU tail.
    const tail = [...this.residentAssetIds]
      .map((assetId) => [assetId, this.entries.get(assetId)] as const)
      .filter((entry): entry is readonly [string, MediaBufferEntry] => Boolean(entry[1]) && !selectedSet.has(entry[0]))
      .sort((left, right) => right[1].touched - left[1].touched);
    for (const [assetId, entry] of tail) {
      if (entry.source.size > available) continue;
      selected.push(assetId);
      selectedSet.add(assetId);
      available -= entry.source.size;
    }

    for (const assetId of [...this.residentAssetIds]) if (!selectedSet.has(assetId)) this.evictInstances(assetId);
    this.requestedAssetIds = selected.filter((assetId) => !this.residentAssetIds.has(assetId));
    this.skippedAssetIds = skipped;
    return this.state();
  }

  reconcile() { return this.setGraph(this.graph); }

  async load(assetId: string, source: MediaFileSource, file: File) {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error(`${source.name}: ファイルサイズが不正です`);
    this.ensureCapacity(source.size, assetId);
    const existing = this.entries.get(assetId);
    const unchanged = existing?.source.size === source.size && existing.source.lastModified === source.lastModified;
    if (!unchanged && existing) {
      this.evict(assetId);
      if (existing.retainCount) this.notifyEviction(assetId, existing);
    }
    const profile: SourceIoProfile = { backend: "blob-source", bytesRead: 0, readOperations: 0, largestRead: 0 };
    if (!unchanged) this.entries.set(assetId, { source, file, profile, touched: ++this.clock, generation: 0, retainCount: 0, evictionPending: false, evictionNotified: false, deletePending: false, instances: new Map(), pendingInstances: new Map() });
    else {
      existing.source = source;
      existing.file = file;
      existing.touched = ++this.clock;
      if (!existing.evictionNotified) {
        existing.evictionPending = false;
        existing.deletePending = false;
      }
    }
    this.residentAssetIds.add(assetId);
    this.requestedAssetIds = this.requestedAssetIds.filter((id) => id !== assetId);
    return this.open(assetId);
  }

  open(assetId: string): BufferedMediaSource {
    const entry = this.entries.get(assetId);
    if (!entry) throw new Error(`メディアバッファに ${assetId} がありません`);
    entry.touched = ++this.clock;
    const mediaSource = new BlobSource(entry.file);
    return {
      source: entry.source,
      blob: entry.file,
      mediaSource,
      profile: entry.profile,
      readAll: async () => new Uint8Array(await entry.file.arrayBuffer()),
    };
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
    const pending = entry.pendingInstances.get(key);
    if (pending) return pending as Promise<T>;
    const generation = entry.generation;
    const request = (async () => {
      const value = await create(this.open(assetId));
      if (this.entries.get(assetId) !== entry || entry.generation !== generation || entry.deletePending) {
        dispose(value);
        throw new DOMException("Media buffer instance was invalidated", "AbortError");
      }
      entry.instances.set(key, { value, dispose: dispose as (value: unknown) => void });
      return value;
    })();
    entry.pendingInstances.set(key, request);
    try {
      return await request;
    } finally {
      if (entry.pendingInstances.get(key) === request) entry.pendingInstances.delete(key);
    }
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

  /** Prevents decoder/input disposal while an asynchronous media operation is using it. */
  retain(assetId: string) {
    const entry = this.entries.get(assetId);
    if (!entry || entry.deletePending) throw new Error(`メディアバッファに ${assetId} がありません`);
    entry.retainCount++;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      entry.retainCount = Math.max(0, entry.retainCount - 1);
      if (entry.retainCount) return false;
      if (this.entries.get(assetId) !== entry) {
        this.disposeInstances(entry);
        return false;
      }
      if (entry.deletePending) {
        this.performEvictInstances(assetId, entry);
        this.entries.delete(assetId);
        return true;
      }
      if (entry.evictionPending) {
        this.performEvictInstances(assetId, entry);
        return true;
      }
      return false;
    };
  }

  state(): MediaBufferState {
    return {
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
      instanceCount: [...this.entries.values()].reduce((total, entry) => total + entry.instances.size, 0),
      residentAssetIds: [...this.residentAssetIds],
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
    if (this.residentAssetIds.has(protectedAssetId)) return;
    const priorities = new Map(this.prioritizedNodes().map((node, index) => [node.assetId, index]));
    const candidates = [...this.residentAssetIds]
      .map((assetId) => [assetId, this.entries.get(assetId)] as const)
      .filter((entry): entry is readonly [string, MediaBufferEntry] => Boolean(entry[1]))
      .sort((left, right) => (priorities.get(right[0]) ?? Number.MAX_SAFE_INTEGER) - (priorities.get(left[0]) ?? Number.MAX_SAFE_INTEGER)
        || left[1].touched - right[1].touched);
    while (this.usedBytes + size > this.maxBytes && candidates.length) this.evictInstances(candidates.shift()![0]);
  }

  private evictInstances(assetId: string) {
    const entry = this.entries.get(assetId);
    if (!entry || !this.residentAssetIds.has(assetId)) return;
    if (entry.retainCount) {
      entry.evictionPending = true;
      return;
    }
    this.performEvictInstances(assetId, entry);
  }

  private performEvictInstances(assetId: string, entry: MediaBufferEntry) {
    if (!this.residentAssetIds.delete(assetId) && !entry.instances.size) return;
    this.notifyEviction(assetId, entry);
    entry.evictionPending = false;
    this.disposeInstances(entry);
    entry.evictionNotified = false;
  }

  private notifyEviction(assetId: string, entry: MediaBufferEntry) {
    if (entry.evictionNotified) return;
    entry.generation++;
    entry.evictionNotified = true;
    entry.pendingInstances.clear();
    this.onEvict?.(assetId);
  }

  private disposeInstances(entry: MediaBufferEntry) {
    for (const instance of [...entry.instances.values()].reverse()) instance.dispose(instance.value);
    entry.instances.clear();
  }

  private evict(assetId: string) {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    if (entry.retainCount) {
      entry.evictionPending = true;
      entry.deletePending = true;
      return;
    }
    this.performEvictInstances(assetId, entry);
    this.entries.delete(assetId);
  }
}
