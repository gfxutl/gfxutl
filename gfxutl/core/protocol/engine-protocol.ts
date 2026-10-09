export interface ExportSettings {
  format: "mp4" | "webm";
  videoCodec: "avc" | "hevc" | "vp8" | "vp9" | "av1";
  audioCodec: "aac" | "opus" | "vorbis" | "none";
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audioBitrate: number;
  filename: string;
  startTime: number;
  endTime: number;
}

export type GeometryKind =
  | "box" | "capsule" | "circle" | "cone" | "cylinder"
  | "dodecahedron" | "icosahedron" | "octahedron" | "plane"
  | "ring" | "sphere" | "tetrahedron" | "torus" | "torusKnot"
  | "lathe" | "shape" | "extrude" | "tube" | "polyhedron"
  | "edges" | "wireframe" | "buffer" | "text";

export type MaterialKind = "basic" | "lambert" | "phong" | "standard" | "physical" | "toon" | "normal";
export type BlendMode = "normal" | "add" | "multiply" | "subtract" | "none";
export type ToneMappingKind = "none" | "linear" | "reinhard" | "cineon" | "aces" | "agx" | "neutral";
export type LightKind = "ambient" | "hemisphere" | "directional" | "point" | "spot" | "rectArea";

export interface GeometrySpec {
  id: string;
  kind: GeometryKind;
  args?: number[];
  points2D?: Array<[number, number]>;
  holes?: Array<Array<[number, number]>>;
  points3D?: Array<[number, number, number]>;
  vertices?: number[];
  indices?: number[];
  normals?: number[];
  uvs?: number[];
  uv1s?: number[];
  colors?: number[];
  tangents?: number[];
  customAttributes?: Record<string, { itemSize: number; values: number[] }>;
  groups?: Array<{ start: number; count: number; materialIndex: number }>;
  drawRange?: { start: number; count: number };
  text?: string;
  fontId?: string;
  size?: number;
  depth?: number;
  curveSegments?: number;
  bevelEnabled?: boolean;
  bevelThickness?: number;
  bevelSize?: number;
  bevelSegments?: number;
  source?: Omit<GeometrySpec, "id">;
}

export interface SceneMaterialSpec {
  kind?: MaterialKind;
  color?: number;
  emissive?: number;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  transmission?: number;
  thickness?: number;
  ior?: number;
  sheen?: number;
  shininess?: number;
  wireframe?: boolean;
  flatShading?: boolean;
  opacity?: number;
  side?: "front" | "back" | "double";
  depthTest?: boolean;
  depthWrite?: boolean;
  transparent?: boolean;
  blending?: BlendMode;
  alphaTest?: number;
  mapAssetId?: string;
  normalMapAssetId?: string;
  roughnessMapAssetId?: string;
  metalnessMapAssetId?: string;
  emissiveMapAssetId?: string;
  alphaMapAssetId?: string;
  aoMapAssetId?: string;
  effects?: ClipEffect[];
  pointSize?: number;
  sizeAttenuation?: boolean;
  outlineColor?: number;
  outlineWidth?: number;
}

export interface SceneObjectSpec {
  id: string;
  geometry: GeometrySpec;
  material?: SceneMaterialSpec;
  transform?: { position?: [number, number, number]; rotation?: [number, number, number]; quaternion?: [number, number, number, number]; scale?: [number, number, number] };
  renderOrder?: number;
  visible?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  layer?: number;
  parentId?: string;
  instances?: Array<{ position: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }>;
  primitive?: "mesh" | "points" | "line" | "sprite";
}

export type ClipEffectKind = "transform" | "brightness" | "tint" | "opacity" | "contrast" | "saturation" | "gamma" | "hue" | "chromaKey" | "vignette" | "pixelate";

export interface ClipEffect {
  id: string;
  kind: ClipEffectKind;
  name: string;
  enabled: boolean;
  params: Record<string, number>;
}

export type KeyframeProperty = "positionX" | "positionY" | "positionZ" | "scale" | "scaleX" | "scaleY" | "rotation" | "rotationX" | "rotationY" | "opacity";
export interface ClipKeyframe {
  id: string;
  property: KeyframeProperty;
  time: number;
  value: number;
  interpolation: "step" | "linear" | "smooth";
}

export interface ParticleSystemSpec {
  count: number;
  size: number;
  spread: number;
  speed: number;
  color: number;
}

export interface CameraSettings {
  projection: "orthographic" | "perspective";
  position: [number, number, number];
  target: [number, number, number];
  near: number;
  far: number;
  fov: number;
  zoom: number;
  orthographicHeight: number;
}

export interface RendererSettings {
  previewScale: number;
  toneMapping: ToneMappingKind;
  exposure: number;
  outputBuffer: "uint8" | "float16";
  antialias: boolean;
  samples: number;
  shadows: boolean;
  shadowType: "basic" | "pcf" | "pcfSoft" | "vsm";
  transparentBackground: boolean;
  postProcessing: boolean;
  fxaa: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
}

export interface BackgroundSettings {
  color: number;
  alpha: number;
  fogEnabled: boolean;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  backgroundAssetId?: string;
  environmentAssetId?: string;
  environmentIntensity: number;
  environmentRotation: number;
  backgroundBlurriness: number;
}

export interface LightSpec {
  id: string;
  kind: LightKind;
  color: number;
  groundColor?: number;
  intensity: number;
  position: [number, number, number];
  target?: [number, number, number];
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  width?: number;
  height?: number;
  castShadow?: boolean;
}

export interface SceneSettings {
  background: BackgroundSettings;
  camera: CameraSettings;
  renderer: RendererSettings;
  lights: LightSpec[];
}

export interface RendererStats {
  calls: number;
  triangles: number;
  lines: number;
  points: number;
  geometries: number;
  textures: number;
  frameMs: number;
}

export interface RenderClip {
  id: string;
  assetId?: string;
  start: number;
  duration: number;
  offset: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  rotationX: number;
  rotationY: number;
  visible: boolean;
  layer: number;
  parentId?: string;
  opacity: number;
  volume: number;
  pan: number;
  speed: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  effects: ClipEffect[];
  keyframes: ClipKeyframe[];
  particleSystem?: ParticleSystemSpec;
  sceneObject?: SceneObjectSpec;
  timelineY: number;
  renderOrder: number;
}

export interface TimelinePatch {
  revision: number;
  upserts: RenderClip[];
  removes: string[];
  invalidatedRanges: Array<{ start: number; end: number }>;
}

export type EngineRequest =
  | { type: "init"; canvas: OffscreenCanvas; port: MessagePort; width: number; height: number; dpr: number }
  | { type: "attach-canvas"; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: "resize"; width: number; height: number; dpr: number }
  | { type: "timeline-patch"; patch: TimelinePatch }
  | { type: "render"; sequence: number; time: number; cache: boolean; mode: "realtime" | "playback"; fps: number; sceneSettings?: SceneSettings }
  | { type: "inspect-media"; requestId: string; assetId: string; file: File }
  | { type: "inspect-image"; requestId: string; assetId: string; file: File }
  | { type: "inspect-model"; requestId: string; assetId: string; file: File }
  | { type: "decode-audio-preview"; requestId: string; assetId: string; startTime: number; endTime: number }
  | { type: "media-thumbnail"; requestId: string; assetId: string; time: number }
  | { type: "geometry-upsert"; object: SceneObjectSpec }
  | { type: "geometry-remove"; id: string }
  | { type: "font-register"; fontId: string; buffer: ArrayBuffer }
  | { type: "pick"; requestId: string; ndcX: number; ndcY: number }
  | { type: "export"; requestId: string; settings: ExportSettings; duration: number; clips: RenderClip[]; sceneSettings: SceneSettings }
  | { type: "clear-cache" };

export type EngineResponse =
  | { type: "ready"; backend: "webgpu" | "webgl2"; mediaBunnyReady: boolean; cameraProjection: "orthographic" | "perspective" }
  | { type: "media-info"; requestId: string; duration: number; width?: number; height?: number; codec?: string; hasAudio?: boolean }
  | { type: "audio-preview-data"; requestId: string; chunks: Array<{ timestamp: number; duration: number; sampleRate: number; channels: ArrayBuffer[] }> }
  | { type: "media-thumbnail"; requestId: string; bitmap?: ImageBitmap; peaks?: number[] }
  | { type: "export-progress"; requestId: string; progress: number }
  | { type: "export-complete"; requestId: string; buffer: ArrayBuffer; mimeType: string }
  | { type: "geometry-ready"; id: string }
  | { type: "scene-object-count"; count: number }
  | { type: "image-object-count"; count: number }
  | { type: "font-ready"; fontId: string }
  | { type: "video-frame-ready"; clipId: string; timestamp: number }
  | { type: "pick-result"; requestId: string; clipId?: string }
  | { type: "renderer-stats"; stats: RendererStats }
  | { type: "cache"; usedBytes: number; maxBytes: number; entries: number }
  | { type: "preview-source"; source: "realtime" | "cache"; frame: number }
  | { type: "render-complete"; sequence: number }
  | { type: "error"; message: string; requestId?: string };
