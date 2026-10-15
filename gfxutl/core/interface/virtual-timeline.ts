import type { RenderClip, TimelinePatch, TimelineSnapshot } from "../protocol/engine-protocol";

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
  private source: readonly RenderClip[] | null = null;

  snapshot(clips: RenderClip[]): TimelineSnapshot {
    this.source = clips;
    this.nodes = new Map(clips.map((clip) => [clip.id, { clip, signature: JSON.stringify(clip) }]));
    return { revision: ++this.revision, clips };
  }

  reconcile(clips: RenderClip[]): TimelinePatch | null {
    // Playback reuses immutable render nodes. Do not stringify the complete
    // timeline on every animation frame just to rediscover it is unchanged.
    if (clips === this.source) return null;
    this.source = clips;
    const nextIds = new Set(clips.map((clip) => clip.id));
    const upserts: RenderClip[] = [];
    const removes: string[] = [];

    for (const [id, node] of this.nodes) {
      if (nextIds.has(id)) continue;
      removes.push(id);
      this.nodes.delete(id);
    }
    for (const clip of clips) {
      const signature = JSON.stringify(clip);
      const previous = this.nodes.get(clip.id);
      if (previous?.signature === signature) continue;
      upserts.push(clip);
      this.nodes.set(clip.id, { clip, signature });
    }
    if (!upserts.length && !removes.length) return null;
    return { revision: ++this.revision, upserts, removes };
  }
}
