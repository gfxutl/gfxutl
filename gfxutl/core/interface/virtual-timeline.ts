import type { RenderClip, TimelinePatch } from "../protocol/engine-protocol";

interface TimelineNode {
  clip: RenderClip;
  signature: string;
}

/**
 * Main-thread retained timeline. It mirrors a virtual DOM: immutable render
 * nodes are compared by value and only replaced nodes cross the worker port.
 */
export class VirtualTimeline {
  private nodes = new Map<string, TimelineNode>();
  private revision = 0;

  reconcile(clips: RenderClip[]): TimelinePatch | null {
    const nextIds = new Set(clips.map((clip) => clip.id));
    const upserts: RenderClip[] = [];
    const removes: string[] = [];
    const invalidatedRanges: Array<{ start: number; end: number }> = [];

    for (const [id, node] of this.nodes) {
      if (nextIds.has(id)) continue;
      removes.push(id);
      invalidatedRanges.push({ start: node.clip.start, end: node.clip.start + node.clip.duration });
      this.nodes.delete(id);
    }
    for (const clip of clips) {
      const signature = JSON.stringify(clip);
      const previous = this.nodes.get(clip.id);
      if (previous?.signature === signature) continue;
      upserts.push(clip);
      if (previous) invalidatedRanges.push({ start: previous.clip.start, end: previous.clip.start + previous.clip.duration });
      invalidatedRanges.push({ start: clip.start, end: clip.start + clip.duration });
      this.nodes.set(clip.id, { clip, signature });
    }
    if (!upserts.length && !removes.length) return null;
    return { revision: ++this.revision, upserts, removes, invalidatedRanges: mergeRanges(invalidatedRanges) };
  }
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges
    .map((range) => ({ start: Math.max(0, range.start), end: Math.max(range.start, range.end) }))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const tail = merged.at(-1);
    if (tail && range.start <= tail.end) tail.end = Math.max(tail.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
