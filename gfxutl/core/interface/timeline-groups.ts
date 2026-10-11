import type { TimelineClip } from "./types";

export const TITLE_CLIP_HEIGHT = 24;
export const MEDIA_CLIP_HEIGHT = 32;
export const MIN_GROUP_HEIGHT = 52;
const TIME_PIXEL_SCALE = 26;
const EPSILON = 1e-6;

export interface TimelineRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function timelineClipHeight(clip: TimelineClip) {
  if (clip.kind === "group") return Math.max(MIN_GROUP_HEIGHT, clip.groupHeight ?? 156);
  return clip.kind === "title" ? TITLE_CLIP_HEIGHT : MEDIA_CLIP_HEIGHT;
}

export function timelineRect(clip: TimelineClip): TimelineRect {
  return {
    left: clip.start,
    right: clip.start + clip.duration,
    top: clip.y,
    bottom: clip.y + timelineClipHeight(clip),
  };
}

export function rectContains(outer: TimelineRect, inner: TimelineRect) {
  return inner.left >= outer.left - EPSILON
    && inner.right <= outer.right + EPSILON
    && inner.top >= outer.top - EPSILON
    && inner.bottom <= outer.bottom + EPSILON;
}

export function rectsOverlap(a: TimelineRect, b: TimelineRect) {
  return a.left < b.right - EPSILON
    && a.right > b.left + EPSILON
    && a.top < b.bottom - EPSILON
    && a.bottom > b.top + EPSILON;
}

/** A group edge may never pass through another timeline object. */
export function hasGroupBoundaryCrossing(clips: readonly TimelineClip[]) {
  const groups = clips.filter((clip) => clip.kind === "group");
  return groups.some((group) => {
    const groupRect = timelineRect(group);
    return clips.some((clip) => {
      if (clip.id === group.id) return false;
      const clipRect = timelineRect(clip);
      if (!rectsOverlap(groupRect, clipRect)) return false;
      if (rectContains(groupRect, clipRect)) return false;
      return !(clip.kind === "group" && rectContains(clipRect, groupRect));
    });
  });
}

/** Recomputes direct nesting from geometry, choosing the smallest containing group. */
export function assignTimelineGroups(clips: readonly TimelineClip[]): TimelineClip[] {
  const groups = clips.filter((clip) => clip.kind === "group");
  return clips.map((clip) => {
    const rect = timelineRect(clip);
    const area = rectArea(rect);
    const parent = groups
      .filter((group) => {
        if (group.id === clip.id) return false;
        const groupRect = timelineRect(group);
        return rectContains(groupRect, rect)
          && (clip.kind !== "group" || rectArea(groupRect) > area + EPSILON);
      })
      .sort((a, b) => rectArea(timelineRect(a)) - rectArea(timelineRect(b)))[0];
    const groupId = parent?.id;
    return clip.groupId === groupId ? clip : { ...clip, groupId };
  });
}

export function timelineGroupDescendants(clips: readonly TimelineClip[], rootIds: Iterable<string>) {
  const result = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const clip of clips) {
      if (clip.groupId && result.has(clip.groupId) && !result.has(clip.id)) {
        result.add(clip.id);
        changed = true;
      }
    }
  }
  return result;
}

/** Places a newly created clip wholly inside a group or wholly outside it. */
export function placeTimelineClip(clips: readonly TimelineClip[], source: TimelineClip) {
  let clip = source;
  const groups = clips.filter((item) => item.kind === "group")
    .sort((a, b) => rectArea(timelineRect(a)) - rectArea(timelineRect(b)));
  for (let pass = 0; pass < groups.length + 1; pass += 1) {
    let adjusted = false;
    for (const group of groups) {
      const groupRect = timelineRect(group);
      const clipRect = timelineRect(clip);
      if (!rectsOverlap(groupRect, clipRect) || rectContains(groupRect, clipRect)) continue;
      const width = clip.duration;
      const height = timelineClipHeight(clip);
      const centerX = (clipRect.left + clipRect.right) / 2;
      const centerY = (clipRect.top + clipRect.bottom) / 2;
      if (centerX >= groupRect.left && centerX <= groupRect.right
        && centerY >= groupRect.top && centerY <= groupRect.bottom
        && width <= group.duration + EPSILON && height <= timelineClipHeight(group) + EPSILON) {
        clip = {
          ...clip,
          start: clamp(clip.start, groupRect.left, groupRect.right - width),
          y: clamp(clip.y, groupRect.top, groupRect.bottom - height),
        };
      } else {
        const candidates = [
          { ...clip, start: Math.max(0, groupRect.left - width) },
          { ...clip, start: groupRect.right },
          { ...clip, y: Math.max(0, groupRect.top - height) },
          { ...clip, y: groupRect.bottom },
        ];
        clip = candidates.sort((a, b) => placementDistance(a, clip) - placementDistance(b, clip))[0];
      }
      adjusted = true;
    }
    if (!adjusted) break;
  }
  if (hasGroupBoundaryCrossing([...clips, clip])) {
    const groupBottom = Math.max(0, ...groups.map((group) => timelineRect(group).bottom));
    clip = { ...clip, y: groupBottom + 24 };
  }
  return assignTimelineGroups([...clips, clip]).at(-1)!;
}

/** A new group grows around every object its initial rectangle intersects. */
export function expandGroupToValidBoundary(clips: readonly TimelineClip[], source: TimelineClip) {
  let rect = timelineRect(source);
  for (let pass = 0; pass < clips.length + 1; pass += 1) {
    let changed = false;
    for (const clip of clips) {
      const other = timelineRect(clip);
      if (!rectsOverlap(rect, other) || rectContains(rect, other)
        || (clip.kind === "group" && rectContains(other, rect))) continue;
      rect = {
        left: Math.min(rect.left, other.left),
        right: Math.max(rect.right, other.right),
        top: Math.min(rect.top, other.top),
        bottom: Math.max(rect.bottom, other.bottom),
      };
      changed = true;
    }
    if (!changed) break;
  }
  return {
    ...source,
    start: Math.max(0, rect.left),
    y: Math.max(0, rect.top),
    duration: Math.max(source.duration, rect.right - Math.max(0, rect.left)),
    groupHeight: Math.max(MIN_GROUP_HEIGHT, rect.bottom - Math.max(0, rect.top)),
  };
}

function rectArea(rect: TimelineRect) {
  return Math.max(EPSILON, rect.right - rect.left) * Math.max(EPSILON, rect.bottom - rect.top);
}

function placementDistance(a: TimelineClip, b: TimelineClip) {
  return ((a.start - b.start) * TIME_PIXEL_SCALE) ** 2 + (a.y - b.y) ** 2;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
