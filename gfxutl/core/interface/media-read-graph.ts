import type { MediaReadGraph, MediaReadGraphEdge, MediaReadGraphNode } from "../protocol/engine-protocol";
import type { MediaAsset, TimelineClip } from "./types";

const enum NodeColor { Black, Red }

interface TimelinePiece {
  key: string;
  clipId: string;
  assetId: string;
  start: number;
  end: number;
}

interface ReadHistory {
  reads: number;
  lastReadEpoch: number;
  lastReadBucket: number;
}

class PieceNode {
  parent: PieceNode;
  left: PieceNode;
  right: PieceNode;
  subtreeMaxEnd: number;
  subtreeCount: number;

  constructor(readonly piece: TimelinePiece | null, public color: NodeColor) {
    this.parent = this;
    this.left = this;
    this.right = this;
    this.subtreeMaxEnd = piece?.end ?? -Infinity;
    this.subtreeCount = piece ? 1 : 0;
  }
}

/**
 * Piece Tree-style red-black index. Like VS Code's piece tree, it uses a black
 * sentinel and repairs aggregate subtree metadata during rotations. Here the
 * aggregate is max(end), which makes point/interval lookup logarithmic.
 */
class TimelinePieceTree {
  private readonly sentinel = new PieceNode(null, NodeColor.Black);
  private root = this.sentinel;

  constructor() {
    this.sentinel.parent = this.sentinel;
    this.sentinel.left = this.sentinel;
    this.sentinel.right = this.sentinel;
  }

  insert(piece: TimelinePiece) {
    const node = new PieceNode(piece, NodeColor.Red);
    node.left = this.sentinel;
    node.right = this.sentinel;
    let parent = this.sentinel;
    let cursor = this.root;
    while (cursor !== this.sentinel) {
      parent = cursor;
      cursor = comparePieces(piece, cursor.piece!) < 0 ? cursor.left : cursor.right;
    }
    node.parent = parent;
    if (parent === this.sentinel) this.root = node;
    else if (comparePieces(piece, parent.piece!) < 0) parent.left = node;
    else parent.right = node;
    this.recomputeToRoot(parent);
    this.repairInsert(node);
    this.recomputeToRoot(node);
  }

  activeAt(time: number) {
    const result: PieceNode[] = [];
    const visit = (node: PieceNode) => {
      if (node === this.sentinel || node.subtreeMaxEnd <= time) return;
      if (node.left.subtreeMaxEnd > time) visit(node.left);
      const piece = node.piece!;
      if (piece.start <= time && piece.end > time) result.push(node);
      if (piece.start <= time) visit(node.right);
    };
    visit(this.root);
    return result;
  }

  inOrder() {
    const result: PieceNode[] = [];
    const stack: PieceNode[] = [];
    let node = this.root;
    while (stack.length || node !== this.sentinel) {
      while (node !== this.sentinel) { stack.push(node); node = node.left; }
      node = stack.pop()!;
      result.push(node);
      node = node.right;
    }
    return result;
  }

  validate() {
    if (this.root !== this.sentinel && this.root.color !== NodeColor.Black) throw new Error("Piece Tree root must be black");
    const walk = (node: PieceNode, lower?: TimelinePiece, upper?: TimelinePiece): { blackHeight: number; maxEnd: number; count: number } => {
      if (node === this.sentinel) return { blackHeight: 1, maxEnd: -Infinity, count: 0 };
      const piece = node.piece!;
      if (lower && comparePieces(piece, lower) <= 0) throw new Error("Piece Tree ordering is invalid");
      if (upper && comparePieces(piece, upper) >= 0) throw new Error("Piece Tree ordering is invalid");
      if (node.left !== this.sentinel && node.left.parent !== node) throw new Error("Piece Tree left parent is invalid");
      if (node.right !== this.sentinel && node.right.parent !== node) throw new Error("Piece Tree right parent is invalid");
      if (node.color === NodeColor.Red && (node.left.color === NodeColor.Red || node.right.color === NodeColor.Red)) throw new Error("Adjacent red Piece Tree nodes");
      const left = walk(node.left, lower, piece);
      const right = walk(node.right, piece, upper);
      if (left.blackHeight !== right.blackHeight) throw new Error("Piece Tree black height is invalid");
      const maxEnd = Math.max(piece.end, left.maxEnd, right.maxEnd);
      const count = 1 + left.count + right.count;
      if (node.subtreeMaxEnd !== maxEnd || node.subtreeCount !== count) throw new Error("Piece Tree aggregate is invalid");
      return { blackHeight: left.blackHeight + Number(node.color === NodeColor.Black), maxEnd, count };
    };
    walk(this.root);
    return true;
  }

  private repairInsert(node: PieceNode) {
    while (node !== this.root && node.parent.color === NodeColor.Red) {
      const parent = node.parent;
      const grandparent = parent.parent;
      if (parent === grandparent.left) {
        const uncle = grandparent.right;
        if (uncle.color === NodeColor.Red) {
          parent.color = NodeColor.Black;
          uncle.color = NodeColor.Black;
          grandparent.color = NodeColor.Red;
          node = grandparent;
        } else {
          if (node === parent.right) { node = parent; this.rotateLeft(node); }
          node.parent.color = NodeColor.Black;
          node.parent.parent.color = NodeColor.Red;
          this.rotateRight(node.parent.parent);
        }
      } else {
        const uncle = grandparent.left;
        if (uncle.color === NodeColor.Red) {
          parent.color = NodeColor.Black;
          uncle.color = NodeColor.Black;
          grandparent.color = NodeColor.Red;
          node = grandparent;
        } else {
          if (node === parent.left) { node = parent; this.rotateRight(node); }
          node.parent.color = NodeColor.Black;
          node.parent.parent.color = NodeColor.Red;
          this.rotateLeft(node.parent.parent);
        }
      }
    }
    this.root.color = NodeColor.Black;
    this.root.parent = this.sentinel;
  }

  private rotateLeft(node: PieceNode) {
    const pivot = node.right;
    node.right = pivot.left;
    if (pivot.left !== this.sentinel) pivot.left.parent = node;
    pivot.parent = node.parent;
    if (node.parent === this.sentinel) this.root = pivot;
    else if (node === node.parent.left) node.parent.left = pivot;
    else node.parent.right = pivot;
    pivot.left = node;
    node.parent = pivot;
    this.recompute(node);
    this.recompute(pivot);
  }

  private rotateRight(node: PieceNode) {
    const pivot = node.left;
    node.left = pivot.right;
    if (pivot.right !== this.sentinel) pivot.right.parent = node;
    pivot.parent = node.parent;
    if (node.parent === this.sentinel) this.root = pivot;
    else if (node === node.parent.right) node.parent.right = pivot;
    else node.parent.left = pivot;
    pivot.right = node;
    node.parent = pivot;
    this.recompute(node);
    this.recompute(pivot);
  }

  private recompute(node: PieceNode) {
    if (node === this.sentinel) return;
    node.subtreeMaxEnd = Math.max(node.piece!.end, node.left.subtreeMaxEnd, node.right.subtreeMaxEnd);
    node.subtreeCount = 1 + node.left.subtreeCount + node.right.subtreeCount;
  }

  private recomputeToRoot(node: PieceNode) {
    while (node !== this.sentinel) { this.recompute(node); node = node.parent; }
  }
}

interface AssetCandidate {
  assetId: string;
  score: number;
  active: boolean;
  occurrences: number;
  timelineTime: number;
}

export class MediaReadPlanner {
  private tree = new TimelinePieceTree();
  private clipSource: readonly TimelineClip[] | null = null;
  private assetSource: readonly MediaAsset[] | null = null;
  private sizes = new Map<string, number>();
  private history = new Map<string, ReadHistory>();
  private epoch = 0;

  build(clips: readonly TimelineClip[], assets: readonly MediaAsset[], playhead: number): Omit<MediaReadGraph, "revision"> {
    if (clips !== this.clipSource || assets !== this.assetSource) this.rebuild(clips, assets);
    const activeNodes = this.tree.activeAt(playhead);
    const activeKeys = new Set(activeNodes.map((node) => node.piece!.key));
    const activeAssets = new Set(activeNodes.map((node) => node.piece!.assetId));
    const epoch = ++this.epoch;
    const bucket = Math.floor(Math.max(0, playhead) * 2);
    for (const node of activeNodes) {
      const key = node.piece!.key;
      const history = this.history.get(key) ?? { reads: 0, lastReadEpoch: epoch, lastReadBucket: -1 };
      if (history.lastReadBucket !== bucket) history.reads++;
      history.lastReadBucket = bucket;
      history.lastReadEpoch = epoch;
      this.history.set(key, history);
    }

    const candidates = new Map<string, AssetCandidate>();
    for (const node of this.tree.inOrder()) {
      const piece = node.piece!;
      const history = this.history.get(piece.key);
      const active = activeKeys.has(piece.key);
      const score = readScore(piece, history, active, playhead, epoch);
      const current = candidates.get(piece.assetId);
      if (current) {
        current.occurrences++;
        current.active ||= active;
        if (score < current.score) { current.score = score; current.timelineTime = piece.start; }
      } else {
        candidates.set(piece.assetId, { assetId: piece.assetId, score, active, occurrences: 1, timelineTime: piece.start });
      }
    }

    const ordered = [...candidates.values()].sort((left, right) => Number(right.active) - Number(left.active)
      || left.score - right.score
      || left.timelineTime - right.timelineTime
      || left.assetId.localeCompare(right.assetId));
    const nodes: MediaReadGraphNode[] = ordered.map((candidate, priority) => ({
      assetId: candidate.assetId,
      size: this.sizes.get(candidate.assetId) ?? 0,
      active: candidate.active,
      priority,
      occurrences: candidate.occurrences,
    }));
    const roots = ordered.filter((candidate) => activeAssets.has(candidate.assetId)).map((candidate) => candidate.assetId);
    if (!roots.length && nodes[0]) roots.push(nodes[0].assetId);
    const edges: MediaReadGraphEdge[] = ordered.slice(1).map((candidate, index) => ({
      fromAssetId: ordered[index].assetId,
      toAssetId: candidate.assetId,
      timelineTime: candidate.timelineTime,
    }));
    return { roots, nodes, edges };
  }

  validateIndex() { return this.tree.validate(); }

  private rebuild(clips: readonly TimelineClip[], assets: readonly MediaAsset[]) {
    this.clipSource = clips;
    this.assetSource = assets;
    this.sizes = new Map(assets.map((asset) => [asset.id, asset.size]));
    this.tree = new TimelinePieceTree();
    const liveKeys = new Set<string>();
    for (const clip of clips) {
      if (!clip.assetId || !this.sizes.has(clip.assetId)) continue;
      const key = `${clip.id}:${clip.assetId}:${clip.start}:${clip.duration}`;
      liveKeys.add(key);
      this.tree.insert({ key, clipId: clip.id, assetId: clip.assetId, start: clip.start, end: clip.start + clip.duration });
    }
    for (const key of this.history.keys()) if (!liveKeys.has(key)) this.history.delete(key);
  }
}

function readScore(piece: TimelinePiece, history: ReadHistory | undefined, active: boolean, playhead: number, epoch: number) {
  if (active) return 0;
  if (history?.reads) {
    const rewindDistance = Math.max(0, playhead - piece.end);
    const historyAge = Math.max(0, epoch - history.lastReadEpoch);
    return 1
      + Math.log2(1 + rewindDistance) * 0.3
      + Math.log2(1 + historyAge) * 0.12
      - Math.min(0.5, Math.log2(1 + history.reads) * 0.1);
  }
  if (piece.start >= playhead) {
    const forwardDistance = piece.start - playhead;
    return 1.75 + forwardDistance * 0.05 + forwardDistance * forwardDistance / 16;
  }
  return 1_000 + Math.max(0, playhead - piece.end);
}

function comparePieces(left: TimelinePiece, right: TimelinePiece) {
  return left.start - right.start || left.end - right.end || left.key.localeCompare(right.key);
}

/** Stateless compatibility helper; use MediaReadPlanner when read history matters. */
export function buildMediaReadGraph(clips: readonly TimelineClip[], assets: readonly MediaAsset[], playhead: number) {
  return new MediaReadPlanner().build(clips, assets, playhead);
}
