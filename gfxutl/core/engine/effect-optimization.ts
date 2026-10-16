import type { ClipEffect, ColorGradingSpec } from "../protocol/engine-protocol";

export function isNeutralColorGrading(grading: ColorGradingSpec) {
  return !grading.enabled || [
    grading.exposure, grading.temperature, grading.tint, grading.contrast,
    grading.highlights, grading.shadows, grading.whites, grading.blacks,
    grading.saturation, grading.vibrance, grading.hue, grading.fade,
    grading.liftRed, grading.liftGreen, grading.liftBlue,
    grading.gammaRed, grading.gammaGreen, grading.gammaBlue,
    grading.gainRed, grading.gainGreen, grading.gainBlue,
  ].every((value) => Math.abs(value) < 0.000001);
}

export function isNeutralClipEffect(effect: ClipEffect) {
  switch (effect.kind) {
    case "transform":
      return Math.abs(effect.params.x ?? 0) < 0.000001
        && Math.abs(effect.params.y ?? 0) < 0.000001
        && Math.abs((effect.params.scale ?? 100) - 100) < 0.000001
        && Math.abs(effect.params.rotation ?? 0) < 0.000001;
    case "meshDeform": return Math.abs(effect.params.amount ?? 25) < 0.000001;
    case "brightness":
    case "contrast": return Math.abs(effect.params.amount ?? 0) < 0.000001;
    case "tint": return Math.abs((effect.params.red ?? 100) - 100) < 0.000001
      && Math.abs((effect.params.green ?? 100) - 100) < 0.000001
      && Math.abs((effect.params.blue ?? 100) - 100) < 0.000001;
    case "opacity":
    case "saturation":
    case "gamma": return Math.abs((effect.params.amount ?? 100) - 100) < 0.000001;
    case "hue": return Math.abs(effect.params.angle ?? 0) < 0.000001;
    case "vignette": return Math.abs(effect.params.amount ?? 35) < 0.000001;
    default: return false;
  }
}
