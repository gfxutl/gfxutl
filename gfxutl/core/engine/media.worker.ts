/// <reference lib="webworker" />

import * as THREE from "three/webgpu";
import { abs, cos, distance, float, Fn, hue, instanceIndex, length, max, pow, saturation, sin, smoothstep, storage, texture as textureNode, uniform, uv, vec2, vec3, vec4, vertexIndex } from "three/tsl";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, VideoSampleSink, WebMOutputFormat } from "mediabunny";
import type { ClipKeyframe, EngineRequest, EngineResponse, RenderClip, SceneObjectSpec, SceneSettings } from "../protocol/engine-protocol";
import { RamPreviewCache } from "./ram-preview-cache";
import { createRenderPipeline, shadowTypeFrom, ThreeRendererCore, toneMappingFrom } from "./three-renderer-core";
import { ThreeSceneCore } from "./three-scene-core";
import { registerLocalFont } from "./three-geometry-factory";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let channelPort: MessagePort | null = null;
interface PreviewAccessUnit {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  codedWidth: number;
  codedHeight: number;
}

const cache = new RamPreviewCache<PreviewAccessUnit>(128 * 1024 * 1024);
let ramPreviewEnabled = true;

let canvas: OffscreenCanvas | null = null;
let graphics: ThreeRendererCore | null = null;
let sceneCore: ThreeSceneCore | null = null;
let width = 1280;
let height = 720;
let dpr = 1;
let encoder: VideoEncoder | null = null;
let recoveringGraphics = false;
let previewFps = 30;
let lastTimelineTime = 0;
let lastRendererStatsAt = -Infinity;
let playbackActive = false;
let sceneSettings: SceneSettings = {
  background: { color: 0xffffff, alpha: 1, fogEnabled: false, fogColor: 0xffffff, fogNear: 5, fogFar: 30, environmentIntensity: 1, environmentRotation: 0, backgroundBlurriness: 0 },
  camera: { projection: "orthographic", position: [0, 0, 10], target: [0, 0, 0], near: 0.01, far: 1_000, fov: 50, zoom: 1, orthographicHeight: 9 },
  renderer: { previewScale: 0.75, toneMapping: "aces", exposure: 1, outputBuffer: "uint8", antialias: true, samples: 2, shadows: true, shadowType: "pcf", transparentBackground: false, postProcessing: false, fxaa: false, bloomStrength: 0, bloomRadius: 0.25, bloomThreshold: 0.8 },
  lights: [
    { id: "ambient", kind: "ambient", color: 0xffffff, intensity: 1.2, position: [0, 0, 0] },
    { id: "key", kind: "directional", color: 0xffffff, intensity: 2.5, position: [4, 6, 8], target: [0, 0, 0], castShadow: true },
  ],
};

interface MediaRuntime {
  input: Input;
  videoSink?: VideoSampleSink;
  audioSink?: AudioSampleSink;
  duration: number;
}

interface VideoSurface {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
  texture: THREE.VideoFrameTexture;
  frame: VideoFrame | null;
  timestamp: number;
  requestedTime: number;
  aspect: number;
  effectSignature: string;
}

interface ImageRuntime {
  bitmap?: ImageBitmap;
  sourceTexture?: THREE.Texture;
  width: number;
  height: number;
}

interface ModelRuntime {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  duration: number;
}

interface ModelSurface {
  assetId: string;
  root: THREE.Group;
  mixer?: THREE.AnimationMixer;
  duration: number;
}

interface ParticleSurface {
  root: THREE.Points;
  material: THREE.PointsNodeMaterial;
  signature: string;
  gpu: boolean;
  positions: THREE.BufferAttribute | THREE.StorageBufferAttribute;
  timeNode?: any;
  computeNode?: any;
}

interface ImageSurface {
  assetId: string;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
  texture: THREE.Texture;
  aspect: number;
  effectSignature: string;
}

interface CachedPreviewSurface {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.VideoFrameTexture;
  frame: VideoFrame | null;
}

const mediaRuntimes = new Map<string, MediaRuntime>();
const imageRuntimes = new Map<string, ImageRuntime>();
const sharedImageTextures = new Map<string, THREE.Texture>();
const modelRuntimes = new Map<string, ModelRuntime>();
const videoSurfaces = new Map<string, VideoSurface>();
const imageSurfaces = new Map<string, ImageSurface>();
const modelSurfaces = new Map<string, ModelSurface>();
const particleSurfaces = new Map<string, ParticleSurface>();
const reportedVideoClips = new Set<string>();
const sceneClipSignatures = new Map<string, SceneObjectSpec>();
const renderTimeline = new Map<string, RenderClip>();
const standaloneObjects = new Map<string, SceneObjectSpec>();
let reportedSceneObjectCount = -1;
let reportedImageObjectCount = -1;
let activeModelObjectCount = 0;
let activeParticleObjectCount = 0;
let cachedPreviewSurface: CachedPreviewSurface | null = null;
let previewDecoder: VideoDecoder | null = null;
let previewDecoderSize = "";
let pendingPreviewDecode: ((frame: VideoFrame | null) => void) | null = null;

function resolveImageTexture(assetId: string, usage: "color" | "data" | "normal" | "background" | "environment") {
  const runtime = imageRuntimes.get(assetId);
  if (!runtime) return undefined;
  const key = `${assetId}:${usage}`;
  let texture = sharedImageTextures.get(key);
  if (texture) return texture;
  texture = runtime.sourceTexture?.clone() ?? new THREE.Texture(runtime.bitmap);
  texture.colorSpace = usage === "color" || usage === "background" || usage === "environment" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (usage === "background" || usage === "environment") texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  sharedImageTextures.set(key, texture);
  return texture;
}

function previewFrameKey(time: number, fps = previewFps) {
  return String(Math.max(0, Math.round(time * fps)));
}

function send(message: EngineResponse, transfer: Transferable[] = []) {
  channelPort?.postMessage(message, transfer);
}

function cacheStatus() {
  send({ type: "cache", usedBytes: cache.usedBytes, maxBytes: cache.maxBytes, entries: cache.size });
}

async function initialize(message: Extract<EngineRequest, { type: "init" }>) {
  await replaceCanvas(message.canvas, message.width, message.height, message.dpr);
  if (!graphics) throw new Error("Three.js scene is not initialized");
  send({ type: "ready", backend: graphics.backend, mediaBunnyReady: true, cameraProjection: sceneSettings.camera.projection });
  cacheStatus();
}

async function replaceCanvas(nextCanvas: OffscreenCanvas, nextWidth: number, nextHeight: number, nextDpr: number) {
  resetPreviewDecoder();
  for (const id of [...videoSurfaces.keys()]) removeVideoSurface(id);
  for (const id of [...imageSurfaces.keys()]) removeImageSurface(id);
  for (const id of [...modelSurfaces.keys()]) removeModelSurface(id);
  for (const id of [...particleSurfaces.keys()]) removeParticleSurface(id);
  if (cachedPreviewSurface) {
    cachedPreviewSurface.frame?.close();
    cachedPreviewSurface.texture.dispose();
    cachedPreviewSurface.mesh.geometry.dispose();
    cachedPreviewSurface.mesh.material.dispose();
    cachedPreviewSurface = null;
  }
  sceneCore?.dispose();
  await graphics?.dispose();
  encoder?.close();
  encoder = null;
  canvas = nextCanvas;
  width = Math.max(2, Math.floor(nextWidth));
  height = Math.max(2, Math.floor(nextHeight));
  dpr = nextDpr;
  graphics = await ThreeRendererCore.create(canvas, width, height, dpr, sceneSettings, {
    onError: (message) => send({ type: "error", message: `GPU: ${message}` }),
    onDeviceLost: (message) => { send({ type: "error", message: `${message} — rendererを復旧します` }); void recoverRenderer(); },
    resolveTexture: (assetId, usage) => resolveImageTexture(assetId, usage),
  });
  sceneCore = new ThreeSceneCore(graphics.scene, (assetId, usage) => resolveImageTexture(assetId, usage));
  sceneClipSignatures.clear();
  reportedSceneObjectCount = -1;
  reportedImageObjectCount = -1;
  for (const object of standaloneObjects.values()) sceneCore.upsert(object);
  cache.clear();
  setupEncoder();
}

async function recoverRenderer() {
  if (recoveringGraphics || !canvas) return;
  recoveringGraphics = true;
  try {
    await replaceCanvas(canvas, width, height, dpr);
    if (!graphics) throw new Error("renderer recreation failed");
    send({ type: "ready", backend: graphics.backend, mediaBunnyReady: true, cameraProjection: sceneSettings.camera.projection });
    await render(lastTimelineTime, false, "realtime", previewFps);
  } catch (error) {
    send({ type: "error", message: `GPU rendererの復旧に失敗しました: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    recoveringGraphics = false;
  }
}

function setupEncoder() {
  if (!ramPreviewEnabled || !("VideoEncoder" in worker) || !canvas) return;
  const codedWidth = Math.max(2, Math.floor(canvas.width / 2) * 2);
  const codedHeight = Math.max(2, Math.floor(canvas.height / 2) * 2);
  try {
    encoder = new VideoEncoder({
      output(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        cache.set(previewFrameKey(chunk.timestamp / 1_000_000), {
          data: bytes,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? Math.round(1_000_000 / previewFps),
          codedWidth,
          codedHeight,
        });
        cacheStatus();
      },
      error() { encoder = null; },
    });
    encoder.configure({
      codec: "avc1.42001f",
      width: codedWidth,
      height: codedHeight,
      bitrate: 3_000_000,
      framerate: previewFps,
      avc: { format: "annexb" },
      hardwareAcceleration: "no-preference",
    });
  } catch {
    encoder = null;
  }
}

function encodePreviewFrame(source: OffscreenCanvas, time: number, fps: number) {
  if (!encoder || encoder.encodeQueueSize >= 2) return false;
  try {
    const frame = new VideoFrame(source, {
      timestamp: Math.round(time * 1_000_000),
      duration: Math.round(1_000_000 / fps),
    });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    return true;
  } catch {
    return false;
  }
}

function ensureCachedPreviewSurface() {
  if (cachedPreviewSurface) return cachedPreviewSurface;
  const texture = new THREE.VideoFrameTexture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), material);
  mesh.position.z = 9;
  mesh.renderOrder = 100_000;
  graphics?.scene.add(mesh);
  cachedPreviewSurface = { mesh, texture, frame: null };
  return cachedPreviewSurface;
}

async function decodeCachedFrame(unit: PreviewAccessUnit) {
  if (!("VideoDecoder" in worker)) return null;
  const size = `${unit.codedWidth}x${unit.codedHeight}`;
  if (!previewDecoder || previewDecoder.state === "closed" || previewDecoderSize !== size) {
    resetPreviewDecoder();
    previewDecoderSize = size;
    previewDecoder = new VideoDecoder({
      output(frame) {
        const resolve = pendingPreviewDecode;
        pendingPreviewDecode = null;
        if (resolve) resolve(frame);
        else frame.close();
      },
      error() {
        const resolve = pendingPreviewDecode;
        pendingPreviewDecode = null;
        previewDecoder = null;
        resolve?.(null);
      },
    });
    previewDecoder.configure({ codec: "avc1.42001f", codedWidth: unit.codedWidth, codedHeight: unit.codedHeight, hardwareAcceleration: "no-preference" });
  }
  return new Promise<VideoFrame | null>((resolve) => {
    try {
      pendingPreviewDecode = resolve;
      previewDecoder!.decode(new EncodedVideoChunk({ type: "key", timestamp: unit.timestamp, duration: unit.duration, data: unit.data }));
      // Some hardware decoders retain an isolated keyframe until flush. The
      // decoder itself remains configured and is reused for the next frame.
      void previewDecoder!.flush().then(() => {
        if (pendingPreviewDecode === resolve) {
          pendingPreviewDecode = null;
          resolve(null);
        }
      }).catch(() => {
        if (pendingPreviewDecode === resolve) {
          pendingPreviewDecode = null;
          resetPreviewDecoder();
          resolve(null);
        }
      });
    } catch {
      pendingPreviewDecode = null;
      resetPreviewDecoder();
      resolve(null);
    }
  });
}

function resetPreviewDecoder() {
  const resolve = pendingPreviewDecode;
  pendingPreviewDecode = null;
  resolve?.(null);
  try { previewDecoder?.close(); } catch { /* Decoder may already be closed by an error. */ }
  previewDecoder = null;
  previewDecoderSize = "";
}

async function renderCachedPreview(time: number, fps: number) {
  if (!graphics || !ramPreviewEnabled) return false;
  const unit = cache.get(previewFrameKey(time, fps));
  if (!unit) return false;
  const frame = await decodeCachedFrame(unit);
  if (!frame) return false;
  const surface = ensureCachedPreviewSurface();
  const retired = surface.frame;
  surface.frame = frame;
  surface.texture.setFrame(frame);
  surface.mesh.visible = true;
  graphics.render();
  retired?.close();
  send({ type: "preview-source", source: "cache", frame: Number(previewFrameKey(time, fps)) });
  return true;
}

function removeVideoSurface(id: string) {
  const surface = videoSurfaces.get(id);
  if (!surface) return;
  surface.frame?.close();
  surface.texture.dispose();
  surface.mesh.geometry.dispose();
  surface.mesh.material.dispose();
  surface.mesh.removeFromParent();
  videoSurfaces.delete(id);
}

function fittedPlaneSize(aspect: number) {
  const maxWidth = 15.4;
  const maxHeight = 8.6;
  return aspect >= maxWidth / maxHeight
    ? { width: maxWidth, height: maxWidth / aspect }
    : { width: maxHeight * aspect, height: maxHeight };
}

function visualEffectSignature(clip: RenderClip) {
  return JSON.stringify([clip.effects.filter((effect) => effect.enabled && effect.kind !== "transform" && effect.kind !== "opacity"), clip.masks]);
}

function createVisualMaterial(texture: THREE.Texture, clip: RenderClip) {
  let texUv: any = uv();
  for (const effect of clip.effects) {
    if (!effect.enabled || effect.kind !== "pixelate") continue;
    const cells = Math.max(1, effect.params.size ?? 8);
    texUv = texUv.mul(cells).floor().add(0.5).div(cells);
  }
  const sampled = textureNode(texture, texUv);
  let rgb = sampled.rgb;
  let alpha: any = sampled.a;
  let combinedMask: any = null;
  for (const mask of clip.masks) {
    if (!mask.enabled) continue;
    const point = uv().sub(vec2(mask.x / 100, 1 - mask.y / 100));
    const halfWidth = Math.max(0.0001, mask.width / 200);
    const halfHeight = Math.max(0.0001, mask.height / 200);
    const edge = mask.shape === "ellipse"
      ? length(point.div(vec2(halfWidth, halfHeight)))
      : max(abs(point.x).div(halfWidth), abs(point.y).div(halfHeight));
    const feather = Math.max(0.0001, mask.feather / 100);
    let value: any = float(1).sub(smoothstep(Math.max(0, 1 - feather), 1, edge)).mul(THREE.MathUtils.clamp(mask.opacity / 100, 0, 1));
    if (mask.inverted) value = float(1).sub(value);
    if (combinedMask === null) combinedMask = mask.mode === "subtract" ? float(1).sub(value) : value;
    else if (mask.mode === "add") combinedMask = max(combinedMask, value);
    else if (mask.mode === "subtract") combinedMask = combinedMask.mul(float(1).sub(value));
    else combinedMask = combinedMask.mul(value);
  }
  if (combinedMask !== null) alpha = alpha.mul(combinedMask);
  for (const effect of clip.effects) {
    if (!effect.enabled) continue;
    if (effect.kind === "brightness") {
      rgb = rgb.mul(Math.max(0, 1 + (effect.params.amount ?? 0) / 100));
    } else if (effect.kind === "tint") {
      rgb = rgb.mul(vec3((effect.params.red ?? 100) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 100) / 100));
    } else if (effect.kind === "contrast") {
      rgb = rgb.sub(0.5).mul(Math.max(0, 1 + (effect.params.amount ?? 0) / 100)).add(0.5);
    } else if (effect.kind === "saturation") {
      rgb = saturation(rgb, Math.max(0, (effect.params.amount ?? 100) / 100));
    } else if (effect.kind === "gamma") {
      rgb = pow(max(rgb, vec3(0)), vec3(1 / Math.max(0.01, (effect.params.amount ?? 100) / 100)));
    } else if (effect.kind === "hue") {
      rgb = hue(rgb, THREE.MathUtils.degToRad(effect.params.angle ?? 0));
    } else if (effect.kind === "chromaKey") {
      const key = vec3((effect.params.red ?? 0) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 0) / 100);
      const threshold = Math.max(0, (effect.params.threshold ?? 20) / 100);
      const softness = Math.max(0.001, (effect.params.softness ?? 10) / 100);
      alpha = alpha.mul(smoothstep(threshold, threshold + softness, distance(rgb, key)));
    } else if (effect.kind === "vignette") {
      const amount = Math.max(0, (effect.params.amount ?? 35) / 100);
      const size = THREE.MathUtils.clamp((effect.params.size ?? 65) / 100, 0.01, 1);
      const radius = length(uv().sub(vec2(0.5)));
      rgb = rgb.mul(float(1).sub(smoothstep(size * 0.5, Math.max(size * 0.5 + 0.001, 0.72), radius).mul(amount)));
    }
  }
  const alphaMasked = clip.masks.some((mask) => mask.enabled) || clip.effects.some((effect) => effect.enabled && effect.kind === "chromaKey");
  const material = new THREE.MeshBasicNodeMaterial({ transparent: alphaMasked || clip.opacity < 100, depthTest: true, depthWrite: !alphaMasked && clip.opacity >= 100, toneMapped: false });
  material.userData.gfxAlphaMasked = alphaMasked;
  material.colorNode = vec4(rgb, alpha);
  return material;
}

function refreshVisualMaterial(surface: VideoSurface | ImageSurface, clip: RenderClip) {
  const signature = visualEffectSignature(clip);
  if (surface.effectSignature === signature) return;
  const previous = surface.mesh.material;
  surface.mesh.material = createVisualMaterial(surface.texture, clip);
  surface.effectSignature = signature;
  previous.dispose();
}

function ensureVideoSurface(clip: RenderClip, aspect: number) {
  let surface = videoSurfaces.get(clip.id);
  if (!surface) {
    const texture = new THREE.VideoFrameTexture();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    const material = createVisualMaterial(texture, clip);
    const fitted = fittedPlaneSize(aspect);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(fitted.width, fitted.height), material);
    mesh.name = `media:${clip.id}`;
    mesh.position.z = 2;
    mesh.renderOrder = 1_000;
    graphics?.scene.add(mesh);
    surface = { mesh, texture, frame: null, timestamp: -Infinity, requestedTime: -Infinity, aspect, effectSignature: visualEffectSignature(clip) };
    videoSurfaces.set(clip.id, surface);
  } else if (Math.abs(surface.aspect - aspect) > 0.001) {
    surface.mesh.geometry.dispose();
    const fitted = fittedPlaneSize(aspect);
    surface.mesh.geometry = new THREE.PlaneGeometry(fitted.width, fitted.height);
    surface.aspect = aspect;
  }
  refreshVisualMaterial(surface, clip);
  return surface;
}

function applyVisualTransform(mesh: THREE.Object3D, material: THREE.Material, clip: RenderClip) {
  let positionX = clip.positionX / 100;
  let positionY = -clip.positionY / 100;
  let scaleX = clip.scale / 100 * clip.scaleX / 100;
  let scaleY = clip.scale / 100 * clip.scaleY / 100;
  let rotation = -THREE.MathUtils.degToRad(clip.rotation);
  let opacity = clip.opacity / 100;
  for (const effect of clip.effects) {
    if (!effect.enabled) continue;
    if (effect.kind === "transform") {
      const localX = (effect.params.x ?? 0) / 100;
      const localY = -(effect.params.y ?? 0) / 100;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      positionX += (cos * localX - sin * localY) * scaleX;
      positionY += (sin * localX + cos * localY) * scaleY;
      const effectScale = (effect.params.scale ?? 100) / 100;
      scaleX *= effectScale;
      scaleY *= effectScale;
      rotation -= THREE.MathUtils.degToRad(effect.params.rotation ?? 0);
    } else if (effect.kind === "opacity") {
      opacity *= (effect.params.amount ?? 100) / 100;
    }
  }
  mesh.position.set(positionX, positionY, clip.positionZ / 100);
  mesh.rotation.z = rotation;
  mesh.scale.set(Math.max(0.001, scaleX), Math.max(0.001, scaleY), 1);
  mesh.renderOrder = clip.renderOrder;
  material.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
  material.transparent = Boolean(material.userData.gfxAlphaMasked) || material.opacity < 1;
  material.depthWrite = !material.userData.gfxAlphaMasked && material.opacity >= 1;
}

function applyTextureCrop(texture: THREE.Texture, clip: RenderClip, sourceWidth: number, sourceHeight: number) {
  texture.offset.set(THREE.MathUtils.clamp(clip.cropLeft / sourceWidth, 0, 0.99), THREE.MathUtils.clamp(clip.cropBottom / sourceHeight, 0, 0.99));
  texture.repeat.set(
    Math.max(0.001, 1 - (clip.cropLeft + clip.cropRight) / sourceWidth),
    Math.max(0.001, 1 - (clip.cropTop + clip.cropBottom) / sourceHeight),
  );
}

async function updateVideoSurfaces(time: number, clips: RenderClip[]) {
  const retiredFrames: VideoFrame[] = [];
  const samplesToClose: Array<Awaited<ReturnType<VideoSampleSink["getSample"]>>> = [];
  const readyClipIds: Array<{ clipId: string; timestamp: number }> = [];
  const knownIds = new Set(clips.map((clip) => clip.id));
  for (const id of videoSurfaces.keys()) if (!knownIds.has(id)) removeVideoSurface(id);
  for (const surface of videoSurfaces.values()) surface.mesh.visible = false;

  for (const clip of clips) {
    if (!clip.assetId || time < clip.start || time >= clip.start + clip.duration) continue;
    const runtime = mediaRuntimes.get(clip.assetId);
    if (!runtime?.videoSink) continue;
    const requestedTime = clip.offset + (time - clip.start) * THREE.MathUtils.clamp(clip.speed / 100, 0.01, 10);
    let surface = videoSurfaces.get(clip.id);
    if (!surface?.frame || Math.abs(surface.requestedTime - requestedTime) > 0.000001) {
      const sample = await runtime.videoSink.getSample(requestedTime);
      if (!sample) continue;
      samplesToClose.push(sample);
      const aspect = sample.displayWidth / sample.displayHeight;
      surface = ensureVideoSurface(clip, aspect);
      surface.requestedTime = requestedTime;
      if (Math.abs(surface.timestamp - sample.timestamp) > 0.000001) {
        const frame = sample.toVideoFrame();
        if (surface.frame) retiredFrames.push(surface.frame);
        surface.frame = frame;
        surface.timestamp = sample.timestamp;
        surface.texture.setFrame(frame);
        if (!reportedVideoClips.has(clip.id)) {
          readyClipIds.push({ clipId: clip.id, timestamp: sample.timestamp });
        }
      }
    }
    if (!surface) continue;
    surface.mesh.visible = true;
    applyVisualTransform(surface.mesh, surface.mesh.material, clip);
    const frameWidth = Math.max(1, surface.frame?.displayWidth ?? 1);
    const frameHeight = Math.max(1, surface.frame?.displayHeight ?? 1);
    applyTextureCrop(surface.texture, clip, frameWidth, frameHeight);
  }
  return { retiredFrames, readyClipIds, samplesToClose };
}

function removeImageSurface(id: string) {
  const surface = imageSurfaces.get(id);
  if (!surface) return;
  surface.texture.dispose();
  surface.mesh.geometry.dispose();
  surface.mesh.material.dispose();
  surface.mesh.removeFromParent();
  imageSurfaces.delete(id);
}

function ensureImageSurface(clip: RenderClip, runtime: ImageRuntime) {
  let surface = imageSurfaces.get(clip.id);
  const aspect = runtime.width / runtime.height;
  if (surface && surface.assetId !== clip.assetId) {
    removeImageSurface(clip.id);
    surface = undefined;
  }
  if (!surface) {
    const texture = runtime.sourceTexture?.clone() ?? new THREE.Texture(runtime.bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = createVisualMaterial(texture, clip);
    const fitted = fittedPlaneSize(aspect);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(fitted.width, fitted.height), material);
    mesh.name = `media:${clip.id}`;
    graphics?.scene.add(mesh);
    surface = { assetId: clip.assetId!, mesh, texture, aspect, effectSignature: visualEffectSignature(clip) };
    imageSurfaces.set(clip.id, surface);
  }
  refreshVisualMaterial(surface, clip);
  return surface;
}

function updateImageSurfaces(time: number, clips: RenderClip[]) {
  let changed = false;
  const knownIds = new Set(clips.map((clip) => clip.id));
  for (const id of imageSurfaces.keys()) if (!knownIds.has(id)) { removeImageSurface(id); changed = true; }
  for (const surface of imageSurfaces.values()) surface.mesh.visible = false;
  let activeCount = 0;
  for (const clip of clips) {
    if (!clip.assetId || time < clip.start || time >= clip.start + clip.duration) continue;
    const runtime = imageRuntimes.get(clip.assetId);
    if (!runtime) continue;
    const existed = imageSurfaces.has(clip.id);
    const surface = ensureImageSurface(clip, runtime);
    changed ||= !existed;
    surface.mesh.visible = true;
    applyVisualTransform(surface.mesh, surface.mesh.material, clip);
    applyTextureCrop(surface.texture, clip, runtime.width, runtime.height);
    activeCount++;
  }
  if (reportedImageObjectCount !== activeCount) {
    reportedImageObjectCount = activeCount;
    send({ type: "image-object-count", count: activeCount });
  }
  return changed;
}

function removeModelSurface(id: string) {
  const surface = modelSurfaces.get(id);
  if (!surface) return;
  surface.mixer?.stopAllAction();
  surface.root.traverse((object) => {
    const renderable = object as THREE.Mesh;
    const materials = Array.isArray(renderable.material) ? renderable.material : renderable.material ? [renderable.material] : [];
    materials.forEach((material) => material.dispose());
  });
  surface.root.removeFromParent();
  modelSurfaces.delete(id);
}

function ensureModelSurface(clip: RenderClip, runtime: ModelRuntime) {
  let surface = modelSurfaces.get(clip.id);
  if (surface && surface.assetId !== clip.assetId) {
    removeModelSurface(clip.id);
    surface = undefined;
  }
  if (surface) return surface;
  const model = cloneSkinned(runtime.scene) as THREE.Group;
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((material) => material.clone());
    else mesh.material = mesh.material.clone();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      material.userData.gfxBaseOpacity = material.opacity;
      const color = (material as THREE.Material & { color?: THREE.Color }).color;
      if (color) material.userData.gfxBaseColor = color.getHex();
    });
  });
  const root = new THREE.Group();
  root.name = `timeline:${clip.id}`;
  root.add(model);
  graphics?.scene.add(root);
  const mixer = runtime.animations.length ? new THREE.AnimationMixer(model) : undefined;
  runtime.animations.forEach((animation) => mixer?.clipAction(animation).play());
  surface = { assetId: clip.assetId!, root, mixer, duration: runtime.duration };
  modelSurfaces.set(clip.id, surface);
  void graphics?.precompile();
  return surface;
}

function applyModelTransform(surface: ModelSurface, clip: RenderClip) {
  let positionX = clip.positionX / 100;
  let positionY = -clip.positionY / 100;
  let scaleX = clip.scale / 100 * clip.scaleX / 100;
  let scaleY = clip.scale / 100 * clip.scaleY / 100;
  let rotationZ = -THREE.MathUtils.degToRad(clip.rotation);
  let opacity = clip.opacity / 100;
  let brightness = 0;
  let tint = new THREE.Color(1, 1, 1);
  for (const effect of clip.effects) {
    if (!effect.enabled) continue;
    if (effect.kind === "transform") {
      positionX += (effect.params.x ?? 0) / 100;
      positionY -= (effect.params.y ?? 0) / 100;
      const effectScale = (effect.params.scale ?? 100) / 100;
      scaleX *= effectScale;
      scaleY *= effectScale;
      rotationZ -= THREE.MathUtils.degToRad(effect.params.rotation ?? 0);
    } else if (effect.kind === "opacity") opacity *= (effect.params.amount ?? 100) / 100;
    else if (effect.kind === "brightness") brightness += (effect.params.amount ?? 0) / 100;
    else if (effect.kind === "tint") tint.multiply(new THREE.Color((effect.params.red ?? 100) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 100) / 100));
  }
  surface.root.position.set(positionX, positionY, clip.positionZ / 100);
  surface.root.rotation.set(THREE.MathUtils.degToRad(clip.rotationX), THREE.MathUtils.degToRad(clip.rotationY), rotationZ);
  surface.root.scale.set(Math.max(0.001, scaleX), Math.max(0.001, scaleY), Math.max(0.001, clip.scale / 100));
  surface.root.renderOrder = clip.renderOrder;
  surface.root.layers.set(THREE.MathUtils.clamp(clip.layer, 0, 31));
  surface.root.traverse((object) => {
    object.renderOrder = clip.renderOrder;
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material) => {
      material.opacity = THREE.MathUtils.clamp((material.userData.gfxBaseOpacity ?? 1) * opacity, 0, 1);
      material.transparent = material.opacity < 1;
      const color = (material as THREE.Material & { color?: THREE.Color }).color;
      if (color && material.userData.gfxBaseColor !== undefined) color.setHex(material.userData.gfxBaseColor).multiply(tint).offsetHSL(0, 0, brightness);
    });
  });
}

function updateModelSurfaces(time: number, clips: RenderClip[]) {
  const knownIds = new Set(clips.map((clip) => clip.id));
  for (const id of modelSurfaces.keys()) if (!knownIds.has(id)) removeModelSurface(id);
  for (const surface of modelSurfaces.values()) surface.root.visible = false;
  let active = 0;
  for (const clip of clips) {
    if (!clip.assetId || time < clip.start || time >= clip.start + clip.duration) continue;
    const runtime = modelRuntimes.get(clip.assetId);
    if (!runtime) continue;
    const surface = ensureModelSurface(clip, runtime);
    surface.root.visible = clip.visible;
    applyModelTransform(surface, clip);
    if (surface.mixer) {
      const animationTime = clip.offset + (time - clip.start) * THREE.MathUtils.clamp(clip.speed / 100, 0.01, 10);
      surface.mixer.setTime(surface.duration > 0 ? animationTime % surface.duration : animationTime);
    }
    active++;
  }
  for (const clip of clips) {
    const surface = modelSurfaces.get(clip.id);
    if (!surface || !surface.root.visible) continue;
    const parent = clip.parentId ? graphics?.scene.getObjectByName(`timeline:${clip.parentId}`) : graphics?.scene;
    if (parent && canParentObject(surface.root, parent)) parent.add(surface.root);
  }
  for (const clip of clips) {
    if (clip.sceneObject?.parentId && time >= clip.start && time < clip.start + clip.duration) sceneCore?.upsert(clip.sceneObject);
  }
  activeModelObjectCount = active;
  const total = sceneClipSignatures.size + activeModelObjectCount + activeParticleObjectCount;
  if (reportedSceneObjectCount !== total) {
    reportedSceneObjectCount = total;
    send({ type: "scene-object-count", count: total });
  }
}

function canParentObject(object: THREE.Object3D, parent: THREE.Object3D) {
  for (let current: THREE.Object3D | null = parent; current; current = current.parent) if (current === object) return false;
  return object !== parent;
}

function removeParticleSurface(id: string) {
  const surface = particleSurfaces.get(id);
  if (!surface) return;
  surface.root.removeFromParent();
  surface.root.geometry.dispose();
  surface.material.dispose();
  particleSurfaces.delete(id);
}

function ensureParticleSurface(clip: RenderClip, renderer: THREE.WebGPURenderer) {
  const spec = clip.particleSystem!;
  const count = Math.max(1, Math.min(100_000, Math.floor(spec.count)));
  const gpu = (renderer.backend as THREE.WebGPURenderer["backend"] & { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const signature = JSON.stringify([count, spec.size, spec.spread, spec.speed, spec.color, gpu]);
  let surface = particleSurfaces.get(clip.id);
  if (surface?.signature === signature) return surface;
  if (surface) removeParticleSurface(clip.id);
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.PointsNodeMaterial({ color: spec.color, size: Math.max(0.001, spec.size), sizeAttenuation: true, transparent: clip.opacity < 100, depthTest: true, depthWrite: clip.opacity >= 100 });
  let positions: THREE.BufferAttribute | THREE.StorageBufferAttribute;
  let timeNode: any;
  let computeNode: any;
  if (gpu) {
    positions = new THREE.StorageBufferAttribute(new Float32Array(count * 4), 4);
    const positionStorage = storage(positions, "vec4", count);
    timeNode = uniform(0);
    computeNode = Fn(() => {
      const index = float(instanceIndex);
      const phase = index.mul(12.9898);
      const motion = timeNode.mul(spec.speed);
      const radius = sin(index.mul(0.73).add(motion)).mul(0.5).add(0.5).mul(spec.spread);
      positionStorage.element(instanceIndex).assign(vec4(cos(phase.add(motion)).mul(radius), sin(index.mul(0.37).add(motion.mul(1.7))).mul(spec.spread), sin(phase.add(motion)).mul(radius), 1));
    })().compute(count);
    material.positionNode = positionStorage.element(vertexIndex).xyz;
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  } else {
    positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute("position", positions);
  }
  const root = new THREE.Points(geometry, material);
  root.name = `timeline:${clip.id}`;
  graphics?.scene.add(root);
  surface = { root, material, signature, gpu, positions, timeNode, computeNode };
  particleSurfaces.set(clip.id, surface);
  return surface;
}

function updateParticleSurfaces(time: number, clips: RenderClip[], renderer = graphics?.renderer) {
  if (!renderer) return;
  const knownIds = new Set(clips.filter((clip) => clip.particleSystem).map((clip) => clip.id));
  for (const id of particleSurfaces.keys()) if (!knownIds.has(id)) removeParticleSurface(id);
  for (const surface of particleSurfaces.values()) surface.root.visible = false;
  let active = 0;
  for (const clip of clips) {
    const spec = clip.particleSystem;
    if (!spec || time < clip.start || time >= clip.start + clip.duration) continue;
    const surface = ensureParticleSurface(clip, renderer);
    const localTime = clip.offset + (time - clip.start) * THREE.MathUtils.clamp(clip.speed / 100, 0.01, 10);
    if (surface.gpu) {
      surface.timeNode.value = localTime;
      renderer.compute(surface.computeNode);
    } else {
      const positions = surface.positions as THREE.BufferAttribute;
      for (let index = 0; index < positions.count; index++) {
        const phase = index * 12.9898;
        const motion = localTime * spec.speed;
        const radius = (Math.sin(index * 0.73 + motion) * 0.5 + 0.5) * spec.spread;
        positions.setXYZ(index, Math.cos(phase + motion) * radius, Math.sin(index * 0.37 + motion * 1.7) * spec.spread, Math.sin(phase + motion) * radius);
      }
      positions.needsUpdate = true;
      surface.root.geometry.computeBoundingSphere();
    }
    surface.root.visible = clip.visible;
    surface.root.layers.set(THREE.MathUtils.clamp(clip.layer, 0, 31));
    applyVisualTransform(surface.root, surface.material, clip);
    const parent = clip.parentId ? graphics?.scene.getObjectByName(`timeline:${clip.parentId}`) : graphics?.scene;
    if (parent && canParentObject(surface.root, parent)) parent.add(surface.root);
    active++;
  }
  activeParticleObjectCount = active;
  const total = sceneClipSignatures.size + activeModelObjectCount + activeParticleObjectCount;
  if (reportedSceneObjectCount !== total) {
    reportedSceneObjectCount = total;
    send({ type: "scene-object-count", count: total });
  }
}

function updateTimelineSceneObjects(time: number, clips: RenderClip[]) {
  if (!sceneCore) return false;
  let changed = false;
  const knownIds = new Set(clips.flatMap((clip) => clip.sceneObject ? [clip.sceneObject.id] : []));
  for (const id of sceneClipSignatures.keys()) {
    if (!knownIds.has(id)) {
      sceneCore.remove(id);
      sceneClipSignatures.delete(id);
      changed = true;
    }
  }
  for (const clip of clips) {
    const object = clip.sceneObject;
    if (!object) continue;
    const active = time >= clip.start && time < clip.start + clip.duration;
    if (!active) {
      if (sceneClipSignatures.has(object.id)) {
        sceneCore.remove(object.id);
        sceneClipSignatures.delete(object.id);
        changed = true;
      }
      continue;
    }
    if (sceneClipSignatures.get(object.id) !== object) {
      sceneCore.upsert(object);
      sceneClipSignatures.set(object.id, object);
      send({ type: "geometry-ready", id: object.id });
      changed = true;
    }
  }
  const total = sceneClipSignatures.size + activeModelObjectCount + activeParticleObjectCount;
  if (reportedSceneObjectCount !== total) {
    reportedSceneObjectCount = total;
    send({ type: "scene-object-count", count: total });
  }
  return changed;
}

function pickSceneObject(ndcX: number, ndcY: number) {
  if (!graphics) return undefined;
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();
  raycaster.setFromCamera(new THREE.Vector2(THREE.MathUtils.clamp(ndcX, -1, 1), THREE.MathUtils.clamp(ndcY, -1, 1)), graphics.camera);
  const intersections = raycaster.intersectObjects(graphics.scene.children, true)
    .filter((hit) => hit.object.visible && worldVisible(hit.object) && hit.object !== cachedPreviewSurface?.mesh)
    .sort((a, b) => b.object.renderOrder - a.object.renderOrder || a.distance - b.distance);
  for (const hit of intersections) {
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      if (object.name.startsWith("media:")) return object.name.slice("media:".length);
      if (object.name.startsWith("timeline:")) return object.name.slice("timeline:".length);
      object = object.parent;
    }
  }
  return undefined;
}

function worldVisible(object: THREE.Object3D) {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

function evaluateClipsAtTime(clips: RenderClip[], time: number) {
  if (!clips.some((clip) => clip.keyframes.length > 0)) return clips;
  return clips.map((clip) => evaluateClipAtTime(clip, time));
}

function evaluateClipAtTime(clip: RenderClip, timelineTime: number) {
  if (!clip.keyframes.length) return clip;
  const evaluated = {
    ...clip,
    effects: structuredClone(clip.effects),
    masks: structuredClone(clip.masks),
    particleSystem: clip.particleSystem ? { ...clip.particleSystem } : undefined,
    sceneObject: clip.sceneObject ? structuredClone(clip.sceneObject) : undefined,
  };
  const localTime = THREE.MathUtils.clamp(timelineTime - clip.start, 0, clip.duration);
  const properties = new Set(clip.keyframes.map((keyframe) => keyframe.property));
  for (const property of properties) {
    const keys = clip.keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
    const left = [...keys].reverse().find((keyframe) => keyframe.time <= localTime) ?? keys[0];
    const right = keys.find((keyframe) => keyframe.time >= localTime) ?? keys.at(-1)!;
    let value = left.value;
    if (right !== left && left.interpolation !== "step") {
      let alpha = THREE.MathUtils.clamp((localTime - left.time) / Math.max(0.000001, right.time - left.time), 0, 1);
      if (left.interpolation === "smooth") alpha = alpha * alpha * (3 - 2 * alpha);
      else if (left.interpolation === "bezier") alpha = cubicBezierAt(left.easing, alpha);
      value = THREE.MathUtils.lerp(left.value, right.value, alpha);
    }
    setAnimatedClipProperty(evaluated, property, value);
  }
  if (evaluated.sceneObject?.transform) {
    const transform = evaluated.sceneObject.transform;
    const position = [...(transform.position ?? [0, 0, 0])] as [number, number, number];
    position[0] += (evaluated.positionX - clip.positionX) / 100;
    position[1] -= (evaluated.positionY - clip.positionY) / 100;
    position[2] += (evaluated.positionZ - clip.positionZ) / 100;
    transform.position = position;
    const rotation = [...(transform.rotation ?? [0, 0, 0])] as [number, number, number];
    rotation[0] += THREE.MathUtils.degToRad(evaluated.rotationX - clip.rotationX);
    rotation[1] += THREE.MathUtils.degToRad(evaluated.rotationY - clip.rotationY);
    rotation[2] -= THREE.MathUtils.degToRad(evaluated.rotation - clip.rotation);
    transform.rotation = rotation;
    const scale = [...(transform.scale ?? [1, 1, 1])] as [number, number, number];
    const globalRatio = evaluated.scale / Math.max(0.001, clip.scale);
    scale[0] *= globalRatio * evaluated.scaleX / Math.max(0.001, clip.scaleX);
    scale[1] *= globalRatio * evaluated.scaleY / Math.max(0.001, clip.scaleY);
    scale[2] *= globalRatio;
    transform.scale = scale;
    if (evaluated.sceneObject.material) evaluated.sceneObject.material.opacity = (evaluated.sceneObject.material.opacity ?? 1) * evaluated.opacity / Math.max(0.001, clip.opacity);
  }
  if (evaluated.sceneObject?.material) {
    for (const property of properties) {
      if (!property.startsWith("material.")) continue;
      const key = property.slice("material.".length);
      const value = (evaluated.sceneObject.material as unknown as Record<string, unknown>)[key];
      if (value === undefined) {
        const source = (clip.sceneObject?.material as unknown as Record<string, unknown> | undefined)?.[key];
        if (typeof source === "number") (evaluated.sceneObject.material as unknown as Record<string, number>)[key] = source;
      }
    }
    evaluated.sceneObject.material.effects = structuredClone(evaluated.effects);
  }
  if (evaluated.sceneObject?.geometry) {
    const geometry = evaluated.sceneObject.geometry;
    if (properties.has("fontSize")) geometry.size = animatedNumber(evaluated, "fontSize", geometry.size ?? 1.2);
    if (properties.has("textDepth")) geometry.depth = animatedNumber(evaluated, "textDepth", geometry.depth ?? 0.12);
    if (properties.has("textOutlineWidth") && evaluated.sceneObject.material) evaluated.sceneObject.material.outlineWidth = animatedNumber(evaluated, "textOutlineWidth", evaluated.sceneObject.material.outlineWidth ?? 0.02);
  }
  if (evaluated.sceneObject && (properties.has("instanceCount") || properties.has("instanceSpacing"))) {
    const count = Math.max(1, Math.min(1_000, Math.floor(evaluated.instanceCount)));
    evaluated.sceneObject.instances = count > 1 ? Array.from({ length: count }, (_, index) => ({
      position: [(index - (count - 1) / 2) * evaluated.instanceSpacing, 0, 0] as [number, number, number],
    })) : undefined;
  }
  return evaluated;
}

function setAnimatedClipProperty(clip: RenderClip & Record<string, unknown>, property: string, value: number) {
  if (property.startsWith("material.")) {
    const key = property.slice("material.".length);
    const material = clip.sceneObject?.material as unknown as Record<string, number> | undefined;
    if (material) material[key] = value;
    return;
  }
  if (property.startsWith("particleSystem.")) {
    const key = property.slice("particleSystem.".length);
    if (clip.particleSystem) (clip.particleSystem as unknown as Record<string, number>)[key] = value;
    return;
  }
  if (property.startsWith("effect.")) {
    const [, effectId, key] = property.split(".");
    const effect = clip.effects.find((item) => item.id === effectId);
    if (effect && key) effect.params[key] = value;
    return;
  }
  if (property.startsWith("mask.")) {
    const [, maskId, key] = property.split(".");
    const mask = clip.masks.find((item) => item.id === maskId);
    if (mask && key) (mask as unknown as Record<string, number>)[key] = value;
    return;
  }
  clip[property] = value;
}

function animatedNumber(value: object, property: string, fallback: number) {
  const result = (value as Record<string, unknown>)[property];
  return typeof result === "number" ? result : fallback;
}

function cubicBezierAt(easing: ClipKeyframe["easing"], x: number) {
  const { x1, y1, x2, y2 } = easing ?? { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
  let t = x;
  for (let index = 0; index < 6; index++) {
    const inverse = 1 - t;
    const estimate = 3 * inverse * inverse * t * x1 + 3 * inverse * t * t * x2 + t * t * t;
    const derivative = 3 * inverse * inverse * x1 + 6 * inverse * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(derivative) < 0.000001) break;
    t = THREE.MathUtils.clamp(t - (estimate - x) / derivative, 0, 1);
  }
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * y1 + 3 * inverse * t * t * y2 + t * t * t;
}

function evaluateSceneSettingsAtTime(settings: SceneSettings, time: number) {
  if (!settings.keyframes?.length) return settings;
  const evaluated = structuredClone(settings);
  const properties = new Set(settings.keyframes.map((keyframe) => keyframe.property));
  for (const property of properties) {
    const keys = settings.keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
    const left = [...keys].reverse().find((keyframe) => keyframe.time <= time) ?? keys[0];
    const right = keys.find((keyframe) => keyframe.time >= time) ?? keys.at(-1)!;
    let value = left.value;
    if (right !== left && left.interpolation !== "step") {
      let alpha = THREE.MathUtils.clamp((time - left.time) / Math.max(0.000001, right.time - left.time), 0, 1);
      if (left.interpolation === "smooth") alpha = alpha * alpha * (3 - 2 * alpha);
      else if (left.interpolation === "bezier") alpha = cubicBezierAt(left.easing, alpha);
      value = THREE.MathUtils.lerp(left.value, right.value, alpha);
    }
    setAnimatedSceneProperty(evaluated, property, value);
  }
  return evaluated;
}

function setAnimatedSceneProperty(settings: SceneSettings, property: string, value: number) {
  if (property.startsWith("light:")) {
    const [, id, field, axis] = property.split(":");
    const light = settings.lights.find((item) => item.id === id);
    if (!light || !field) return;
    const current = (light as unknown as Record<string, unknown>)[field];
    if (Array.isArray(current) && axis !== undefined) current[Number(axis)] = value;
    else (light as unknown as Record<string, unknown>)[field] = value;
    return;
  }
  const [section, field, axis] = property.split(".");
  const target = (settings as unknown as Record<string, unknown>)[section] as Record<string, unknown> | undefined;
  if (!target || !field) return;
  const current = target[field];
  if (Array.isArray(current) && axis !== undefined) current[Number(axis)] = value;
  else target[field] = value;
}

function applyExportFrameSettings(renderer: THREE.WebGPURenderer, camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, settings: SceneSettings, width: number, height: number) {
  renderer.setClearColor(settings.background.color, settings.renderer.transparentBackground ? settings.background.alpha : 1);
  renderer.toneMapping = toneMappingFrom(settings.renderer.toneMapping);
  renderer.toneMappingExposure = Math.max(0, settings.renderer.exposure);
  renderer.shadowMap.enabled = settings.renderer.shadows;
  renderer.shadowMap.type = shadowTypeFrom(settings.renderer.shadowType);
  camera.position.set(...settings.camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(...settings.camera.target);
  camera.near = Math.max(0.0001, settings.camera.near);
  camera.far = Math.max(camera.near + 0.001, settings.camera.far);
  camera.zoom = Math.max(0.001, settings.camera.zoom);
  if (camera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(0.001, settings.camera.orthographicHeight) / 2;
    const aspect = Math.max(1, width) / Math.max(1, height);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
  } else if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = Math.max(1, width) / Math.max(1, height);
    camera.fov = THREE.MathUtils.clamp(settings.camera.fov, 1, 179);
  }
  camera.updateProjectionMatrix();
}

async function renderRealtime(time: number, _shouldCache: boolean, clips: RenderClip[] = []) {
  if (!graphics) return 0;
  clips = evaluateClipsAtTime(clips, time);
  if (cachedPreviewSurface) cachedPreviewSurface.mesh.visible = false;
  updateTimelineSceneObjects(time, clips);
  updateImageSurfaces(time, clips);
  updateModelSurfaces(time, clips);
  updateParticleSurfaces(time, clips);
  const { retiredFrames, readyClipIds, samplesToClose } = await updateVideoSurfaces(time, clips);
  const renderStartedAt = performance.now();
  graphics.render();
  const renderedAt = performance.now();
  retiredFrames.forEach((frame) => frame.close());
  samplesToClose.forEach((sample) => sample?.close());
  for (const ready of readyClipIds) {
    reportedVideoClips.add(ready.clipId);
    send({ type: "video-frame-ready", ...ready });
  }
  return renderedAt - renderStartedAt;
}

async function render(time: number, shouldCache: boolean, mode: "realtime" | "playback", fps: number) {
  const clips = [...renderTimeline.values()];
  lastTimelineTime = time;
  previewFps = Math.max(1, Math.min(120, fps));
  playbackActive = mode === "playback";
  if (mode === "playback" && ramPreviewEnabled && await renderCachedPreview(time, previewFps)) return;
  if (sceneSettings.keyframes?.length) graphics?.applySettings(evaluateSceneSettingsAtTime(sceneSettings, time));
  const frameMs = await renderRealtime(time, false, clips);
  // Populate the RAM cache from the frame already on screen. The old prefetcher
  // rendered a future frame and then rendered the current frame again, doubling
  // GPU work and video seeks precisely while the user was interacting.
  if (ramPreviewEnabled && shouldCache && !playbackActive && canvas) encodePreviewFrame(canvas, time, previewFps);
  const statsTime = performance.now();
  if (graphics && statsTime - lastRendererStatsAt >= 500) {
    lastRendererStatsAt = statsTime;
    send({ type: "renderer-stats", stats: { ...graphics.rendererInfo, frameMs } });
  }
  send({ type: "preview-source", source: "realtime", frame: Number(previewFrameKey(time, previewFps)) });
}

async function inspectMedia(message: Extract<EngineRequest, { type: "inspect-media" }>) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(message.file, { maxCacheSize: 2 * 1024 * 1024 }),
  });
  let retainInput = false;
  try {
    if (!(await input.canRead())) throw new Error("未対応のメディア形式です");
    const [durationFromMetadata, video, audio] = await Promise.all([
      input.getDurationFromMetadata(),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    const duration = durationFromMetadata ?? await input.computeDuration();
    const codec = video ? await video.getCodec() : audio ? await audio.getCodec() : undefined;
    const [mediaWidth, mediaHeight] = video
      ? await Promise.all([video.getDisplayWidth(), video.getDisplayHeight()])
      : [undefined, undefined];
    if (video || audio) {
      const previous = mediaRuntimes.get(message.assetId);
      previous?.input.dispose();
      mediaRuntimes.set(message.assetId, {
        input,
        videoSink: video ? new VideoSampleSink(video) : undefined,
        audioSink: audio ? new AudioSampleSink(audio) : undefined,
        duration,
      });
      retainInput = true;
    }
    send({ type: "media-info", requestId: message.requestId, duration, width: mediaWidth, height: mediaHeight, codec: codec ?? undefined, hasAudio: Boolean(audio) });
  } finally {
    if (!retainInput) input.dispose();
  }
}

async function decodeAudioPreview(message: Extract<EngineRequest, { type: "decode-audio-preview" }>) {
  const sink = mediaRuntimes.get(message.assetId)?.audioSink;
  if (!sink) throw new Error("このメディアに再生可能な音声トラックがありません");
  const chunks: Array<{ timestamp: number; duration: number; sampleRate: number; channels: ArrayBuffer[] }> = [];
  const transfers: ArrayBuffer[] = [];
  for await (const sample of sink.samples(message.startTime, message.endTime)) {
    const channels: ArrayBuffer[] = [];
    for (let planeIndex = 0; planeIndex < sample.numberOfChannels; planeIndex++) {
      const buffer = new ArrayBuffer(sample.allocationSize({ planeIndex, format: "f32-planar" }));
      sample.copyTo(buffer, { planeIndex, format: "f32-planar" });
      channels.push(buffer);
      transfers.push(buffer);
    }
    chunks.push({ timestamp: sample.timestamp, duration: sample.duration, sampleRate: sample.sampleRate, channels });
    sample.close();
  }
  send({ type: "audio-preview-data", requestId: message.requestId, chunks }, transfers);
}

async function createMediaThumbnail(message: Extract<EngineRequest, { type: "media-thumbnail" }>) {
  const image = imageRuntimes.get(message.assetId);
  if (image) {
    if (!image.bitmap) { send({ type: "media-thumbnail", requestId: message.requestId }); return; }
    const bitmap = await createImageBitmap(image.bitmap);
    send({ type: "media-thumbnail", requestId: message.requestId, bitmap }, [bitmap]);
    return;
  }
  const runtime = mediaRuntimes.get(message.assetId);
  if (!runtime) throw new Error("メディアを読み込んでからサムネイルを生成してください");
  if (runtime.videoSink) {
    const time = Math.max(0, Math.min(message.time, Math.max(0, runtime.duration - 0.001)));
    const sample = await runtime.videoSink.getSample(time);
    if (!sample) throw new Error("動画フレームを取得できませんでした");
    try {
      const frame = sample.toVideoFrame();
      try {
        const bitmap = await createImageBitmap(frame);
        send({ type: "media-thumbnail", requestId: message.requestId, bitmap }, [bitmap]);
      } finally {
        frame.close();
      }
    } finally {
      sample.close();
    }
    return;
  }
  if (runtime.audioSink) {
    const peakCount = 48;
    const timestamps = Array.from({ length: peakCount }, (_, index) => runtime.duration * (index + 0.5) / peakCount);
    const peaks: number[] = [];
    for await (const sample of runtime.audioSink.samplesAtTimestamps(timestamps)) {
      if (!sample) { peaks.push(0); continue; }
      try {
        const data = new Float32Array(sample.allocationSize({ planeIndex: 0, format: "f32-planar" }) / Float32Array.BYTES_PER_ELEMENT);
        sample.copyTo(data, { planeIndex: 0, format: "f32-planar" });
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value));
        peaks.push(peak);
      } finally {
        sample.close();
      }
    }
    if (!peaks.length) throw new Error("音声波形を取得できませんでした");
    send({ type: "media-thumbnail", requestId: message.requestId, peaks });
    return;
  }
  throw new Error("サムネイルを生成できるトラックがありません");
}

async function inspectImage(message: Extract<EngineRequest, { type: "inspect-image" }>) {
  const extension = message.file.name.split(".").pop()?.toLowerCase();
  let bitmap: ImageBitmap | undefined;
  let sourceTexture: THREE.Texture | undefined;
  if (extension === "hdr") sourceTexture = new RGBELoader().createDataTexture(await message.file.arrayBuffer());
  else if (extension === "exr") sourceTexture = new EXRLoader().createDataTexture(await message.file.arrayBuffer());
  else bitmap = await createImageBitmap(message.file, { imageOrientation: "from-image" });
  const textureImage = sourceTexture?.image as { width?: number; height?: number } | undefined;
  const width = bitmap?.width ?? textureImage?.width ?? 1;
  const height = bitmap?.height ?? textureImage?.height ?? 1;
  const previous = imageRuntimes.get(message.assetId);
  for (const [key, texture] of sharedImageTextures) if (key.startsWith(`${message.assetId}:`)) { texture.dispose(); sharedImageTextures.delete(key); }
  for (const [clipId, surface] of imageSurfaces) if (surface.assetId === message.assetId) removeImageSurface(clipId);
  previous?.bitmap?.close();
  previous?.sourceTexture?.dispose();
  imageRuntimes.set(message.assetId, { bitmap, sourceTexture, width, height });
  graphics?.applySettings(sceneSettings);
  send({ type: "media-info", requestId: message.requestId, duration: 0, width, height, codec: extension?.toUpperCase() || message.file.type || "image" });
}

async function inspectModel(message: Extract<EngineRequest, { type: "inspect-model" }>) {
  for (const [clipId, surface] of modelSurfaces) if (surface.assetId === message.assetId) removeModelSurface(clipId);
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(await message.file.arrayBuffer(), "");
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene);
  if (!bounds.isEmpty()) {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const normalization = 3 / Math.max(0.001, size.x, size.y, size.z);
    scene.position.sub(center);
    scene.scale.setScalar(normalization);
    scene.updateMatrixWorld(true);
  }
  const duration = gltf.animations.reduce((maximum, animation) => Math.max(maximum, animation.duration), 0);
  modelRuntimes.set(message.assetId, { scene, animations: gltf.animations, duration });
  send({ type: "media-info", requestId: message.requestId, duration: duration || 5, codec: "glTF 2.0" });
}

interface ExportAudioCursor {
  clip: RenderClip;
  iterator: AsyncGenerator<AudioSample, void, unknown>;
  sample: AudioSample | null;
  planes: Float32Array[];
  outputStart: number;
  outputEnd: number;
  done: boolean;
}

async function advanceExportAudioCursor(cursor: ExportAudioCursor, sourceTime: number) {
  while (!cursor.done && (!cursor.sample || sourceTime >= cursor.sample.timestamp + cursor.sample.duration)) {
    cursor.sample?.close();
    const next = await cursor.iterator.next();
    cursor.sample = next.done ? null : next.value;
    cursor.done = Boolean(next.done);
    cursor.planes = [];
    if (cursor.sample) {
      for (let channel = 0; channel < cursor.sample.numberOfChannels; channel++) {
        const plane = new Float32Array(cursor.sample.allocationSize({ planeIndex: channel, format: "f32-planar" }) / Float32Array.BYTES_PER_ELEMENT);
        cursor.sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
        cursor.planes.push(plane);
      }
    }
  }
}

async function createExportAudioCursors(message: Extract<EngineRequest, { type: "export" }>, duration: number) {
  const cursors: ExportAudioCursor[] = [];
  const exportStart = message.settings.startTime;
  const exportEnd = exportStart + duration;
  for (const clip of message.clips) {
    if (!clip.assetId) continue;
    const runtime = mediaRuntimes.get(clip.assetId);
    const sink = runtime?.audioSink;
    if (!sink) continue;
    const timelineStart = Math.max(exportStart, clip.start);
    const timelineEnd = Math.min(exportEnd, clip.start + clip.duration);
    if (timelineEnd <= timelineStart || clip.volume <= -60) continue;
    const maximumKeyedSpeed = Math.max(clip.speed, ...clip.keyframes.filter((keyframe) => keyframe.property === "speed").map((keyframe) => keyframe.value));
    const speed = Math.max(0.25, Math.min(10, maximumKeyedSpeed / 100));
    const sourceStart = Math.max(0, clip.offset);
    const sourceEnd = Math.min(runtime?.duration ?? Infinity, Math.max(sourceStart, clip.offset + (timelineEnd - clip.start) * speed));
    cursors.push({
      clip,
      iterator: sink.samples(sourceStart, sourceEnd),
      sample: null,
      planes: [],
      outputStart: timelineStart - exportStart,
      outputEnd: timelineEnd - exportStart,
      done: false,
    });
  }
  return cursors;
}

function exportHasAudio(message: Extract<EngineRequest, { type: "export" }>, duration: number) {
  const exportStart = message.settings.startTime;
  const exportEnd = exportStart + duration;
  return message.clips.some((clip) => clip.assetId
    && clip.volume > -60
    && clip.start < exportEnd
    && clip.start + clip.duration > exportStart
    && Boolean(mediaRuntimes.get(clip.assetId)?.audioSink));
}

async function encodeExportAudio(source: AudioSampleSource, message: Extract<EngineRequest, { type: "export" }>, duration: number) {
  const sampleRate = 48_000;
  const blockSize = 1024;
  const channelCount = message.audioChannels === "mono" ? 1 : 2;
  const cursors = await createExportAudioCursors(message, duration);
  try {
    for (let blockStartFrame = 0; blockStartFrame < Math.ceil(duration * sampleRate); blockStartFrame += blockSize) {
      const frames = Math.min(blockSize, Math.ceil(duration * sampleRate) - blockStartFrame);
      const mixed = new Float32Array(frames * channelCount);
      for (let frame = 0; frame < frames; frame++) {
        const outputTime = (blockStartFrame + frame) / sampleRate;
        for (const cursor of cursors) {
          if (outputTime < cursor.outputStart || outputTime >= cursor.outputEnd) continue;
          const timelineTime = message.settings.startTime + outputTime;
          const animatedClip = evaluateClipAtTime(cursor.clip, timelineTime);
          const speed = Math.max(0.25, Math.min(4, animatedClip.speed / 100));
          const sourceTime = cursor.clip.offset + (timelineTime - cursor.clip.start) * speed;
          await advanceExportAudioCursor(cursor, sourceTime);
          const sample = cursor.sample;
          if (!sample || sourceTime < sample.timestamp || sourceTime >= sample.timestamp + sample.duration || !cursor.planes.length) continue;
          const sampleFrame = Math.min(sample.numberOfFrames - 1, Math.max(0, Math.floor((sourceTime - sample.timestamp) * sample.sampleRate)));
          const monoOrLeft = cursor.planes[0]?.[sampleFrame] ?? 0;
          const right = cursor.planes[Math.min(1, cursor.planes.length - 1)]?.[sampleFrame] ?? monoOrLeft;
          const volume = animatedClip.volume <= -60 ? 0 : Math.min(4, 10 ** (animatedClip.volume / 20));
          if (channelCount === 1) {
            mixed[frame] += (monoOrLeft + right) * 0.5 * volume;
          } else {
            const pan = Math.max(-1, Math.min(1, animatedClip.pan / 100));
            const leftGain = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2 * volume;
            const rightGain = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2 * volume;
            mixed[frame * 2] += monoOrLeft * leftGain;
            mixed[frame * 2 + 1] += right * rightGain;
          }
        }
        for (let channel = 0; channel < channelCount; channel++) {
          const index = frame * channelCount + channel;
          mixed[index] = Math.max(-1, Math.min(1, mixed[index]));
        }
      }
      const sample = new AudioSample({ data: mixed, format: "f32", numberOfChannels: channelCount, sampleRate, timestamp: blockStartFrame / sampleRate });
      try { await source.add(sample); } finally { sample.close(); }
    }
  } finally {
    for (const cursor of cursors) {
      cursor.sample?.close();
      await cursor.iterator.return();
    }
    source.close();
  }
}

async function exportVideo(message: Extract<EngineRequest, { type: "export" }>) {
  if (!graphics) throw new Error("レンダーエンジンの準備が完了していません");
  const exportWidth = Math.max(2, Math.min(7680, Math.floor(message.settings.width / 2) * 2));
  const exportHeight = Math.max(2, Math.min(4320, Math.floor(message.settings.height / 2) * 2));
  const fps = Math.max(1, Math.min(120, message.settings.fps));
  const duration = Math.max(1 / fps, message.duration);
  const totalFrames = Math.ceil(duration * fps);
  const exportCanvas = new OffscreenCanvas(exportWidth, exportHeight);
  const initialSettings = evaluateSceneSettingsAtTime(message.sceneSettings, message.settings.startTime);
  graphics.applySettings(initialSettings);
  const exportRenderer = new THREE.WebGPURenderer({
    canvas: exportCanvas,
    antialias: initialSettings.renderer.antialias,
    samples: initialSettings.renderer.samples,
    alpha: initialSettings.renderer.transparentBackground,
    outputBufferType: initialSettings.renderer.outputBuffer === "float16" ? THREE.HalfFloatType : THREE.UnsignedByteType,
  });
  exportRenderer.setPixelRatio(1);
  exportRenderer.setSize(exportWidth, exportHeight, false);
  exportRenderer.outputColorSpace = THREE.SRGBColorSpace;
  await exportRenderer.init();
  const exportCamera = graphics.createCameraForSize(exportWidth, exportHeight);
  applyExportFrameSettings(exportRenderer, exportCamera, initialSettings, exportWidth, exportHeight);
  await exportRenderer.compileAsync(graphics.scene, exportCamera);
  let exportPipeline = initialSettings.renderer.postProcessing
    ? createRenderPipeline(exportRenderer, graphics.scene, exportCamera, initialSettings)
    : null;
  let pipelineSignature = JSON.stringify([initialSettings.renderer.postProcessing, initialSettings.renderer.fxaa, initialSettings.renderer.bloomStrength, initialSettings.renderer.bloomRadius, initialSettings.renderer.bloomThreshold]);

  const target = new BufferTarget();
  const format = message.settings.format === "mp4"
    ? new Mp4OutputFormat({ fastStart: "in-memory" })
    : new WebMOutputFormat();
  const output = new Output({ format, target });
  const source = new CanvasSource(exportCanvas, {
    codec: message.settings.videoCodec,
    bitrate: Math.max(250_000, Math.min(100_000_000, message.settings.bitrate)),
    keyFrameInterval: 2,
    hardwareAcceleration: "no-preference",
  });
  output.addVideoTrack(source, { maximumPacketCount: totalFrames });
  const audioSource = message.settings.audioCodec === "none" || !exportHasAudio(message, duration) ? null : new AudioSampleSource({
    codec: message.settings.audioCodec,
    bitrate: Math.max(32_000, Math.min(512_000, message.settings.audioBitrate)),
    transform: { numberOfChannels: message.audioChannels === "mono" ? 1 : 2, sampleRate: 48_000 },
  });
  if (audioSource) output.addAudioTrack(audioSource);

  try {
    await output.start();
    const audioPromise = audioSource ? encodeExportAudio(audioSource, message, duration) : null;
    const frameDuration = 1 / fps;
    for (let frame = 0; frame < totalFrames; frame++) {
      const time = frame * frameDuration;
      const timelineTime = message.settings.startTime + time;
      const frameSettings = evaluateSceneSettingsAtTime(message.sceneSettings, timelineTime);
      graphics.applySettings(frameSettings);
      applyExportFrameSettings(exportRenderer, exportCamera, frameSettings, exportWidth, exportHeight);
      const nextPipelineSignature = JSON.stringify([frameSettings.renderer.postProcessing, frameSettings.renderer.fxaa, frameSettings.renderer.bloomStrength, frameSettings.renderer.bloomRadius, frameSettings.renderer.bloomThreshold]);
      if (nextPipelineSignature !== pipelineSignature) {
        exportPipeline?.dispose();
        exportPipeline = frameSettings.renderer.postProcessing ? createRenderPipeline(exportRenderer, graphics.scene, exportCamera, frameSettings) : null;
        pipelineSignature = nextPipelineSignature;
      }
      const frameClips = evaluateClipsAtTime(message.clips, timelineTime);
      updateTimelineSceneObjects(timelineTime, frameClips);
      updateImageSurfaces(timelineTime, frameClips);
      updateModelSurfaces(timelineTime, frameClips);
      updateParticleSurfaces(timelineTime, frameClips, exportRenderer);
      const { retiredFrames, readyClipIds, samplesToClose } = await updateVideoSurfaces(timelineTime, frameClips);
      if (exportPipeline) exportPipeline.render();
      else exportRenderer.render(graphics.scene, exportCamera);
      retiredFrames.forEach((retired) => retired.close());
      samplesToClose.forEach((sample) => sample?.close());
      for (const ready of readyClipIds) {
        reportedVideoClips.add(ready.clipId);
        send({ type: "video-frame-ready", ...ready });
      }
      await source.add(time, frameDuration, { keyFrame: frame % Math.max(1, Math.round(fps * 2)) === 0 });
      if (frame % Math.max(1, Math.round(fps / 4)) === 0 || frame === totalFrames - 1) {
        send({ type: "export-progress", requestId: message.requestId, progress: (frame + 1) / totalFrames });
      }
    }
    source.close();
    if (audioPromise) await audioPromise;
    await output.finalize();
    if (!target.buffer) throw new Error("出力ファイルを生成できませんでした");
    const mimeType = message.settings.format === "mp4" ? "video/mp4" : "video/webm";
    const buffer = target.buffer;
    send({ type: "export-complete", requestId: message.requestId, buffer, mimeType }, [buffer]);
  } catch (error) {
    if (output.state === "started") await output.cancel();
    throw error;
  } finally {
    exportPipeline?.dispose();
    await exportRenderer.dispose();
    graphics.applySettings(sceneSettings);
    await render(lastTimelineTime, false, "realtime", previewFps);
  }
}

async function exportStill(message: Extract<EngineRequest, { type: "export-still" }>) {
  if (!graphics) throw new Error("レンダーエンジンの準備が完了していません");
  const exportWidth = Math.max(1, Math.min(7680, Math.floor(message.width)));
  const exportHeight = Math.max(1, Math.min(4320, Math.floor(message.height)));
  const exportCanvas = new OffscreenCanvas(exportWidth, exportHeight);
  const stillSettings = evaluateSceneSettingsAtTime(message.sceneSettings, message.time);
  graphics.applySettings(stillSettings);
  const renderer = new THREE.WebGPURenderer({
    canvas: exportCanvas,
    antialias: stillSettings.renderer.antialias,
    samples: stillSettings.renderer.samples,
    alpha: true,
    outputBufferType: stillSettings.renderer.outputBuffer === "float16" ? THREE.HalfFloatType : THREE.UnsignedByteType,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(exportWidth, exportHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const camera = graphics.createCameraForSize(exportWidth, exportHeight);
  applyExportFrameSettings(renderer, camera, stillSettings, exportWidth, exportHeight);
  let pipeline: ReturnType<typeof createRenderPipeline> | null = null;
  try {
    await renderer.init();
    const clips = evaluateClipsAtTime(message.clips, message.time);
    updateTimelineSceneObjects(message.time, clips);
    updateImageSurfaces(message.time, clips);
    updateModelSurfaces(message.time, clips);
    updateParticleSurfaces(message.time, clips, renderer);
    const { retiredFrames, samplesToClose } = await updateVideoSurfaces(message.time, clips);
    await renderer.compileAsync(graphics.scene, camera);
    pipeline = stillSettings.renderer.postProcessing ? createRenderPipeline(renderer, graphics.scene, camera, stillSettings) : null;
    if (pipeline) pipeline.render();
    else renderer.render(graphics.scene, camera);
    retiredFrames.forEach((frame) => frame.close());
    samplesToClose.forEach((sample) => sample?.close());
    const blob = await exportCanvas.convertToBlob({ type: "image/png" });
    const buffer = await blob.arrayBuffer();
    send({ type: "export-complete", requestId: message.requestId, buffer, mimeType: "image/png" }, [buffer]);
  } finally {
    pipeline?.dispose();
    await renderer.dispose();
    graphics.applySettings(sceneSettings);
    await render(lastTimelineTime, false, "realtime", previewFps);
  }
}

async function handleMessage(message: EngineRequest) {
  try {
    if (message.type === "init") await initialize(message);
    if (message.type === "attach-canvas") {
      await replaceCanvas(message.canvas, message.width, message.height, message.dpr);
      if (!graphics) throw new Error("Three.js scene is not initialized");
      send({ type: "ready", backend: graphics.backend, mediaBunnyReady: true, cameraProjection: sceneSettings.camera.projection });
      cacheStatus();
      await render(lastTimelineTime, true, "realtime", previewFps);
    }
    if (message.type === "resize" && graphics) {
      width = Math.max(2, Math.floor(message.width));
      height = Math.max(2, Math.floor(message.height));
      dpr = message.dpr;
      graphics.resize(width, height, dpr);
      encoder?.close();
      setupEncoder();
      cache.clear();
      cacheStatus();
      await render(lastTimelineTime, false, "realtime", previewFps);
    }
    if (message.type === "timeline-patch") {
      for (const id of message.patch.removes) renderTimeline.delete(id);
      for (const clip of message.patch.upserts) renderTimeline.set(clip.id, clip);
      cache.deleteWhere((key) => {
        const time = Number(key) / previewFps;
        return message.patch.invalidatedRanges.some((range) => time >= range.start && time <= range.end);
      });
      cacheStatus();
    }
    if (message.type === "render") {
      if (message.sceneSettings) {
        sceneSettings = structuredClone(message.sceneSettings);
        graphics?.applySettings(sceneSettings);
        cache.clear();
        cacheStatus();
      }
      await render(message.time, message.cache, message.mode, message.fps);
    }
    if (message.type === "inspect-media") await inspectMedia(message);
    if (message.type === "inspect-image") await inspectImage(message);
    if (message.type === "inspect-model") await inspectModel(message);
    if (message.type === "decode-audio-preview") await decodeAudioPreview(message);
    if (message.type === "media-thumbnail") await createMediaThumbnail(message);
    if (message.type === "export") await exportVideo(message);
    if (message.type === "export-still") await exportStill(message);
    if (message.type === "preview-cache-settings") {
      ramPreviewEnabled = message.enabled;
      cache.setMaxBytes(Math.max(1, message.maxBytes));
      if (!ramPreviewEnabled) {
        try { encoder?.close(); } catch { /* Encoder may already be closed. */ }
        encoder = null;
        resetPreviewDecoder();
        cache.clear();
        if (cachedPreviewSurface) cachedPreviewSurface.mesh.visible = false;
      } else if (!encoder) setupEncoder();
      cacheStatus();
      await render(lastTimelineTime, false, "realtime", previewFps);
    }
    if (message.type === "geometry-upsert") {
      if (!sceneCore) throw new Error("Three.js scene is not initialized");
      standaloneObjects.set(message.object.id, message.object);
      sceneCore.upsert(message.object);
      send({ type: "geometry-ready", id: message.object.id });
      graphics?.render();
    }
    if (message.type === "geometry-remove") {
      standaloneObjects.delete(message.id);
      sceneCore?.remove(message.id);
      graphics?.render();
    }
    if (message.type === "font-register") {
      await registerLocalFont(message.fontId, message.buffer);
      send({ type: "font-ready", fontId: message.fontId });
    }
    if (message.type === "pick") send({ type: "pick-result", requestId: message.requestId, clipId: pickSceneObject(message.ndcX, message.ndcY) });
    if (message.type === "clear-cache") {
      resetPreviewDecoder();
      cache.clear();
      if (cachedPreviewSurface) cachedPreviewSurface.mesh.visible = false;
      cacheStatus();
    }
  } catch (error) {
    send({ type: "error", requestId: "requestId" in message ? message.requestId : undefined, message: error instanceof Error ? error.message : "Worker処理に失敗しました" });
  } finally {
    if (message.type === "render") send({ type: "render-complete", sequence: message.sequence });
  }
}

const messageQueue: EngineRequest[] = [];
let drainingMessages = false;

async function drainMessages() {
  drainingMessages = true;
  while (messageQueue.length) await handleMessage(messageQueue.shift()!);
  drainingMessages = false;
  if (messageQueue.length) worker.setTimeout(() => { if (!drainingMessages) void drainMessages(); }, 0);
}

function enqueueMessage(message: EngineRequest) {
  if (message.type === "decode-audio-preview") {
    // Audio and video have independent MediaBunny sinks. Let audio buffering run
    // concurrently so a 750 ms audio window never blocks the visual frame queue.
    void handleMessage(message);
    return;
  }
  if (message.type === "render") {
    for (let index = messageQueue.length - 1; index >= 0; index--) {
      if (messageQueue[index].type === "render") messageQueue.splice(index, 1);
    }
    if (message.mode === "playback") messageQueue.unshift(message);
    else messageQueue.push(message);
  } else {
    messageQueue.push(message);
  }
  if (!drainingMessages) void drainMessages();
}

worker.onmessage = (event: MessageEvent<EngineRequest>) => {
  if (event.data.type !== "init") return;
  channelPort = event.data.port;
  channelPort.onmessage = (channelEvent: MessageEvent<EngineRequest>) => enqueueMessage(channelEvent.data);
  channelPort.start();
  enqueueMessage(event.data);
};
