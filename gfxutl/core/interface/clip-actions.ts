import type { ClipPropertyAction, ClipPropertyActionKind, TimelineClip } from "./types";
import type { ColorGradingSpec } from "../protocol/engine-protocol";

export const CLIP_ACTION_LABELS: Record<ClipPropertyActionKind, string> = {
  transform: "変形",
  sceneGraph: "シーングラフ",
  keyframes: "キーフレーム",
  crop: "クロップ",
  colorGrading: "カラーグレーディング",
  effects: "効果",
  masks: "マスク",
  audio: "オーディオ",
  speed: "速度",
};

const DEFAULT_ORDER: ClipPropertyActionKind[] = ["transform", "sceneGraph", "keyframes", "crop", "colorGrading", "effects", "masks", "audio", "speed"];

export const DEFAULT_COLOR_GRADING: Readonly<ColorGradingSpec> = {
  enabled: true,
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 0,
  vibrance: 0,
  hue: 0,
  fade: 0,
  liftRed: 0,
  liftGreen: 0,
  liftBlue: 0,
  gammaRed: 0,
  gammaGreen: 0,
  gammaBlue: 0,
  gainRed: 0,
  gainGreen: 0,
  gainBlue: 0,
};

export function resolveColorGrading(value?: Partial<ColorGradingSpec>): ColorGradingSpec {
  return { ...DEFAULT_COLOR_GRADING, ...value };
}

export function applicableClipActionKinds(clip: TimelineClip): ClipPropertyActionKind[] {
  if (clip.kind === "group") return [];
  if (clip.kind === "filter") return ["transform", "effects", "keyframes"];
  return DEFAULT_ORDER.filter((kind) => {
    if (kind === "transform") return true;
    if (kind === "sceneGraph") return clip.kind === "title" || clip.kind === "object";
    if (kind === "keyframes") return clip.kind !== "audio";
    if (kind === "colorGrading") return clip.kind === "video";
    if (kind === "crop" || kind === "audio" || kind === "speed") return clip.kind !== "title" && clip.kind !== "object";
    if (kind === "effects") return clip.kind !== "audio" && !clip.particleSystem;
    return kind === "masks" && (clip.kind === "video" || clip.kind === "title" || (clip.kind === "object" && Boolean(clip.geometry)));
  });
}

export function resolveClipPropertyActions(clip: TimelineClip): ClipPropertyAction[] {
  const applicable = new Set(applicableClipActionKinds(clip));
  if (clip.propertyActions === undefined) {
    return [...applicable].map((kind) => ({ id: `builtin:${kind}`, kind }));
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
    case "colorGrading": return { colorGrading: undefined };
    case "effects": return { effects: [] };
    case "masks": return { masks: [] };
    case "audio": return { volume: 0, pan: 0, audioProcessing: undefined };
    case "speed": return { speed: 100, ripple: true };
  }
}
