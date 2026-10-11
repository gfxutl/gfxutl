const DEFAULT_LIMIT = 128 * 1024 * 1024;

interface SizedValue {
  data: Uint8Array;
}

interface CacheEntry<T extends SizedValue> {
  value: T;
  touchedAt: number;
}

/** H.264 access-unit cache with a strict byte ceiling and LRU eviction. */
export class RamPreviewCache<T extends SizedValue = SizedValue> {
  private entries = new Map<string, CacheEntry<T>>();
  private bytes = 0;
  private limit: number;

  constructor(maxBytes = DEFAULT_LIMIT) { this.limit = Math.max(0, Math.floor(maxBytes)); }

  get usedBytes() { return this.bytes; }
  get size() { return this.entries.size; }
  get maxBytes() { return this.limit; }

  setMaxBytes(maxBytes: number) {
    this.limit = Math.max(0, Math.floor(maxBytes));
    this.evictToLimit();
  }

  get(key: string) {
    const hit = this.entries.get(key);
    if (!hit) return null;
    hit.touchedAt = performance.now();
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T) {
    if (value.data.byteLength > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.value.data.byteLength;
    this.entries.delete(key);
    while (this.bytes + value.data.byteLength > this.maxBytes && this.entries.size) {
      const oldestKey = this.entries.keys().next().value as string;
      const oldest = this.entries.get(oldestKey)!;
      this.bytes -= oldest.value.data.byteLength;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, { value, touchedAt: performance.now() });
    this.bytes += value.data.byteLength;
  }

  deleteWhere(predicate: (key: string, value: T) => boolean) {
    for (const [key, entry] of this.entries) {
      if (!predicate(key, entry.value)) continue;
      this.bytes -= entry.value.data.byteLength;
      this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  private evictToLimit() {
    while (this.bytes > this.limit && this.entries.size) {
      const oldestKey = this.entries.keys().next().value as string;
      const oldest = this.entries.get(oldestKey)!;
      this.bytes -= oldest.value.data.byteLength;
      this.entries.delete(oldestKey);
    }
  }
}
