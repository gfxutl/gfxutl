/// <reference lib="webworker" />

import * as THREE from "three/webgpu";
import { abs, cos, distance, float, Fn, glslFn, hue, instanceIndex, length, luminance, max, min, pow, saturation, sin, smoothstep, storage, texture as textureNode, uniform, uv, vec2, vec3, vec4, vertexIndex, wgslFn } from "three/tsl";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, VideoSampleSink, WebMOutputFormat } from "mediabunny";
import type { AudioProcessingSpec, ClipKeyframe, EngineRequest, EngineResponse, MediaFileSource, PreviewPickResult, PreviewView, RenderClip, SceneObjectSpec, SceneSettings, TimelinePatch, TimelineSnapshot, TransformHandleKind } from "../protocol/engine-protocol";
import { RamPreviewCache } from "./ram-preview-cache";
import { createRenderPipeline, shadowTypeFrom, ThreeRendererCore, toneMappingFrom } from "./three-renderer-core";
import { ThreeSceneCore } from "./three-scene-core";
import { registerLocalFont } from "./three-geometry-factory";
import { MediaBuffer } from "./media-buffer";
import { RendererPluginRuntime } from "./renderer-plugin-runtime";
import { ThreeTransformHandles } from "./three-transform-handles";

const worker = self as unknown as DedicatedWorkerGlobalScope;

function denyExternalConnections() {
  const unavailable = () => { throw new TypeError("レンダラーWorkerからの外部接続は禁止されています"); };
  Object.defineProperty(globalThis, "fetch", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () => Promise.reject(new TypeError("レンダラーWorkerからのfetchは禁止されています")),
  });
  for (const name of ["WebSocket", "EventSource", "XMLHttpRequest", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "importScripts"] as const) {
    if (name in globalThis) Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: unavailable });
  }
}

denyExternalConnections();
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
let transformHandles: ThreeTransformHandles | null = null;
let timelineParkingRoot: THREE.Group | null = null;
let transformHandleClipId: string | undefined;
let width = 1280;
let height = 720;
let dpr = 1;
let encoder: VideoEncoder | null = null;
let recoveringGraphics = false;
let previewFps = 30;
let lastTimelineTime = 0;
let previewFocusClipId: string | undefined;
let previewView: PreviewView = "camera";
let lastRendererStatsAt = -Infinity;
let playbackActive = false;
let cacheStatusTimer = 0;
let lastCacheStatus = "";
let lastMediaBufferStatus = "";
let nagaModulePromise: Promise<typeof import("../naga-wasm/pkg/naga_wasm.js")> | null = null;
let nagaWasm: ArrayBuffer | null = null;
const postProcessTime = uniform(0);
let sceneSettings: SceneSettings = {
  background: { color: 0xffffff, alpha: 1, fogEnabled: false, fogColor: 0xffffff, fogNear: 5, fogFar: 30, environmentIntensity: 1, environmentRotation: 0, backgroundBlurriness: 0 },
  camera: { id: "camera-1", name: "Camera 1", projection: "orthographic", position: [0, 0, 10], target: [0, 0, 0], near: 0.01, far: 1_000, fov: 50, zoom: 1, orthographicHeight: 9 },
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
  width?: number;
  height?: number;
  codec?: string;
  hasAudio: boolean;
}

interface VideoSurface {
  assetId: string;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
  texture: THREE.VideoFrameTexture;
  frame: VideoFrame | null;
  timestamp: number;
  requestedTime: number;
  aspect: number;
  effectSignature: string;
  cropSignature: string;
}

interface ImageRuntime {
  bitmap: ImageBitmap;
  bitmapFlipY: boolean;
  sourceTexture?: THREE.Texture;
  textures: Map<string, THREE.Texture>;
  width: number;
  height: number;
  codec: string;
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
  objects: THREE.Object3D[];
  materials: Array<THREE.Material & { color?: THREE.Color }>;
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
  cropSignature: string;
}

interface CachedPreviewSurface {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.VideoFrameTexture;
  frame: VideoFrame | null;
}

interface RenderFrameIndex {
  clips: RenderClip[];
  activeClips: RenderClip[];
  videoIds: Set<string>;
  imageIds: Set<string>;
  modelIds: Set<string>;
  particleIds: Set<string>;
  sceneObjectIds: Set<string>;
}

const mediaRuntimes = new Map<string, MediaRuntime>();
const imageRuntimes = new Map<string, ImageRuntime>();
const modelRuntimes = new Map<string, ModelRuntime>();
const videoSurfaces = new Map<string, VideoSurface>();
const imageSurfaces = new Map<string, ImageSurface>();
const modelSurfaces = new Map<string, ModelSurface>();
const particleSurfaces = new Map<string, ParticleSurface>();
/** THREE-OPT: O(1) timeline root lookup replaces recursive Scene.getObjectByName scans. */
const timelineRoots = new Map<string, THREE.Object3D>();
/** THREE-OPT: picking is high-frequency; retain Three.js math objects instead of allocating per pointer event. */
const previewRaycaster = new THREE.Raycaster();
const previewPointer = new THREE.Vector2();
/** THREE-OPT: worker rendering is serialized, so effect colors can share scratch storage. */
const modelTintScratch = new THREE.Color();
const modelEffectColorScratch = new THREE.Color();
/** THREE-OPT: keyframe grouping/sorting is immutable for the lifetime of a RenderClip snapshot. */
const clipKeyframeTrackCache = new WeakMap<RenderClip, Map<string, ClipKeyframe[]>>();
const reportedVideoClips = new Set<string>();
const sceneClipSignatures = new Map<string, SceneObjectSpec>();
const renderTimeline = new Map<string, RenderClip>();
let timelineRevision = 0;
const standaloneObjects = new Map<string, SceneObjectSpec>();
const bufferedAssets = new Map<string, { kind: "media" | "image" | "model"; source: MediaFileSource }>();
const mediaBuffer = new MediaBuffer(128 * 1024 * 1024, (assetId) => detachAssetInstances(assetId));
let reportedSceneObjectCount = -1;
let reportedImageObjectCount = -1;
let activeSceneObjectCount = 0;
let activeModelObjectCount = 0;
let activeParticleObjectCount = 0;
let cachedPreviewSurface: CachedPreviewSurface | null = null;
let previewDecoder: VideoDecoder | null = null;
let previewDecoderSize = "";
let pendingPreviewDecode: ((frame: VideoFrame | null) => void) | null = null;

function resolveImageTexture(assetId: string, usage: "color" | "data" | "normal" | "background" | "environment") {
  const runtime = imageRuntimes.get(assetId);
  if (!runtime) return undefined;
  let texture = runtime.textures.get(usage);
  if (texture) return texture;
  const preserveHdr = usage === "background" || usage === "environment";
  texture = preserveHdr && runtime.sourceTexture ? runtime.sourceTexture.clone() : new THREE.Texture(runtime.bitmap);
  if (!(preserveHdr && runtime.sourceTexture)) texture.flipY = runtime.bitmapFlipY;
  texture.colorSpace = usage === "color" || usage === "background" || usage === "environment" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (usage === "background" || usage === "environment") texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  runtime.textures.set(usage, texture);
  return texture;
}

function previewFrameKey(time: number, fps = previewFps) {
  return String(Math.max(0, Math.round(time * fps)));
}

function send(message: EngineResponse, transfer: Transferable[] = []) {
  channelPort?.postMessage(message, transfer);
}

const pluginRuntime = new RendererPluginRuntime({
  context: () => graphics ? { renderer: graphics.renderer, scene: graphics.scene, camera: graphics.camera } : undefined,
  requestRender: () => graphics?.render(),
  state: (plugin) => send({ type: "plugin-state", plugin }),
});

async function compileGlslWithNaga(source: string) {
  if (!nagaWasm) throw new Error("Naga WASMが初期化されていません");
  nagaModulePromise ??= import("../naga-wasm/pkg/naga_wasm.js");
  const naga = await nagaModulePromise;
  await naga.default(nagaWasm);
  return naga.compile_glsl_to_wgsl(source);
}

function flushCacheStatus() {
  if (cacheStatusTimer) worker.clearTimeout(cacheStatusTimer);
  cacheStatusTimer = 0;
  const signature = `${cache.usedBytes}:${cache.maxBytes}:${cache.size}`;
  if (signature === lastCacheStatus) return;
  lastCacheStatus = signature;
  send({ type: "cache", usedBytes: cache.usedBytes, maxBytes: cache.maxBytes, entries: cache.size });
}

function cacheStatus(immediate = false) {
  if (immediate) { flushCacheStatus(); return; }
  if (!cacheStatusTimer) cacheStatusTimer = worker.setTimeout(flushCacheStatus, 250);
}

async function initialize(message: Extract<EngineRequest, { type: "init" }>) {
  nagaWasm = message.nagaWasm;
  if (message.previewCache) {
    ramPreviewEnabled = message.previewCache.enabled;
    cache.setMaxBytes(Math.max(1, message.previewCache.maxBytes));
  }
  await replaceCanvas(message.canvas, message.width, message.height, message.dpr);
  if (!graphics) throw new Error("Three.js scene is not initialized");
  send({ type: "ready", backend: graphics.backend, mediaBunnyReady: true, cameraProjection: sceneSettings.camera.projection });
  cacheStatus(true);
  sendMediaBufferState();
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
  transformHandles?.dispose();
  transformHandles = null;
  timelineParkingRoot = null;
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
  transformHandles = new ThreeTransformHandles(graphics.scene);
  timelineParkingRoot = new THREE.Group();
  timelineParkingRoot.name = "editor:timeline-parking";
  timelineParkingRoot.position.set(1_000_000, 1_000_000, 1_000_000);
  timelineParkingRoot.visible = false;
  graphics.scene.add(timelineParkingRoot);
  sceneClipSignatures.clear();
  timelineRoots.clear();
  reportedSceneObjectCount = -1;
  reportedImageObjectCount = -1;
  activeSceneObjectCount = 0;
  activeModelObjectCount = 0;
  activeParticleObjectCount = 0;
  for (const object of standaloneObjects.values()) await sceneCore.upsert(object);
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
  graphics.render("camera");
  retired?.close();
  return true;
}

function removeVideoSurface(id: string) {
  const surface = videoSurfaces.get(id);
  if (!surface) return;
  if (mediaBuffer.releaseInstance(surface.assetId, `three-video-surface:${id}`)) return;
  disposeVideoSurface(id, surface);
}

function disposeVideoSurface(id: string, surface: VideoSurface) {
  surface.frame?.close();
  surface.texture.dispose();
  surface.mesh.geometry.dispose();
  surface.mesh.material.dispose();
  surface.mesh.removeFromParent();
  videoSurfaces.delete(id);
  if (timelineRoots.get(id) === surface.mesh) timelineRoots.delete(id);
}

function fittedPlaneSize(aspect: number) {
  const maxWidth = 15.4;
  const maxHeight = 8.6;
  return aspect >= maxWidth / maxHeight
    ? { width: maxWidth, height: maxWidth / aspect }
    : { width: maxHeight * aspect, height: maxHeight };
}

function visualEffectSignature(clip: RenderClip) {
  return JSON.stringify([clip.colorGrading, clip.effects.filter((effect) => effect.enabled && effect.kind !== "transform" && effect.kind !== "opacity"), clip.masks, clip.postProcess]);
}

function applyColorGrading(input: any, grading: RenderClip["colorGrading"]) {
  if (!grading.enabled) return input;
  const temperature = THREE.MathUtils.clamp(grading.temperature / 100, -1, 1);
  const tint = THREE.MathUtils.clamp(grading.tint / 100, -1, 1);
  const lift = vec3(grading.liftRed / 100 * 0.2, grading.liftGreen / 100 * 0.2, grading.liftBlue / 100 * 0.2);
  const gamma = vec3(
    1 / Math.max(0.1, 1 + grading.gammaRed / 100),
    1 / Math.max(0.1, 1 + grading.gammaGreen / 100),
    1 / Math.max(0.1, 1 + grading.gammaBlue / 100),
  );
  const gain = vec3(
    Math.max(0, 1 + grading.gainRed / 100),
    Math.max(0, 1 + grading.gainGreen / 100),
    Math.max(0, 1 + grading.gainBlue / 100),
  );
  let rgb = input
    .mul(2 ** THREE.MathUtils.clamp(grading.exposure, -10, 10))
    .mul(vec3(1 + temperature * 0.18 + tint * 0.04, 1 - tint * 0.1, 1 - temperature * 0.18 + tint * 0.04))
    .add(lift);
  rgb = pow(max(rgb, vec3(0)), gamma).mul(gain);
  rgb = rgb.sub(0.5).mul(Math.max(0, 1 + grading.contrast / 100)).add(0.5);

  const luma = luminance(rgb);
  const shadowMask = float(1).sub(smoothstep(0.05, 0.55, luma));
  const highlightMask = smoothstep(0.45, 0.95, luma);
  const blackMask = float(1).sub(smoothstep(0, 0.22, luma));
  const whiteMask = smoothstep(0.78, 1, luma);
  rgb = rgb
    .add(shadowMask.mul(grading.shadows / 100 * 0.28))
    .add(highlightMask.mul(grading.highlights / 100 * 0.28))
    .add(blackMask.mul(grading.blacks / 100 * 0.18))
    .add(whiteMask.mul(grading.whites / 100 * 0.18));

  rgb = saturation(rgb, Math.max(0, 1 + grading.saturation / 100));
  const channelMax = max(rgb.r, max(rgb.g, rgb.b));
  const channelMin = min(rgb.r, min(rgb.g, rgb.b));
  const vibrance = grading.vibrance / 100;
  rgb = saturation(rgb, max(0, float(1).add(float(vibrance).mul(float(1).sub(channelMax.sub(channelMin))))));
  rgb = hue(rgb, THREE.MathUtils.degToRad(grading.hue));
  const fade = THREE.MathUtils.clamp(grading.fade / 100, 0, 1);
  rgb = rgb.mul(1 - fade * 0.16).add(vec3(fade * 0.12));
  return max(rgb, vec3(0));
}

function createVisualMaterial(texture: THREE.Texture, clip: RenderClip) {
  let texUv: any = uv();
  for (const effect of clip.effects) {
    if (!effect.enabled || effect.kind !== "pixelate") continue;
    const cells = Math.max(1, effect.params.size ?? 8);
    texUv = texUv.mul(cells).floor().add(0.5).div(cells);
  }
  // An explicit UV node disables TextureNode's transform matrix by default.
  // Re-enable it so offset/repeat changes made by the crop action reach both
  // WebGPU and the WebGL2 fallback without rebuilding the material.
  const sampled: any = textureNode(texture, texUv);
  sampled.setUpdateMatrix(true);
  let rgb = applyColorGrading(sampled.rgb, clip.colorGrading);
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
  let outputColor: any = vec4(rgb, alpha);
  const shader = clip.postProcess;
  if (shader?.enabled && shader.compileStatus === "ready" && shader.wgsl) {
    try {
      const shaderFunction = graphics?.backend === "webgpu" ? wgslFn(shader.wgsl) : glslFn(shader.glsl);
      outputColor = shaderFunction({ color: outputColor, uv: uv(), time: postProcessTime });
    } catch (error) {
      send({ type: "error", message: `${shader.name}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const material = new THREE.MeshBasicNodeMaterial({ transparent: alphaMasked || clip.opacity < 100, depthTest: true, depthWrite: !alphaMasked && clip.opacity >= 100, toneMapped: false });
  material.userData.gfxAlphaMasked = alphaMasked;
  material.colorNode = outputColor;
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
  if (surface && surface.assetId !== clip.assetId) {
    removeVideoSurface(clip.id);
    surface = undefined;
  }
  if (!surface) {
    const assetId = clip.assetId!;
    surface = mediaBuffer.instantiateSync<VideoSurface>(assetId, `three-video-surface:${clip.id}`, () => {
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
      timelineRoots.set(clip.id, mesh);
      return { assetId, mesh, texture, frame: null, timestamp: -Infinity, requestedTime: -Infinity, aspect, effectSignature: visualEffectSignature(clip), cropSignature: "" };
    }, (value) => disposeVideoSurface(clip.id, value));
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

function applyTextureCrop(surface: VideoSurface | ImageSurface, clip: RenderClip, sourceWidth: number, sourceHeight: number) {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const left = THREE.MathUtils.clamp(clip.cropLeft, 0, width - 1);
  const right = THREE.MathUtils.clamp(clip.cropRight, 0, width - left - 1);
  const top = THREE.MathUtils.clamp(clip.cropTop, 0, height - 1);
  const bottom = THREE.MathUtils.clamp(clip.cropBottom, 0, height - top - 1);
  const signature = `${width}:${height}:${left}:${right}:${top}:${bottom}`;
  // THREE-OPT: avoid invalidating Texture.matrix on every preview frame when crop is unchanged.
  if (surface.cropSignature === signature) return;
  surface.texture.offset.set(left / width, bottom / height);
  surface.texture.repeat.set(
    Math.max(1 / width, 1 - (left + right) / width),
    Math.max(1 / height, 1 - (top + bottom) / height),
  );
  surface.cropSignature = signature;
}

async function updateVideoSurfaces(time: number, frame: RenderFrameIndex) {
  const retiredFrames: VideoFrame[] = [];
  const samplesToClose: Array<Awaited<ReturnType<VideoSampleSink["getSample"]>>> = [];
  const readyClipIds: Array<{ clipId: string; timestamp: number }> = [];
  for (const id of videoSurfaces.keys()) if (!frame.videoIds.has(id)) removeVideoSurface(id);

  // Allocate every timeline video plane and retain its first frame before the
  // playhead reaches it. Inactive planes live under the off-camera parking root.
  for (const clip of frame.clips) {
    if (!clip.assetId) continue;
    const runtime = mediaRuntimes.get(clip.assetId);
    if (!runtime?.videoSink || !runtime.width || !runtime.height) continue;
    let surface = ensureVideoSurface(clip, runtime.width / runtime.height);
    if (!surface.frame && surface.requestedTime === -Infinity) {
      const preloadTime = Math.max(0, clip.offset);
      surface.requestedTime = preloadTime;
      const sample = await runtime.videoSink.getSample(preloadTime);
      if (sample) {
        samplesToClose.push(sample);
        surface = ensureVideoSurface(clip, sample.displayWidth / sample.displayHeight);
        const videoFrame = sample.toVideoFrame();
        surface.frame = videoFrame;
        surface.timestamp = sample.timestamp;
        surface.texture.setFrame(videoFrame);
        if (!reportedVideoClips.has(clip.id)) readyClipIds.push({ clipId: clip.id, timestamp: sample.timestamp });
      }
    }
  }
  for (const surface of videoSurfaces.values()) parkTimelineRoot(surface.mesh);

  for (const clip of frame.activeClips) {
    if (!clip.assetId) continue;
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
    surface.mesh.visible = clip.visible;
    applyVisualTransform(surface.mesh, surface.mesh.material, clip);
    const frameWidth = Math.max(1, surface.frame?.displayWidth ?? 1);
    const frameHeight = Math.max(1, surface.frame?.displayHeight ?? 1);
    applyTextureCrop(surface, clip, frameWidth, frameHeight);
  }
  return { retiredFrames, readyClipIds, samplesToClose };
}

function removeImageSurface(id: string) {
  const surface = imageSurfaces.get(id);
  if (!surface) return;
  if (mediaBuffer.releaseInstance(surface.assetId, `three-image-surface:${id}`)) return;
  disposeImageSurface(id, surface);
}

function disposeImageSurface(id: string, surface: ImageSurface) {
  surface.texture.dispose();
  surface.mesh.geometry.dispose();
  surface.mesh.material.dispose();
  surface.mesh.removeFromParent();
  imageSurfaces.delete(id);
  if (timelineRoots.get(id) === surface.mesh) timelineRoots.delete(id);
}

function ensureImageSurface(clip: RenderClip, runtime: ImageRuntime) {
  let surface = imageSurfaces.get(clip.id);
  const aspect = runtime.width / runtime.height;
  if (surface && surface.assetId !== clip.assetId) {
    removeImageSurface(clip.id);
    surface = undefined;
  }
  if (!surface) {
    const assetId = clip.assetId!;
    surface = mediaBuffer.instantiateSync<ImageSurface>(assetId, `three-image-surface:${clip.id}`, () => {
      const texture = new THREE.Texture(runtime.bitmap);
      texture.flipY = runtime.bitmapFlipY;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      const material = createVisualMaterial(texture, clip);
      const fitted = fittedPlaneSize(aspect);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(fitted.width, fitted.height), material);
      mesh.name = `media:${clip.id}`;
      graphics?.scene.add(mesh);
      timelineRoots.set(clip.id, mesh);
      return { assetId, mesh, texture, aspect, effectSignature: visualEffectSignature(clip), cropSignature: "" };
    }, (value) => disposeImageSurface(clip.id, value));
    imageSurfaces.set(clip.id, surface);
  }
  refreshVisualMaterial(surface, clip);
  return surface;
}

function updateImageSurfaces(frame: RenderFrameIndex) {
  let changed = false;
  for (const id of imageSurfaces.keys()) if (!frame.imageIds.has(id)) { removeImageSurface(id); changed = true; }
  for (const clip of frame.clips) {
    if (!clip.assetId) continue;
    const runtime = imageRuntimes.get(clip.assetId);
    if (!runtime) continue;
    const existed = imageSurfaces.has(clip.id);
    ensureImageSurface(clip, runtime);
    changed ||= !existed;
  }
  for (const surface of imageSurfaces.values()) parkTimelineRoot(surface.mesh);
  let activeCount = 0;
  for (const clip of frame.activeClips) {
    if (!clip.assetId) continue;
    const runtime = imageRuntimes.get(clip.assetId);
    if (!runtime) continue;
    const surface = ensureImageSurface(clip, runtime);
    surface.mesh.visible = clip.visible;
    applyVisualTransform(surface.mesh, surface.mesh.material, clip);
    applyTextureCrop(surface, clip, runtime.width, runtime.height);
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
  if (mediaBuffer.releaseInstance(surface.assetId, `three-model-surface:${id}`)) return;
  disposeModelSurface(id, surface);
}

function disposeModelSurface(id: string, surface: ModelSurface) {
  surface.mixer?.stopAllAction();
  surface.materials.forEach((material) => material.dispose());
  surface.root.removeFromParent();
  modelSurfaces.delete(id);
  if (timelineRoots.get(id) === surface.root) timelineRoots.delete(id);
}

function ensureModelSurface(clip: RenderClip, runtime: ModelRuntime) {
  let surface = modelSurfaces.get(clip.id);
  if (surface && surface.assetId !== clip.assetId) {
    removeModelSurface(clip.id);
    surface = undefined;
  }
  if (surface) return surface;
  const assetId = clip.assetId!;
  surface = mediaBuffer.instantiateSync<ModelSurface>(assetId, `three-model-surface:${clip.id}`, () => {
    const model = cloneSkinned(runtime.scene) as THREE.Group;
    const objects: THREE.Object3D[] = [];
    const materials: Array<THREE.Material & { color?: THREE.Color }> = [];
    // THREE-OPT: flatten the cloned model once; frame updates no longer traverse its scene graph.
    model.traverse((object) => {
      objects.push(object);
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((material) => material.clone());
      else mesh.material = mesh.material.clone();
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      meshMaterials.forEach((material) => {
        material.userData.gfxBaseOpacity = material.opacity;
        const color = (material as THREE.Material & { color?: THREE.Color }).color;
        if (color) material.userData.gfxBaseColor = color.getHex();
        materials.push(material as THREE.Material & { color?: THREE.Color });
      });
    });
    const root = new THREE.Group();
    root.name = `timeline:${clip.id}`;
    root.add(model);
    graphics?.scene.add(root);
    timelineRoots.set(clip.id, root);
    const mixer = runtime.animations.length ? new THREE.AnimationMixer(model) : undefined;
    runtime.animations.forEach((animation) => mixer?.clipAction(animation).play());
    return { assetId, root, mixer, duration: runtime.duration, objects, materials };
  }, (value) => disposeModelSurface(clip.id, value));
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
  const tint = modelTintScratch.setRGB(1, 1, 1);
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
    else if (effect.kind === "tint") tint.multiply(modelEffectColorScratch.setRGB((effect.params.red ?? 100) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 100) / 100));
  }
  surface.root.position.set(positionX, positionY, clip.positionZ / 100);
  surface.root.rotation.set(THREE.MathUtils.degToRad(clip.rotationX), THREE.MathUtils.degToRad(clip.rotationY), rotationZ);
  surface.root.scale.set(Math.max(0.001, scaleX), Math.max(0.001, scaleY), Math.max(0.001, clip.scale / 100));
  surface.root.renderOrder = clip.renderOrder;
  surface.root.layers.set(THREE.MathUtils.clamp(clip.layer, 0, 31));
  // THREE-OPT: operate on the flat Object3D/material arrays captured at instantiation.
  for (const object of surface.objects) object.renderOrder = clip.renderOrder;
  for (const material of surface.materials) {
    material.opacity = THREE.MathUtils.clamp((material.userData.gfxBaseOpacity ?? 1) * opacity, 0, 1);
    material.transparent = material.opacity < 1;
    if (material.color && material.userData.gfxBaseColor !== undefined) material.color.setHex(material.userData.gfxBaseColor).multiply(tint).offsetHSL(0, 0, brightness);
  }
}

function updateModelSurfaces(time: number, frame: RenderFrameIndex) {
  for (const id of modelSurfaces.keys()) if (!frame.modelIds.has(id)) removeModelSurface(id);
  for (const clip of frame.clips) {
    if (!clip.assetId) continue;
    const runtime = modelRuntimes.get(clip.assetId);
    if (runtime) ensureModelSurface(clip, runtime);
  }
  for (const surface of modelSurfaces.values()) parkTimelineRoot(surface.root);
  let active = 0;
  for (const clip of frame.activeClips) {
    if (!clip.assetId) continue;
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
  activeModelObjectCount = active;
}

function parkTimelineRoot(root: THREE.Object3D) {
  root.visible = false;
  if (timelineParkingRoot && root.parent !== timelineParkingRoot) timelineParkingRoot.add(root);
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
  if (timelineRoots.get(id) === surface.root) timelineRoots.delete(id);
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
  timelineRoots.set(clip.id, root);
  surface = { root, material, signature, gpu, positions, timeNode, computeNode };
  particleSurfaces.set(clip.id, surface);
  return surface;
}

function updateParticleSurfaces(time: number, frame: RenderFrameIndex, renderer = graphics?.renderer) {
  if (!renderer) return;
  for (const id of particleSurfaces.keys()) if (!frame.particleIds.has(id)) removeParticleSurface(id);
  for (const clip of frame.clips) if (clip.particleSystem) ensureParticleSurface(clip, renderer);
  for (const surface of particleSurfaces.values()) parkTimelineRoot(surface.root);
  let active = 0;
  for (const clip of frame.activeClips) {
    const spec = clip.particleSystem;
    if (!spec) continue;
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
    active++;
  }
  activeParticleObjectCount = active;
}

async function updateTimelineSceneObjects(frame: RenderFrameIndex) {
  if (!sceneCore) return false;
  let changed = false;
  for (const id of sceneClipSignatures.keys()) {
    if (!frame.sceneObjectIds.has(id)) {
      const root = sceneCore.getObject(id);
      sceneCore.remove(id);
      if (root) unregisterTimelineRoot(root);
      sceneClipSignatures.delete(id);
      changed = true;
    }
  }
  for (const clip of frame.clips) {
    const object = clip.sceneObject;
    if (!object) continue;
    if (sceneClipSignatures.get(object.id) !== object) {
      const root = await sceneCore.upsert(object);
      timelineRoots.set(clip.id, root);
      sceneClipSignatures.set(object.id, object);
      send({ type: "geometry-ready", id: object.id });
      changed = true;
    }
  }
  for (const objectId of sceneClipSignatures.keys()) {
    const root = sceneCore.getObject(objectId);
    if (root) parkTimelineRoot(root);
  }
  activeSceneObjectCount = 0;
  for (const clip of frame.activeClips) {
    if (!clip.sceneObject) continue;
    const root = sceneCore.getObject(clip.sceneObject.id);
    if (!root) continue;
    root.visible = clip.sceneObject.visible ?? true;
    activeSceneObjectCount++;
  }
  return changed;
}

function reportActiveSceneObjectCount() {
  const total = activeSceneObjectCount + activeModelObjectCount + activeParticleObjectCount;
  if (reportedSceneObjectCount !== total) {
    reportedSceneObjectCount = total;
    send({ type: "scene-object-count", count: total });
  }
}

function pickSceneObject(ndcX: number, ndcY: number) {
  if (!graphics) return {};
  previewRaycaster.layers.enableAll();
  previewPointer.set(THREE.MathUtils.clamp(ndcX, -1, 1), THREE.MathUtils.clamp(ndcY, -1, 1));
  previewRaycaster.setFromCamera(previewPointer, graphics.previewCamera);
  const intersections = previewRaycaster.intersectObjects(graphics.scene.children, true)
    .filter((hit) => hit.object.visible && worldVisible(hit.object) && hit.object !== cachedPreviewSurface?.mesh)
    .sort(comparePickIntersections);
  const handleHit = intersections.find((hit) => typeof hit.object.userData.gfxTransformHandleKind === "string");
  if (handleHit && transformHandleClipId) {
    return { clipId: transformHandleClipId, handle: handleHit.object.userData.gfxTransformHandleKind as TransformHandleKind } satisfies PreviewPickResult;
  }
  for (const hit of intersections) {
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      if (object.name.startsWith("media:")) return { clipId: object.name.slice("media:".length) } satisfies PreviewPickResult;
      if (object.name.startsWith("timeline:")) return { clipId: object.name.slice("timeline:".length) } satisfies PreviewPickResult;
      object = object.parent;
    }
  }
  return {};
}

const PICK_COPLANAR_EPSILON = 0.0001;

function comparePickIntersections(a: THREE.Intersection, b: THREE.Intersection) {
  const distanceDelta = a.distance - b.distance;
  // Depth testing decides which genuinely separated surface is visible. The
  // explicit render order is only authoritative for coplanar timeline planes.
  if (Math.abs(distanceDelta) > PICK_COPLANAR_EPSILON) return distanceDelta;
  return pickRenderOrder(b.object) - pickRenderOrder(a.object) || distanceDelta;
}

function unregisterTimelineRoot(root: THREE.Object3D) {
  for (const [id, candidate] of timelineRoots) if (candidate === root) timelineRoots.delete(id);
}

/** THREE-OPT: parent through indexed Object3D roots; never recursively scan the scene per frame. */
function applyTimelineHierarchy(clips: RenderClip[]) {
  if (!graphics) return;
  for (const clip of clips) {
    const root = timelineRoots.get(clip.id);
    if (!root) continue;
    const parent = clip.parentId ? timelineRoots.get(clip.parentId) : graphics.scene;
    if (parent && root.parent !== parent && canParentObject(root, parent)) parent.add(root);
  }
}

function pickRenderOrder(object: THREE.Object3D) {
  let order = object.renderOrder;
  for (let current = object.parent; current; current = current.parent) order = Math.max(order, current.renderOrder);
  return order;
}

function worldVisible(object: THREE.Object3D) {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

function evaluateClipsAtTime(clips: RenderClip[], time: number) {
  let evaluated: RenderClip[] | undefined;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    if (!clip.keyframes.length || time < clip.start || time >= clip.start + clip.duration) {
      evaluated?.push(clip);
      continue;
    }
    // THREE-OPT: preserve the original array until the first animated clip; avoid a scan + map.
    evaluated ??= clips.slice(0, index);
    evaluated.push(evaluateClipAtTime(clip, time));
  }
  return evaluated ?? clips;
}

function keyframeTracksFor(clip: RenderClip) {
  let tracks = clipKeyframeTrackCache.get(clip);
  if (tracks) return tracks;
  tracks = new Map<string, ClipKeyframe[]>();
  for (const keyframe of clip.keyframes) {
    const track = tracks.get(keyframe.property);
    if (track) track.push(keyframe);
    else tracks.set(keyframe.property, [keyframe]);
  }
  for (const track of tracks.values()) track.sort((a, b) => a.time - b.time);
  clipKeyframeTrackCache.set(clip, tracks);
  return tracks;
}

function evaluateClipAtTime(clip: RenderClip, timelineTime: number) {
  if (!clip.keyframes.length) return clip;
  const evaluated = {
    ...clip,
    colorGrading: { ...clip.colorGrading },
    effects: structuredClone(clip.effects),
    masks: structuredClone(clip.masks),
    particleSystem: clip.particleSystem ? { ...clip.particleSystem } : undefined,
    sceneObject: clip.sceneObject ? structuredClone(clip.sceneObject) : undefined,
  };
  const localTime = THREE.MathUtils.clamp(timelineTime - clip.start, 0, clip.duration);
  const properties = keyframeTracksFor(clip);
  for (const [property, keys] of properties) {
    // THREE-OPT: tracks are sorted once and searched without reverse-array allocations.
    let rightIndex = keys.findIndex((keyframe) => keyframe.time >= localTime);
    if (rightIndex < 0) rightIndex = keys.length - 1;
    const right = keys[rightIndex];
    const left = keys[Math.max(0, right.time > localTime ? rightIndex - 1 : rightIndex)];
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
    for (const property of properties.keys()) {
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
    if (properties.has("textOutlineWidth")) {
      const width = animatedNumber(evaluated, "textOutlineWidth", geometry.outlineWidth ?? evaluated.sceneObject.material?.outlineWidth ?? 0.02);
      if (geometry.kind === "text2d") geometry.outlineWidth = width;
      else if (evaluated.sceneObject.material) evaluated.sceneObject.material.outlineWidth = width;
    }
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
  if (property.startsWith("colorGrading.")) {
    const key = property.slice("colorGrading.".length);
    if (key && key !== "enabled") (clip.colorGrading as unknown as Record<string, number>)[key] = value;
    return;
  }
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

/** THREE-OPT: one frame-local index replaces five independent clip scans and Set allocations. */
function createRenderFrameIndex(clips: RenderClip[], time: number, focusClipId?: string): RenderFrameIndex {
  const activeClips: RenderClip[] = [];
  const videoIds = new Set<string>();
  const imageIds = new Set<string>();
  const modelIds = new Set<string>();
  const particleIds = new Set<string>();
  const sceneObjectIds = new Set<string>();
  for (const clip of clips) {
    if (clip.assetId && mediaRuntimes.get(clip.assetId)?.videoSink) videoIds.add(clip.id);
    if (clip.assetId && imageRuntimes.has(clip.assetId)) imageIds.add(clip.id);
    if (clip.assetId && modelRuntimes.has(clip.assetId)) modelIds.add(clip.id);
    if (clip.particleSystem) particleIds.add(clip.id);
    if (clip.sceneObject) sceneObjectIds.add(clip.sceneObject.id);
    if (focusClipId ? clip.id === focusClipId : time >= clip.start && time < clip.start + clip.duration) {
      activeClips.push(clip);
    }
  }
  return { clips, activeClips, videoIds, imageIds, modelIds, particleIds, sceneObjectIds };
}

async function preloadTimelineObjects() {
  if (!graphics) return;
  const focusedClip = previewFocusClipId ? renderTimeline.get(previewFocusClipId) : undefined;
  const preloadTime = focusedClip
    ? THREE.MathUtils.clamp(lastTimelineTime, focusedClip.start, Math.max(focusedClip.start, focusedClip.start + focusedClip.duration - 1 / previewFps))
    : lastTimelineTime;
  const clips = evaluateClipsAtTime([...renderTimeline.values()], preloadTime);
  const frame = createRenderFrameIndex(clips, preloadTime, previewFocusClipId);
  await updateTimelineSceneObjects(frame);
  updateImageSurfaces(frame);
  updateModelSurfaces(preloadTime, frame);
  updateParticleSurfaces(preloadTime, frame);
  const { retiredFrames, readyClipIds, samplesToClose } = await updateVideoSurfaces(preloadTime, frame);
  applyTimelineHierarchy(frame.activeClips);
  reportActiveSceneObjectCount();
  retiredFrames.forEach((videoFrame) => videoFrame.close());
  samplesToClose.forEach((sample) => sample?.close());
  for (const ready of readyClipIds) {
    reportedVideoClips.add(ready.clipId);
    send({ type: "video-frame-ready", ...ready });
  }
}

async function renderRealtime(time: number, _shouldCache: boolean, clips: RenderClip[] = [], focusClipId?: string) {
  if (!graphics) return { frameMs: 0, videoFramesReady: 0 };
  clips = evaluateClipsAtTime(clips, time);
  const frame = createRenderFrameIndex(clips, time, focusClipId);
  if (cachedPreviewSurface) cachedPreviewSurface.mesh.visible = false;
  await updateTimelineSceneObjects(frame);
  updateImageSurfaces(frame);
  updateModelSurfaces(time, frame);
  updateParticleSurfaces(time, frame);
  const { retiredFrames, readyClipIds, samplesToClose } = await updateVideoSurfaces(time, frame);
  applyTimelineHierarchy(frame.activeClips);
  reportActiveSceneObjectCount();
  transformHandles?.sync(
    previewView === "camera" && !playbackActive && transformHandleClipId ? timelineRoots.get(transformHandleClipId) : undefined,
    graphics.previewCamera,
    height,
  );
  await pluginRuntime.runFrame({ time, fps: previewFps, mode: playbackActive ? "playback" : "realtime" });
  const renderStartedAt = performance.now();
  graphics.render(previewView);
  const renderedAt = performance.now();
  retiredFrames.forEach((frame) => frame.close());
  samplesToClose.forEach((sample) => sample?.close());
  for (const ready of readyClipIds) {
    reportedVideoClips.add(ready.clipId);
  }
  return { frameMs: renderedAt - renderStartedAt, videoFramesReady: readyClipIds.length };
}

async function render(time: number, shouldCache: boolean, mode: "realtime" | "playback", fps: number, focusClipId = previewFocusClipId) {
  const focusedClip = focusClipId ? renderTimeline.get(focusClipId) : undefined;
  const clips = [...renderTimeline.values()];
  const renderTime = focusedClip
    ? THREE.MathUtils.clamp(time, focusedClip.start, Math.max(focusedClip.start, focusedClip.start + focusedClip.duration - 1 / Math.max(1, fps)))
    : time;
  lastTimelineTime = time;
  previewFps = Math.max(1, Math.min(120, fps));
  playbackActive = mode === "playback";
  if (playbackActive) transformHandles?.sync();
  postProcessTime.value = renderTime;
  if (previewView === "camera" && !focusClipId && mode === "playback" && ramPreviewEnabled && await renderCachedPreview(renderTime, previewFps)) {
    return { previewSource: "cache" as const };
  }
  if (sceneSettings.keyframes?.length) graphics?.applySettings(evaluateSceneSettingsAtTime(sceneSettings, renderTime));
  const { frameMs, videoFramesReady } = await renderRealtime(renderTime, false, clips, focusClipId);
  sendMediaBufferState();
  // Populate the RAM cache from the frame already on screen. The old prefetcher
  // rendered a future frame and then rendered the current frame again, doubling
  // GPU work and video seeks precisely while the user was interacting.
  if (previewView === "camera" && !focusClipId && !transformHandleClipId && ramPreviewEnabled && shouldCache && !playbackActive && canvas) encodePreviewFrame(canvas, renderTime, previewFps);
  const statsTime = performance.now();
  let rendererStats;
  if (graphics && statsTime - lastRendererStatsAt >= 500) {
    lastRendererStatsAt = statsTime;
    rendererStats = { ...graphics.rendererInfo, frameMs };
  }
  return {
    previewSource: "realtime" as const,
    ...(rendererStats ? { rendererStats } : {}),
    ...(videoFramesReady ? { videoFramesReady } : {}),
  };
}

function detachAssetInstances(assetId: string) {
  mediaRuntimes.delete(assetId);
  for (const [clipId, surface] of videoSurfaces) if (surface.assetId === assetId) removeVideoSurface(clipId);

  for (const [clipId, surface] of imageSurfaces) if (surface.assetId === assetId) removeImageSurface(clipId);
  imageRuntimes.delete(assetId);

  for (const [clipId, surface] of modelSurfaces) if (surface.assetId === assetId) removeModelSurface(clipId);
  modelRuntimes.delete(assetId);
}

function sendMediaBufferState(state = mediaBuffer.state()) {
  const signature = JSON.stringify(state);
  if (signature === lastMediaBufferStatus) return;
  lastMediaBufferStatus = signature;
  send({ type: "media-buffer-state", ...state });
}

function reconcileMediaBuffer() {
  sendMediaBufferState(mediaBuffer.reconcile());
}

async function hydrateBufferedAsset(assetId: string) {
  const registration = bufferedAssets.get(assetId);
  if (!registration) throw new Error(`メディア ${assetId} の登録情報がありません`);
  if (registration.kind === "media") await hydrateMedia(assetId);
  else if (registration.kind === "image") await hydrateImage(assetId);
  else await hydrateModel(assetId);
}

async function loadRequestedMediaBufferAsset(message: Extract<EngineRequest, { type: "media-buffer-load" }>) {
  const registration = bufferedAssets.get(message.assetId);
  if (!registration) throw new Error(`${message.source.name}: メディア登録がありません`);
  registration.source = message.source;
  await mediaBuffer.load(message.assetId, message.source, message.stream);
  await hydrateBufferedAsset(message.assetId);
  reconcileMediaBuffer();
  if (graphics) await render(lastTimelineTime, false, "realtime", previewFps);
}

async function hydrateMedia(assetId: string) {
  const runtime = await mediaBuffer.instantiate<MediaRuntime>(assetId, "mediabunny-input", async (workerSource) => {
    const input = new Input({ formats: ALL_FORMATS, source: workerSource.mediaSource });
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
      return {
        input,
        videoSink: video ? new VideoSampleSink(video) : undefined,
        audioSink: audio ? new AudioSampleSink(audio) : undefined,
        duration,
        width: mediaWidth,
        height: mediaHeight,
        codec: codec ?? undefined,
        hasAudio: Boolean(audio),
      };
    } catch (error) {
      input.dispose();
      throw error;
    }
  }, (value) => value.input.dispose());
  mediaRuntimes.set(assetId, runtime);
  return {
    duration: runtime.duration,
    width: runtime.width,
    height: runtime.height,
    codec: runtime.codec,
    hasAudio: runtime.hasAudio,
    sourceProfile: mediaBuffer.open(assetId).profile,
  };
}

async function inspectMedia(message: Extract<EngineRequest, { type: "inspect-media" }>) {
  bufferedAssets.set(message.assetId, { kind: "media", source: message.source });
  await mediaBuffer.load(message.assetId, message.source, message.stream);
  const info = await hydrateMedia(message.assetId);
  send({ type: "media-info", requestId: message.requestId, ...info });
  reconcileMediaBuffer();
}

function releaseMedia(assetId: string) {
  mediaBuffer.release(assetId);
  bufferedAssets.delete(assetId);
  sendMediaBufferState();
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
    const bitmap = await createImageBitmap(image.bitmap);
    send({ type: "media-thumbnail", requestId: message.requestId, bitmap }, [bitmap]);
    return;
  }
  const runtime = mediaRuntimes.get(message.assetId);
  if (!runtime) throw new Error("メディアを読み込んでからサムネイルを生成してください");
  if (runtime.videoSink) {
    const time = Math.max(0, Math.min(message.time, Math.max(0, runtime.duration - 0.001)));
    let sample = await runtime.videoSink.getSample(time);
    // getSample() returns null when the requested time precedes a track's first
    // presentation timestamp. This is common with MP4 edit lists and delayed
    // WebM tracks, especially for the first frame of a hover preview.
    if (!sample) {
      const samples = runtime.videoSink.samples();
      const first = await samples.next();
      sample = first.done ? null : first.value;
      await samples.return(undefined);
    }
    if (!sample) throw new Error("動画フレームを取得できませんでした");
    const frame = sample.toVideoFrame();
    try {
      try {
        send({ type: "media-thumbnail", requestId: message.requestId, frame }, [frame]);
      } catch (error) {
        frame.close();
        throw error;
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

async function encodeCanvasAsWebp(canvas: OffscreenCanvas) {
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 1.0 });
  if (blob.type !== "image/webp") throw new Error("WebPエンコーダーを利用できません");
  return createImageBitmap(blob);
}

async function transcodeRasterImageToWebp(bytes: Uint8Array<ArrayBuffer>, mimeType: string) {
  const decoded = await createImageBitmap(new Blob([bytes], { type: mimeType }), { imageOrientation: "from-image" });
  try {
    const canvas = new OffscreenCanvas(decoded.width, decoded.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像変換用のOffscreenCanvas 2Dコンテキストを作成できません");
    context.clearRect(0, 0, decoded.width, decoded.height);
    context.drawImage(decoded, 0, 0);
    return await encodeCanvasAsWebp(canvas);
  } finally {
    decoded.close();
  }
}

async function transcodeDataTextureToWebp(texture: THREE.DataTexture) {
  const image = texture.image as { data: ArrayLike<number>; width: number; height: number };
  const { data, width, height } = image;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const channels = Math.max(1, Math.floor(data.length / Math.max(1, width * height)));
  const read = (index: number) => {
    const value = Number(data[index] ?? 0);
    if (texture.type === THREE.HalfFloatType) return THREE.DataUtils.fromHalfFloat(value);
    if (texture.type === THREE.UnsignedByteType) return value / 255;
    return value;
  };
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;
    pixels[target] = linearHdrToByte(read(source));
    pixels[target + 1] = linearHdrToByte(read(source + Math.min(1, channels - 1)));
    pixels[target + 2] = linearHdrToByte(read(source + Math.min(2, channels - 1)));
    pixels[target + 3] = channels > 3 ? Math.round(THREE.MathUtils.clamp(read(source + 3), 0, 1) * 255) : 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("HDR画像変換用のOffscreenCanvas 2Dコンテキストを作成できません");
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return encodeCanvasAsWebp(canvas);
}

function linearHdrToByte(value: number) {
  const linear = Math.max(0, Number.isFinite(value) ? value : 0);
  const mapped = THREE.MathUtils.clamp(linear * (2.51 * linear + 0.03) / (linear * (2.43 * linear + 0.59) + 0.14), 0, 1);
  const srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - 0.055;
  return Math.round(THREE.MathUtils.clamp(srgb, 0, 1) * 255);
}

async function hydrateImage(assetId: string) {
  const registration = bufferedAssets.get(assetId);
  if (!registration) throw new Error("画像の登録情報がありません");
  const extension = registration.source.name.split(".").pop()?.toLowerCase();
  const runtime = await mediaBuffer.instantiate<ImageRuntime>(assetId, "three-image", async (workerSource) => {
    const bytes = workerSource.readAll();
    let bitmap: ImageBitmap;
    let bitmapFlipY = true;
    let sourceTexture: THREE.Texture | undefined;
    if (extension === "hdr" || extension === "exr") {
      sourceTexture = extension === "hdr"
        ? new RGBELoader().createDataTexture(bytes.buffer)
        : new EXRLoader().createDataTexture(bytes.buffer);
      bitmap = await transcodeDataTextureToWebp(sourceTexture as THREE.DataTexture);
      bitmapFlipY = sourceTexture.flipY;
    } else {
      bitmap = await transcodeRasterImageToWebp(bytes, registration.source.type);
    }
    const textureImage = sourceTexture?.image as { width?: number; height?: number } | undefined;
    return {
      bitmap,
      bitmapFlipY,
      sourceTexture,
      textures: new Map(),
      width: bitmap.width ?? textureImage?.width ?? 1,
      height: bitmap.height ?? textureImage?.height ?? 1,
      codec: extension?.toUpperCase() || registration.source.type || "image",
    };
  }, (value) => {
    for (const texture of value.textures.values()) texture.dispose();
    value.textures.clear();
    value.bitmap.close();
    value.sourceTexture?.dispose();
  });
  imageRuntimes.set(assetId, runtime);
  graphics?.applySettings(sceneSettings);
  return { duration: 0, width: runtime.width, height: runtime.height, codec: runtime.codec, sourceProfile: mediaBuffer.open(assetId).profile };
}

async function inspectImage(message: Extract<EngineRequest, { type: "inspect-image" }>) {
  bufferedAssets.set(message.assetId, { kind: "image", source: message.source });
  await mediaBuffer.load(message.assetId, message.source, message.stream);
  const info = await hydrateImage(message.assetId);
  send({ type: "media-info", requestId: message.requestId, ...info });
  reconcileMediaBuffer();
}

function disposeModelRuntime(runtime: ModelRuntime) {
  const textures = new Set<THREE.Texture>();
  runtime.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
  runtime.scene.clear();
}

async function hydrateModel(assetId: string) {
  const runtime = await mediaBuffer.instantiate<ModelRuntime>(assetId, "three-gltf", async (workerSource) => {
    const gltf = await new GLTFLoader().parseAsync(workerSource.readAll().buffer, "");
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
    return { scene, animations: gltf.animations, duration: gltf.animations.reduce((maximum, animation) => Math.max(maximum, animation.duration), 0) };
  }, disposeModelRuntime);
  modelRuntimes.set(assetId, runtime);
  return { duration: runtime.duration || 5, codec: "glTF 2.0", sourceProfile: mediaBuffer.open(assetId).profile };
}

async function inspectModel(message: Extract<EngineRequest, { type: "inspect-model" }>) {
  bufferedAssets.set(message.assetId, { kind: "model", source: message.source });
  await mediaBuffer.load(message.assetId, message.source, message.stream);
  const info = await hydrateModel(message.assetId);
  send({ type: "media-info", requestId: message.requestId, ...info });
  reconcileMediaBuffer();
}

interface ExportAudioCursor {
  clip: RenderClip;
  iterator: AsyncGenerator<AudioSample, void, unknown>;
  sample: AudioSample | null;
  planes: Float32Array[];
  outputStart: number;
  outputEnd: number;
  done: boolean;
  dsp?: ExportAudioDspState;
  processedLeft: number;
  processedRight: number;
}

interface ExportAudioDspState {
  spec: AudioProcessingSpec;
  delayLeft: Float32Array;
  delayRight: Float32Array;
  delayIndex: number;
  reverbLeft: Float32Array;
  reverbRight: Float32Array;
  reverbIndex: number;
  lowLeft: number;
  lowRight: number;
  highLeft: number;
  highRight: number;
  highPassLeft: number;
  highPassRight: number;
  previousLeft: number;
  previousRight: number;
  highBandLeft: number;
  highBandRight: number;
  highPassAlpha: number;
  lowPassAlpha: number;
  lowAlpha: number;
  highBandAlpha: number;
  lowGain: number;
  midGain: number;
  highGain: number;
  threshold: number;
  delayFrames: number;
  reverbFeedback: number;
  reverbMix: number;
  delayMix: number;
  dry: number;
}

const DEFAULT_AUDIO_PROCESSING: AudioProcessingSpec = {
  enabled: true, fadeIn: 0, fadeOut: 0, lowCutHz: 20, highCutHz: 20_000,
  lowShelfDb: 0, midPeakDb: 0, midFrequencyHz: 1_000, highShelfDb: 0,
  compressorThresholdDb: -24, compressorRatio: 1, compressorAttack: 0.003, compressorRelease: 0.25,
  reverbMix: 0, reverbDecay: 1.8, delayMix: 0, delayTime: 0.25, delayFeedback: 0.25,
};

function processExportAudio(cursor: ExportAudioCursor, left: number, right: number, timelineTime: number, sampleRate: number) {
  if (cursor.clip.audioProcessing?.enabled === false) { cursor.processedLeft = left; cursor.processedRight = right; return; }
  if (!cursor.dsp) {
    const spec = { ...DEFAULT_AUDIO_PROCESSING, ...cursor.clip.audioProcessing };
    const dt = 1 / sampleRate;
    const reverbMix = Math.max(0, Math.min(1, spec.reverbMix / 100));
    const delayMix = Math.max(0, Math.min(1, spec.delayMix / 100));
    cursor.dsp = {
      spec,
      delayLeft: new Float32Array(sampleRate * 2), delayRight: new Float32Array(sampleRate * 2), delayIndex: 0,
      reverbLeft: new Float32Array(Math.max(1, Math.floor(sampleRate * 0.043))),
      reverbRight: new Float32Array(Math.max(1, Math.floor(sampleRate * 0.047))), reverbIndex: 0,
      lowLeft: 0, lowRight: 0, highLeft: 0, highRight: 0, highPassLeft: 0, highPassRight: 0, previousLeft: 0, previousRight: 0, highBandLeft: 0, highBandRight: 0,
      highPassAlpha: 1 / (1 + 2 * Math.PI * Math.max(10, spec.lowCutHz) * dt),
      lowPassAlpha: 1 - Math.exp(-2 * Math.PI * Math.min(22_000, Math.max(20, spec.highCutHz)) * dt),
      lowAlpha: 1 - Math.exp(-2 * Math.PI * 250 * dt),
      highBandAlpha: 1 - Math.exp(-2 * Math.PI * Math.max(500, spec.midFrequencyHz * 2) * dt),
      lowGain: 10 ** (spec.lowShelfDb / 20), midGain: 10 ** (spec.midPeakDb / 20), highGain: 10 ** (spec.highShelfDb / 20),
      threshold: 10 ** (spec.compressorThresholdDb / 20),
      delayFrames: Math.max(1, Math.min(sampleRate * 2 - 1, Math.floor(spec.delayTime * sampleRate))),
      reverbFeedback: Math.max(0.15, Math.min(0.92, 1 - 0.12 / Math.max(0.1, spec.reverbDecay))),
      reverbMix, delayMix, dry: 1 - Math.max(reverbMix, delayMix) * 0.35,
    };
  }
  const dsp = cursor.dsp;
  const spec = dsp.spec;
  dsp.highPassLeft = dsp.highPassAlpha * (dsp.highPassLeft + left - dsp.previousLeft);
  dsp.highPassRight = dsp.highPassAlpha * (dsp.highPassRight + right - dsp.previousRight);
  dsp.previousLeft = left; dsp.previousRight = right;
  left = dsp.highPassLeft; right = dsp.highPassRight;
  dsp.highLeft += (left - dsp.highLeft) * dsp.lowPassAlpha;
  dsp.highRight += (right - dsp.highRight) * dsp.lowPassAlpha;
  left = dsp.highLeft; right = dsp.highRight;
  dsp.lowLeft += (left - dsp.lowLeft) * dsp.lowAlpha;
  dsp.lowRight += (right - dsp.lowRight) * dsp.lowAlpha;
  dsp.highBandLeft += (left - dsp.highBandLeft) * dsp.highBandAlpha;
  dsp.highBandRight += (right - dsp.highBandRight) * dsp.highBandAlpha;
  left = dsp.lowLeft * dsp.lowGain + (dsp.highBandLeft - dsp.lowLeft) * dsp.midGain + (left - dsp.highBandLeft) * dsp.highGain;
  right = dsp.lowRight * dsp.lowGain + (dsp.highBandRight - dsp.lowRight) * dsp.midGain + (right - dsp.highBandRight) * dsp.highGain;
  left = compressAudioSample(left, dsp.threshold, spec.compressorRatio);
  right = compressAudioSample(right, dsp.threshold, spec.compressorRatio);
  const delayRead = (dsp.delayIndex - dsp.delayFrames + dsp.delayLeft.length) % dsp.delayLeft.length;
  const delayedLeft = dsp.delayLeft[delayRead]; const delayedRight = dsp.delayRight[delayRead];
  dsp.delayLeft[dsp.delayIndex] = left + delayedLeft * Math.max(0, Math.min(0.92, spec.delayFeedback));
  dsp.delayRight[dsp.delayIndex] = right + delayedRight * Math.max(0, Math.min(0.92, spec.delayFeedback));
  dsp.delayIndex = (dsp.delayIndex + 1) % dsp.delayLeft.length;
  const reverbLeft = dsp.reverbLeft[dsp.reverbIndex % dsp.reverbLeft.length];
  const reverbRight = dsp.reverbRight[dsp.reverbIndex % dsp.reverbRight.length];
  dsp.reverbLeft[dsp.reverbIndex % dsp.reverbLeft.length] = left + reverbRight * dsp.reverbFeedback;
  dsp.reverbRight[dsp.reverbIndex % dsp.reverbRight.length] = right + reverbLeft * dsp.reverbFeedback;
  dsp.reverbIndex++;
  const localTime = Math.max(0, timelineTime - cursor.clip.start);
  const remaining = Math.max(0, cursor.clip.duration - localTime);
  const envelope = (spec.fadeIn > 0 ? Math.min(1, localTime / spec.fadeIn) : 1) * (spec.fadeOut > 0 ? Math.min(1, remaining / spec.fadeOut) : 1);
  cursor.processedLeft = (left * dsp.dry + delayedLeft * dsp.delayMix + reverbLeft * dsp.reverbMix) * envelope;
  cursor.processedRight = (right * dsp.dry + delayedRight * dsp.delayMix + reverbRight * dsp.reverbMix) * envelope;
}

function compressAudioSample(sample: number, threshold: number, ratio: number) {
  const amplitude = Math.abs(sample);
  if (ratio <= 1 || amplitude <= threshold) return sample;
  return Math.sign(sample) * (threshold + (amplitude - threshold) / ratio);
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
      processedLeft: 0,
      processedRight: 0,
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
          processExportAudio(cursor, monoOrLeft, right, timelineTime, sampleRate);
          const processedLeft = cursor.processedLeft;
          const processedRight = cursor.processedRight;
          const volume = animatedClip.volume <= -60 ? 0 : Math.min(4, 10 ** (animatedClip.volume / 20));
          if (channelCount === 1) {
            mixed[frame] += (processedLeft + processedRight) * 0.5 * volume;
          } else {
            const pan = Math.max(-1, Math.min(1, animatedClip.pan / 100));
            const leftGain = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2 * volume;
            const rightGain = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2 * volume;
            mixed[frame * 2] += processedLeft * leftGain;
            mixed[frame * 2 + 1] += processedRight * rightGain;
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
      postProcessTime.value = timelineTime;
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
      const frameIndex = createRenderFrameIndex(frameClips, timelineTime);
      await updateTimelineSceneObjects(frameIndex);
      updateImageSurfaces(frameIndex);
      updateModelSurfaces(timelineTime, frameIndex);
      updateParticleSurfaces(timelineTime, frameIndex, exportRenderer);
      const { retiredFrames, readyClipIds, samplesToClose } = await updateVideoSurfaces(timelineTime, frameIndex);
      applyTimelineHierarchy(frameIndex.activeClips);
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
    postProcessTime.value = message.time;
    const clips = evaluateClipsAtTime(message.clips, message.time);
    const frameIndex = createRenderFrameIndex(clips, message.time);
    await updateTimelineSceneObjects(frameIndex);
    updateImageSurfaces(frameIndex);
    updateModelSurfaces(message.time, frameIndex);
    updateParticleSurfaces(message.time, frameIndex, renderer);
    const { retiredFrames, samplesToClose } = await updateVideoSurfaces(message.time, frameIndex);
    applyTimelineHierarchy(frameIndex.activeClips);
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

function applyTimelineSnapshot(snapshot: TimelineSnapshot) {
  if (snapshot.revision <= timelineRevision) return;
  timelineRevision = snapshot.revision;
  const invalidatedRanges: Array<{ start: number; end: number }> = [];
  const next = new Map(snapshot.clips.map((clip) => [clip.id, clip]));
  for (const [id, previous] of renderTimeline) {
    const replacement = next.get(id);
    if (!replacement || JSON.stringify(previous) !== JSON.stringify(replacement)) {
      invalidatedRanges.push({ start: previous.start, end: previous.start + previous.duration });
    }
  }
  for (const clip of snapshot.clips) {
    const previous = renderTimeline.get(clip.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(clip)) {
      invalidatedRanges.push({ start: clip.start, end: clip.start + clip.duration });
    }
  }
  renderTimeline.clear();
  for (const clip of snapshot.clips) renderTimeline.set(clip.id, clip);
  invalidateTimelineRanges(invalidatedRanges);
}

function applyTimelinePatch(patch: TimelinePatch) {
  if (patch.revision <= timelineRevision) return;
  timelineRevision = patch.revision;
  const invalidatedRanges: Array<{ start: number; end: number }> = [];
  for (const id of patch.removes) {
    const previous = renderTimeline.get(id);
    if (previous) invalidatedRanges.push({ start: previous.start, end: previous.start + previous.duration });
    renderTimeline.delete(id);
  }
  for (const clip of patch.upserts) {
    const previous = renderTimeline.get(clip.id);
    if (previous) invalidatedRanges.push({ start: previous.start, end: previous.start + previous.duration });
    invalidatedRanges.push({ start: clip.start, end: clip.start + clip.duration });
    renderTimeline.set(clip.id, clip);
  }
  invalidateTimelineRanges(invalidatedRanges);
}

function invalidateTimelineRanges(ranges: Array<{ start: number; end: number }>) {
  if (!ranges.length) return;
  cache.deleteWhere((key) => {
    const time = Number(key) / previewFps;
    return ranges.some((range) => time >= range.start && time <= range.end);
  });
  cacheStatus();
}

function applySceneSettingsPatch(patch: NonNullable<Extract<EngineRequest, { type: "render" }>["sceneSettingsPatch"]>) {
  sceneSettings = {
    ...sceneSettings,
    background: { ...sceneSettings.background, ...patch.background },
    camera: { ...sceneSettings.camera, ...patch.camera },
    renderer: { ...sceneSettings.renderer, ...patch.renderer },
    lights: patch.lights ?? sceneSettings.lights,
    keyframes: patch.keyframes === null ? undefined : patch.keyframes ?? sceneSettings.keyframes,
  };
  graphics?.applySettings(sceneSettings);
  cache.clear();
  cacheStatus();
}

async function handleMessage(message: EngineRequest) {
  let renderCompletion: Omit<Extract<EngineResponse, { type: "render-complete" }>, "type" | "sequence"> | undefined;
  try {
    if (message.type === "init") await initialize(message);
    if (message.type === "attach-canvas") {
      await replaceCanvas(message.canvas, message.width, message.height, message.dpr);
      if (!graphics) throw new Error("Three.js scene is not initialized");
      send({ type: "ready", backend: graphics.backend, mediaBunnyReady: true, cameraProjection: sceneSettings.camera.projection });
      cacheStatus(true);
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
      cacheStatus(true);
      await render(lastTimelineTime, false, "realtime", previewFps);
    }
    if (message.type === "render") {
      if (message.sceneSettingsPatch) applySceneSettingsPatch(message.sceneSettingsPatch);
      previewFocusClipId = message.focusClipId;
      previewView = message.previewView;
      renderCompletion = await render(message.time, message.cache, message.mode, message.fps);
    }
    if (message.type === "timeline-sync") {
      applyTimelineSnapshot(message.snapshot);
      await preloadTimelineObjects();
    }
    if (message.type === "timeline-patch") {
      applyTimelinePatch(message.patch);
      await preloadTimelineObjects();
    }
    if (message.type === "media-buffer-plan") sendMediaBufferState(mediaBuffer.setGraph(message.graph));
    if (message.type === "media-buffer-load") await loadRequestedMediaBufferAsset(message);
    if (message.type === "inspect-media") await inspectMedia(message);
    if (message.type === "release-media") releaseMedia(message.assetId);
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
      cacheStatus(true);
      await render(lastTimelineTime, false, "realtime", previewFps);
    }
    if (message.type === "geometry-upsert") {
      if (!sceneCore) throw new Error("Three.js scene is not initialized");
      standaloneObjects.set(message.object.id, message.object);
      await sceneCore.upsert(message.object);
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
    if (message.type === "inspector-camera" && graphics) {
      graphics.moveInspectorCamera(message.operation, message.deltaX, message.deltaY);
      graphics.render("inspector");
    }
    if (message.type === "transform-handles" && graphics) {
      transformHandleClipId = message.clipId;
      transformHandles?.sync(
        message.clipId && previewView === "camera" && !playbackActive ? timelineRoots.get(message.clipId) : undefined,
        graphics.previewCamera,
        height,
      );
      graphics.render(previewView);
    }
    if (message.type === "pick") send({ type: "pick-result", requestId: message.requestId, ...pickSceneObject(message.ndcX, message.ndcY) });
    if (message.type === "compile-glsl") send({ type: "glsl-compiled", requestId: message.requestId, wgsl: await compileGlslWithNaga(message.source) });
    if (message.type === "plugin-load") {
      const plugin = await pluginRuntime.load(message.plugin);
      send({ type: "plugin-state", requestId: message.requestId, plugin });
    }
    if (message.type === "plugin-unload") await pluginRuntime.unload(message.pluginId);
    if (message.type === "clear-cache") {
      resetPreviewDecoder();
      cache.clear();
      if (cachedPreviewSurface) cachedPreviewSurface.mesh.visible = false;
      cacheStatus(true);
    }
  } catch (error) {
    send({ type: "error", requestId: "requestId" in message ? message.requestId : undefined, message: error instanceof Error ? error.message : String(error || "Worker処理に失敗しました") });
    if (message.type === "media-buffer-load" || message.type === "media-buffer-plan") sendMediaBufferState();
  } finally {
    if (message.type === "render") send({ type: "render-complete", sequence: message.sequence, ...renderCompletion });
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
    if (message.mode === "playback") {
      const index = messageQueue.findIndex((queued) => queued.type !== "media-buffer-plan"
        && queued.type !== "media-buffer-load"
        && queued.type !== "timeline-sync"
        && queued.type !== "timeline-patch");
      messageQueue.splice(index < 0 ? messageQueue.length : index, 0, message);
    } else messageQueue.push(message);
  } else if (message.type === "media-buffer-plan") {
    for (let index = messageQueue.length - 1; index >= 0; index--) {
      if (messageQueue[index].type === "media-buffer-plan") messageQueue.splice(index, 1);
    }
    messageQueue.unshift(message);
  } else if (message.type === "media-buffer-load") {
    messageQueue.unshift(message);
  } else if (message.type === "resize" || message.type === "preview-cache-settings") {
    // Drag-resizing and number inputs can outpace GPU reconfiguration. Only the
    // newest pending value is observable, so stale queued values have no value.
    for (let index = messageQueue.length - 1; index >= 0; index--) {
      if (messageQueue[index].type === message.type) messageQueue.splice(index, 1);
    }
    messageQueue.push(message);
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
