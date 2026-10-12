import type { ClipPropertyAction, ClipPropertyActionKind, TimelineClip } from "./types";

export const DEFAULT_POST_PROCESS_GLSL = `vec4 gfxPostProcess(vec4 color, vec2 uv, float time) {
  return color;
}`;

export const CLIP_ACTION_LABELS: Record<ClipPropertyActionKind, string> = {
  transform: "変形",
  sceneGraph: "シーングラフ",
  keyframes: "キーフレーム",
  crop: "クロップ",
  effects: "効果",
  postProcess: "ポストプロセス",
  masks: "マスク",
  audio: "オーディオ",
  speed: "速度",
};

const DEFAULT_ORDER: ClipPropertyActionKind[] = ["transform", "sceneGraph", "keyframes", "crop", "effects", "postProcess", "masks", "audio", "speed"];

export function applicableClipActionKinds(clip: TimelineClip): ClipPropertyActionKind[] {
  if (clip.kind === "group") return [];
  return DEFAULT_ORDER.filter((kind) => {
    if (kind === "transform") return true;
    if (kind === "sceneGraph") return clip.kind === "title" || clip.kind === "object";
    if (kind === "keyframes") return clip.kind !== "audio";
    if (kind === "crop" || kind === "audio" || kind === "speed") return clip.kind !== "title" && clip.kind !== "object";
    if (kind === "effects") return clip.kind !== "audio" && !clip.particleSystem;
    if (kind === "postProcess") return clip.kind === "video";
    return kind === "masks" && clip.kind === "video";
  });
}

export function resolveClipPropertyActions(clip: TimelineClip): ClipPropertyAction[] {
  const applicable = new Set(applicableClipActionKinds(clip));
  if (clip.propertyActions === undefined) {
    return [...applicable]
      .filter((kind) => kind !== "postProcess" || Boolean(clip.postProcess))
      .map((kind) => ({ id: `builtin:${kind}`, kind }));
  }
  const seen = new Set<ClipPropertyActionKind>();
  return clip.propertyActions.filter((action) => {
    if (!applicable.has(action.kind) || seen.has(action.kind)) return false;
    seen.add(action.kind);
    return true;
  });
}

export function resetPatchForClipAction(kind: ClipPropertyActionKind): Partial<TimelineClip> {
  switch (kind) {
    case "transform": return { positionX: 0, positionY: 0, positionZ: 0, scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100 };
    case "sceneGraph": return { parentId: undefined, visible: true, layer: 0 };
    case "keyframes": return { keyframes: [] };
    case "crop": return { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
    case "effects": return { effects: [] };
    case "postProcess": return { postProcess: undefined };
    case "masks": return { masks: [] };
    case "audio": return { volume: 0, pan: 0, audioProcessing: undefined };
    case "speed": return { speed: 100, ripple: true };
  }
}
