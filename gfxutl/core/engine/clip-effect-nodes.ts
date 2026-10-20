import * as THREE from "three/webgpu";
import { abs, distance, dot, float, fract, hue, length, luminance, max, min, mix, pow, rtt, saturation, sin, smoothstep, uv, vec2, vec3, vec4 } from "three/tsl";
import type { ClipEffect } from "../protocol/engine-protocol";
import type { createFilterRegionNodeCache } from "./filter-region-nodes";

type Node = any;
type FilterMasks = ReturnType<typeof createFilterRegionNodeCache>;
type TextureSampler = (coordinates: Node) => Node;

const ALPHA_EFFECTS = new Set<ClipEffect["kind"]>(["opacity", "chromaKey", "colorKey", "luminanceKey", "outline", "shadow", "wipe", "boundaryBlur"]);
const OFFSCREEN_EFFECTS = new Set<ClipEffect["kind"]>(["pixelate", "colorShift", "edge", "sharpen", "blur", "boundaryBlur", "radialBlur", "directionalBlur", "lensBlur", "emission", "glow", "outline", "shadow", "displacement"]);

export function clipEffectChangesAlpha(effect: ClipEffect) {
  return ALPHA_EFFECTS.has(effect.kind);
}

export interface ClipEffectNodeOptions {
  sample: TextureSampler;
  effects: readonly ClipEffect[];
  filterMasks: FilterMasks;
  texel?: Node;
  coordinates?: Node;
  input?: Node;
}

const rgbParam = (params: Record<string, number>, prefix = "", fallback: [number, number, number] = [100, 100, 100]) => vec3(
  (params[`${prefix}red`] ?? fallback[0]) / 100,
  (params[`${prefix}green`] ?? fallback[1]) / 100,
  (params[`${prefix}blue`] ?? fallback[2]) / 100,
);

function average(samples: Node[]) {
  let result = samples[0];
  for (let index = 1; index < samples.length; index++) result = result.add(samples[index]);
  return result.div(samples.length);
}

function ringSamples(sample: TextureSampler, coordinates: Node, texel: Node, radius: number, includeCenter = true) {
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
  const values = includeCenter ? [sample(coordinates)] : [];
  for (const [x, y] of offsets) values.push(sample(coordinates.add(texel.mul(vec2(x * radius, y * radius)))));
  return values;
}

function lumaEdge(sample: TextureSampler, coordinates: Node, texel: Node, radius: number) {
  const leftSample = sample(coordinates.sub(vec2(texel.x.mul(radius), 0)));
  const rightSample = sample(coordinates.add(vec2(texel.x.mul(radius), 0)));
  const upSample = sample(coordinates.add(vec2(0, texel.y.mul(radius))));
  const downSample = sample(coordinates.sub(vec2(0, texel.y.mul(radius))));
  const left = luminance(leftSample.rgb);
  const right = luminance(rightSample.rgb);
  const up = luminance(upSample.rgb);
  const down = luminance(downSample.rgb);
  return abs(right.sub(left)).add(abs(up.sub(down)));
}

/**
 * Builds an ordered texture-domain effect chain. Neighbourhood effects share the
 * same sampler abstraction, so preview and export compile identical TSL graphs.
 * This is also the compositing boundary used by future render-target passes.
 */
export function applyClipEffectNodes({ sample, effects, filterMasks, texel = vec2(1 / 1920, 1 / 1080), coordinates = uv(), input }: ClipEffectNodeOptions) {
  let rgba: Node = input ?? sample(coordinates);
  for (const effect of effects) {
    if (effect.kind === "transform" || effect.kind === "meshDeform") continue;
    const previous = rgba;
    const p = effect.params;
    let next = rgba;
    const offscreen: any = OFFSCREEN_EFFECTS.has(effect.kind) ? rtt(rgba) : null;
    const effectSample: TextureSampler = offscreen ? (sampleCoordinates) => offscreen.sample(sampleCoordinates) : sample;

    if (effect.kind === "pixelate") {
      const cells = Math.max(1, p.size ?? 8);
      next = effectSample(coordinates.mul(cells).floor().add(0.5).div(cells));
    } else if (effect.kind === "brightness") next = vec4(rgba.rgb.mul(Math.max(0, 1 + (p.amount ?? 0) / 100)), rgba.a);
    else if (effect.kind === "tint") next = vec4(rgba.rgb.mul(rgbParam(p)), rgba.a);
    else if (effect.kind === "opacity") {
      // Full-object opacity is folded into the clip/object transform. Only a
      // regional opacity effect belongs in this fragment stack.
      if (!effect.filterRegion) continue;
      next = vec4(rgba.rgb, rgba.a.mul(THREE.MathUtils.clamp((p.amount ?? 100) / 100, 0, 1)));
    }
    else if (effect.kind === "contrast") next = vec4(rgba.rgb.sub(0.5).mul(Math.max(0, 1 + (p.amount ?? 0) / 100)).add(0.5), rgba.a);
    else if (effect.kind === "saturation") next = vec4(saturation(rgba.rgb, Math.max(0, (p.amount ?? 100) / 100)), rgba.a);
    else if (effect.kind === "gamma") next = vec4(pow(max(rgba.rgb, vec3(0)), vec3(1 / Math.max(0.01, (p.amount ?? 100) / 100))), rgba.a);
    else if (effect.kind === "hue") next = vec4(hue(rgba.rgb, THREE.MathUtils.degToRad(p.angle ?? 0)), rgba.a);
    else if (effect.kind === "chromaKey" || effect.kind === "colorKey") {
      const key = rgbParam(p, "", [0, 100, 0]);
      const threshold = Math.max(0, (p.threshold ?? 20) / 100);
      const softness = Math.max(0.001, (p.softness ?? 10) / 100);
      next = vec4(rgba.rgb, rgba.a.mul(smoothstep(threshold, threshold + softness, distance(rgba.rgb, key))));
    } else if (effect.kind === "luminanceKey") {
      const value = luminance(rgba.rgb);
      const threshold = THREE.MathUtils.clamp((p.threshold ?? 50) / 100, 0, 1);
      const softness = Math.max(0.001, (p.softness ?? 10) / 100);
      const keyed = p.invert ? smoothstep(threshold, threshold + softness, value) : float(1).sub(smoothstep(threshold - softness, threshold, value));
      next = vec4(rgba.rgb, rgba.a.mul(keyed));
    } else if (effect.kind === "monochrome") {
      const amount = THREE.MathUtils.clamp((p.amount ?? 100) / 100, 0, 1);
      const gray = vec3(luminance(rgba.rgb)).mul(rgbParam(p, "", [100, 100, 100]));
      next = vec4(mix(rgba.rgb, gray, amount), rgba.a);
    } else if (effect.kind === "invert") {
      const amount = THREE.MathUtils.clamp((p.amount ?? 100) / 100, 0, 1);
      next = vec4(mix(rgba.rgb, vec3(1).sub(rgba.rgb), amount), p.alpha ? mix(rgba.a, float(1).sub(rgba.a), amount) : rgba.a);
    } else if (effect.kind === "colorRange") {
      const source = rgbParam(p, "source", [100, 0, 0]);
      const target = rgbParam(p, "target", [0, 0, 100]);
      const tolerance = Math.max(0.001, (p.tolerance ?? 20) / 100);
      const softness = Math.max(0.001, (p.softness ?? 10) / 100);
      const amount = float(1).sub(smoothstep(tolerance, tolerance + softness, distance(rgba.rgb, source)));
      next = vec4(mix(rgba.rgb, target, amount), rgba.a);
    } else if (effect.kind === "colorShift") {
      const amount = (p.amount ?? 4) / 100;
      const angle = THREE.MathUtils.degToRad(p.angle ?? 0);
      const offset = vec2(Math.cos(angle) * amount, Math.sin(angle) * amount);
      const positive = effectSample(coordinates.add(offset));
      const negative = effectSample(coordinates.sub(offset));
      next = vec4(positive.r, rgba.g, negative.b, max(rgba.a, max(positive.a, negative.a)));
    } else if (effect.kind === "gradient") {
      const angle = THREE.MathUtils.degToRad(p.angle ?? 0);
      const axis = vec2(Math.cos(angle), Math.sin(angle));
      const position = coordinates.sub(0.5).dot(axis).add(0.5 + (p.offset ?? 0) / 100);
      const ramp = smoothstep(0, 1, position);
      const gradient = mix(rgbParam(p, "start", [0, 0, 0]), rgbParam(p, "end", [100, 100, 100]), ramp);
      next = vec4(mix(rgba.rgb, gradient, THREE.MathUtils.clamp((p.amount ?? 100) / 100, 0, 1)), rgba.a);
    } else if (effect.kind === "noise") {
      const scale = Math.max(1, p.scale ?? 120);
      const seed = p.seed ?? 0;
      const random = fract(sin(dot(coordinates.mul(scale).floor().add(seed), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
      const amount = (p.amount ?? 15) / 100;
      const colored = vec3(random, fract(random.mul(17.17)).sub(0.5), fract(random.mul(31.73)).sub(0.5));
      next = vec4(max(vec3(0), rgba.rgb.add(p.monochrome ? vec3(random.mul(amount)) : colored.mul(amount))), rgba.a);
    } else if (effect.kind === "edge") {
      const strength = Math.max(0, (p.amount ?? 100) / 100);
      const edge = lumaEdge(effectSample, coordinates, texel, Math.max(0.25, p.radius ?? 1)).mul(strength);
      next = vec4(p.monochrome === 0 ? rgba.rgb.mul(edge) : vec3(edge), rgba.a);
    } else if (effect.kind === "sharpen") {
      const amount = Math.max(0, (p.amount ?? 50) / 100);
      const neighbours = average(ringSamples(effectSample, coordinates, texel, Math.max(0.25, p.radius ?? 1), false));
      next = vec4(max(vec3(0), rgba.rgb.add(rgba.rgb.sub(neighbours.rgb).mul(amount))), rgba.a);
    } else if (effect.kind === "blur" || effect.kind === "boundaryBlur") {
      const blurred = average(ringSamples(effectSample, coordinates, texel, Math.max(0.25, p.radius ?? 4)));
      const amount = THREE.MathUtils.clamp((p.amount ?? 100) / 100, 0, 1);
      const blend = effect.kind === "boundaryBlur" ? float(1).sub(rgba.a).add(lumaEdge(effectSample, coordinates, texel, Math.max(0.25, p.radius ?? 4))).mul(amount) : float(amount);
      next = mix(rgba, blurred, min(1, blend));
    } else if (effect.kind === "directionalBlur") {
      const radius = Math.max(0.25, p.radius ?? 8);
      const angle = THREE.MathUtils.degToRad(p.angle ?? 0);
      const direction = texel.mul(vec2(Math.cos(angle), Math.sin(angle))).mul(radius);
      next = average([-2, -1, 0, 1, 2].map((offset) => effectSample(coordinates.add(direction.mul(offset / 2)))));
    } else if (effect.kind === "radialBlur") {
      const center = vec2((p.centerX ?? 50) / 100, 1 - (p.centerY ?? 50) / 100);
      const direction = center.sub(coordinates).mul((p.amount ?? 12) / 100);
      next = average([0, 0.25, 0.5, 0.75, 1].map((offset) => effectSample(coordinates.add(direction.mul(offset)))));
    } else if (effect.kind === "lensBlur") {
      next = average(ringSamples(effectSample, coordinates, texel, Math.max(0.25, p.radius ?? 6)));
    } else if (effect.kind === "emission" || effect.kind === "glow") {
      const radius = Math.max(0.25, p.radius ?? (effect.kind === "glow" ? 8 : 3));
      const blurred = average(ringSamples(effectSample, coordinates, texel, radius));
      const threshold = THREE.MathUtils.clamp((p.threshold ?? 55) / 100, 0, 1);
      const light = smoothstep(threshold, Math.min(1, threshold + 0.2), luminance(blurred.rgb));
      const emitted = blurred.rgb.mul(rgbParam(p, "", [100, 100, 100])).mul(light).mul(Math.max(0, (p.amount ?? 100) / 100));
      next = vec4(rgba.rgb.add(emitted), max(rgba.a, blurred.a.mul(light)));
    } else if (effect.kind === "outline") {
      const alphaSamples = ringSamples(effectSample, coordinates, texel, Math.max(0.25, p.width ?? 2), false).map((value) => value.a);
      let expanded = alphaSamples[0];
      for (let index = 1; index < alphaSamples.length; index++) expanded = max(expanded, alphaSamples[index]);
      const outlineAlpha = max(0, expanded.sub(rgba.a)).mul(Math.max(0, (p.opacity ?? 100) / 100));
      next = vec4(rgba.rgb.add(rgbParam(p, "", [0, 0, 0]).mul(outlineAlpha).mul(float(1).sub(rgba.a))), max(rgba.a, outlineAlpha));
    } else if (effect.kind === "shadow") {
      const angle = THREE.MathUtils.degToRad(p.angle ?? 45);
      const offset = texel.mul(vec2(Math.cos(angle), -Math.sin(angle))).mul(Math.max(0, p.distance ?? 8));
      const shadowSample = average(ringSamples(effectSample, coordinates.sub(offset), texel, Math.max(0.25, p.blur ?? 3)));
      const shadowAlpha = shadowSample.a.mul(Math.max(0, (p.opacity ?? 60) / 100)).mul(float(1).sub(rgba.a));
      next = vec4(rgba.rgb.add(rgbParam(p, "", [0, 0, 0]).mul(shadowAlpha)), rgba.a.add(shadowAlpha));
    } else if (effect.kind === "wipe") {
      const angle = THREE.MathUtils.degToRad(p.angle ?? 0);
      const axis = vec2(Math.cos(angle), Math.sin(angle));
      const position = coordinates.sub(0.5).dot(axis).add(0.5);
      const progress = THREE.MathUtils.clamp((p.progress ?? 50) / 100, 0, 1);
      const softness = Math.max(0.001, (p.softness ?? 2) / 100);
      next = vec4(rgba.rgb, rgba.a.mul(float(1).sub(smoothstep(progress - softness, progress + softness, position))));
    } else if (effect.kind === "displacement") {
      const mapValue = effectSample(coordinates.add(vec2((p.mapOffsetX ?? 0) / 100, -(p.mapOffsetY ?? 0) / 100)));
      const displacement = mapValue.rg.sub(0.5).mul((p.amount ?? 10) / 100);
      next = effectSample(coordinates.add(displacement));
    } else if (effect.kind === "vignette") {
      const radius = Math.max(0.01, (p.size ?? 65) / 100);
      const amount = Math.max(0, (p.amount ?? 35) / 100);
      const edge = smoothstep(radius, Math.max(radius + 0.001, 1), length(coordinates.sub(vec2(0.5)).mul(1.4142)));
      next = vec4(rgba.rgb.mul(float(1).sub(edge.mul(amount))), rgba.a);
    }

    if (effect.filterRegion) rgba = mix(previous, next, filterMasks.fragment(effect.filterRegion));
    else rgba = next;
  }
  return rgba;
}
