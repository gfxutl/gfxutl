import * as THREE from "three/webgpu";
import { emissive, mrt, output, pass, renderOutput } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import type { LightSpec, SceneSettings, ToneMappingKind } from "../protocol/engine-protocol";

type RendererCallbacks = {
  onError?: (message: string) => void;
  onDeviceLost?: (message: string) => void;
  resolveTexture?: (assetId: string, usage: "background" | "environment") => THREE.Texture | undefined;
};

/** Owns renderer, camera, lighting and output color configuration. */
export class ThreeRendererCore {
  renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  private orthographicCamera = new THREE.OrthographicCamera();
  private perspectiveCamera = new THREE.PerspectiveCamera();
  private activeCamera: THREE.OrthographicCamera | THREE.PerspectiveCamera = this.orthographicCamera;
  private lights = new Map<string, THREE.Light>();
  private renderPipeline: THREE.RenderPipeline | null = null;
  private renderPipelineSignature = "";
  private disposing = false;
  private settings: SceneSettings;
  private callbacks: RendererCallbacks;
  private width = 16;
  private height = 9;
  private dpr = 1;

  private constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, settings: SceneSettings, callbacks: RendererCallbacks) {
    this.renderer = renderer;
    this.scene = scene;
    this.settings = structuredClone(settings);
    this.callbacks = callbacks;
  }

  static async create(canvas: OffscreenCanvas, width: number, height: number, dpr: number, settings: SceneSettings, callbacks: RendererCallbacks = {}) {
    const options = rendererOptions(canvas, settings);
    let renderer = new THREE.WebGPURenderer(options);
    const scene = new THREE.Scene();
    const core = new ThreeRendererCore(renderer, scene, settings, callbacks);
    core.attachDiagnostics(callbacks);
    core.applySettings(settings);
    core.resize(width, height, dpr);
    try {
      await renderer.init();
    } catch (webGPUError) {
      core.disposing = true;
      await renderer.dispose();
      core.disposing = false;
      renderer = new THREE.WebGPURenderer({ ...options, forceWebGL: true });
      core.renderer = renderer;
      core.attachDiagnostics(callbacks);
      core.applyRendererSettings(settings);
      core.resize(width, height, dpr);
      try {
        await renderer.init();
      } catch {
        throw webGPUError;
      }
    }
    // Shader warm-up must not delay the worker's ready handshake. The first
    // requested frame can render while compilation completes in the backend.
    setTimeout(() => {
      void renderer.compileAsync(core.scene, core.camera).catch((error) => callbacks.onError?.(`Shader compile: ${String(error)}`));
    }, 0);
    return core;
  }

  get camera() { return this.activeCamera; }

  get backend(): "webgpu" | "webgl2" {
    const backend = this.renderer.backend as THREE.WebGPURenderer["backend"] & { isWebGPUBackend?: boolean };
    return backend.isWebGPUBackend === true ? "webgpu" : "webgl2";
  }

  get rendererInfo() {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  resize(width: number, height: number, dpr: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    const previewScale = THREE.MathUtils.clamp(this.settings.renderer.previewScale ?? 1, 0.5, 1);
    this.renderer.setPixelRatio(Math.min(Math.max(0.5, dpr * previewScale), 1.5));
    this.renderer.setSize(this.width, this.height, false);
    this.updateCameraProjection(this.activeCamera, this.width / this.height);
  }

  createCameraForSize(width: number, height: number) {
    const camera = this.activeCamera.clone();
    this.updateCameraProjection(camera, Math.max(1, width) / Math.max(1, height));
    return camera;
  }

  applySettings(settings: SceneSettings) {
    const previousScale = this.settings.renderer.previewScale;
    this.settings = structuredClone(settings);
    this.applyRendererSettings(settings);
    this.applySceneSettings(settings);
    this.applyCameraSettings(settings);
    this.applyLights(settings.lights);
    if (previousScale !== settings.renderer.previewScale) this.resize(this.width, this.height, this.dpr);
  }

  private attachDiagnostics(callbacks: RendererCallbacks) {
    this.renderer.onError = (error) => callbacks.onError?.(String(error));
    this.renderer.onDeviceLost = () => { if (!this.disposing) callbacks.onDeviceLost?.("GPU device/context lost"); };
  }

  private applyRendererSettings(settings: SceneSettings) {
    const internal = this.renderer as THREE.WebGPURenderer & {
      _samples: number;
      _outputBufferType: number;
      _frameBufferTargets: Map<{ dispose(): void }, unknown>;
    };
    const samples = settings.renderer.antialias ? Math.max(0, Math.floor(settings.renderer.samples)) : 0;
    const outputBufferType = settings.renderer.outputBuffer === "float16" ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (internal._samples !== samples || internal._outputBufferType !== outputBufferType) {
      for (const target of internal._frameBufferTargets.keys()) target.dispose();
      internal._frameBufferTargets.clear();
      internal._samples = samples;
      internal._outputBufferType = outputBufferType;
      this.renderPipeline?.dispose();
      this.renderPipeline = null;
      this.renderPipelineSignature = "";
    }
    this.renderer.toneMapping = toneMappingFrom(settings.renderer.toneMapping);
    this.renderer.toneMappingExposure = Math.max(0, settings.renderer.exposure);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = settings.renderer.shadows;
    this.renderer.shadowMap.type = shadowTypeFrom(settings.renderer.shadowType);
    this.renderer.setClearColor(settings.background.color, settings.renderer.transparentBackground ? settings.background.alpha : 1);
  }

  private applySceneSettings(settings: SceneSettings) {
    const backgroundTexture = settings.background.backgroundAssetId ? this.callbacks.resolveTexture?.(settings.background.backgroundAssetId, "background") : undefined;
    const environmentTexture = settings.background.environmentAssetId ? this.callbacks.resolveTexture?.(settings.background.environmentAssetId, "environment") : undefined;
    this.scene.background = settings.renderer.transparentBackground ? null : backgroundTexture ?? new THREE.Color(settings.background.color);
    this.scene.environment = environmentTexture ?? null;
    this.scene.environmentIntensity = Math.max(0, settings.background.environmentIntensity ?? 1);
    this.scene.environmentRotation.set(0, THREE.MathUtils.degToRad(settings.background.environmentRotation ?? 0), 0);
    this.scene.backgroundBlurriness = THREE.MathUtils.clamp(settings.background.backgroundBlurriness ?? 0, 0, 1);
    this.scene.fog = settings.background.fogEnabled
      ? new THREE.Fog(settings.background.fogColor, settings.background.fogNear, Math.max(settings.background.fogNear + 0.001, settings.background.fogFar))
      : null;
  }

  private applyCameraSettings(settings: SceneSettings) {
    const cameraSettings = settings.camera;
    this.activeCamera = cameraSettings.projection === "perspective" ? this.perspectiveCamera : this.orthographicCamera;
    this.activeCamera.position.set(...cameraSettings.position);
    this.activeCamera.layers.enableAll();
    this.activeCamera.up.set(0, 1, 0);
    this.activeCamera.lookAt(...cameraSettings.target);
    this.updateCameraProjection(this.activeCamera, this.width / this.height);
    this.activeCamera.userData.projection = cameraSettings.projection;
  }

  private updateCameraProjection(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, aspect: number) {
    const settings = this.settings.camera;
    camera.near = Math.max(0.0001, settings.near);
    camera.far = Math.max(camera.near + 0.001, settings.far);
    camera.zoom = Math.max(0.001, settings.zoom);
    if (camera instanceof THREE.OrthographicCamera) {
      const halfHeight = Math.max(0.001, settings.orthographicHeight) / 2;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    } else {
      camera.aspect = aspect;
      camera.fov = THREE.MathUtils.clamp(settings.fov, 1, 179);
    }
    camera.updateProjectionMatrix();
  }

  private applyLights(specs: LightSpec[]) {
    const nextIds = new Set(specs.map((spec) => spec.id));
    for (const [id, light] of this.lights) {
      if (nextIds.has(id)) continue;
      light.removeFromParent();
      light.dispose();
      this.lights.delete(id);
    }
    for (const spec of specs) {
      let light = this.lights.get(spec.id);
      if (!light || lightKindOf(light) !== spec.kind) {
        if (light) { light.removeFromParent(); light.dispose(); }
        light = createLight(spec);
        light.name = `light:${spec.id}`;
        this.scene.add(light);
        this.lights.set(spec.id, light);
      }
      updateLight(light, spec, this.scene);
    }
  }

  render() {
    if (!this.settings.renderer.postProcessing) {
      this.renderPipeline?.dispose();
      this.renderPipeline = null;
      this.renderPipelineSignature = "";
      this.renderer.render(this.scene, this.activeCamera);
      return;
    }
    const signature = JSON.stringify([
      this.activeCamera.uuid,
      this.settings.renderer.fxaa,
      this.settings.renderer.bloomStrength,
      this.settings.renderer.bloomRadius,
      this.settings.renderer.bloomThreshold,
    ]);
    if (!this.renderPipeline || signature !== this.renderPipelineSignature) {
      this.renderPipeline?.dispose();
      this.renderPipeline = createRenderPipeline(this.renderer, this.scene, this.activeCamera, this.settings);
      this.renderPipelineSignature = signature;
    }
    this.renderPipeline.render();
  }

  async precompile() { await this.renderer.compileAsync(this.scene, this.activeCamera); }

  async dispose() {
    this.disposing = true;
    this.renderPipeline?.dispose();
    this.renderPipeline = null;
    for (const light of this.lights.values()) { light.removeFromParent(); light.dispose(); }
    this.lights.clear();
    await this.renderer.dispose();
    this.disposing = false;
  }
}

export function createRenderPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, settings: SceneSettings) {
  const scenePass = pass(scene, camera);
  if (settings.renderer.bloomStrength > 0) scenePass.setMRT(mrt({ output, emissive }));
  const color = scenePass.getTextureNode("output");
  let outputNode: any = color;
  if (settings.renderer.bloomStrength > 0) {
    outputNode = outputNode.add(bloom(scenePass.getTextureNode("emissive"), settings.renderer.bloomStrength, settings.renderer.bloomRadius, settings.renderer.bloomThreshold));
  }
  const pipeline = new THREE.RenderPipeline(renderer, settings.renderer.fxaa ? fxaa(renderOutput(outputNode)) : outputNode);
  if (settings.renderer.fxaa) pipeline.outputColorTransform = false;
  return pipeline;
}

function rendererOptions(canvas: OffscreenCanvas, settings: SceneSettings) {
  return {
    canvas,
    antialias: settings.renderer.antialias,
    samples: Math.max(0, Math.floor(settings.renderer.samples)),
    // Keep an alpha-capable swap chain so transparency can be toggled live.
    alpha: true,
    outputBufferType: settings.renderer.outputBuffer === "float16" ? THREE.HalfFloatType : THREE.UnsignedByteType,
  };
}

export function toneMappingFrom(kind: ToneMappingKind) {
  return ({ none: THREE.NoToneMapping, linear: THREE.LinearToneMapping, reinhard: THREE.ReinhardToneMapping, cineon: THREE.CineonToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping })[kind];
}

export function shadowTypeFrom(kind: SceneSettings["renderer"]["shadowType"]) {
  return ({ basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, pcfSoft: THREE.PCFShadowMap, vsm: THREE.VSMShadowMap })[kind];
}

function createLight(spec: LightSpec): THREE.Light {
  if (spec.kind === "ambient") return new THREE.AmbientLight(spec.color, spec.intensity);
  if (spec.kind === "hemisphere") return new THREE.HemisphereLight(spec.color, spec.groundColor ?? 0x303040, spec.intensity);
  if (spec.kind === "point") return new THREE.PointLight(spec.color, spec.intensity, spec.distance ?? 0, spec.decay ?? 2);
  if (spec.kind === "spot") return new THREE.SpotLight(spec.color, spec.intensity, spec.distance ?? 0, spec.angle ?? Math.PI / 3, spec.penumbra ?? 0, spec.decay ?? 2);
  if (spec.kind === "rectArea") return new THREE.RectAreaLight(spec.color, spec.intensity, 4, 4);
  return new THREE.DirectionalLight(spec.color, spec.intensity);
}

function lightKindOf(light: THREE.Light): LightSpec["kind"] {
  if (light instanceof THREE.AmbientLight) return "ambient";
  if (light instanceof THREE.HemisphereLight) return "hemisphere";
  if (light instanceof THREE.PointLight) return "point";
  if (light instanceof THREE.SpotLight) return "spot";
  if (light instanceof THREE.RectAreaLight) return "rectArea";
  return "directional";
}

function updateLight(light: THREE.Light, spec: LightSpec, scene: THREE.Scene) {
  light.color.setHex(spec.color);
  if (light instanceof THREE.HemisphereLight) light.groundColor.setHex(spec.groundColor ?? 0x303040);
  light.intensity = Math.max(0, spec.intensity);
  light.position.set(...spec.position);
  light.castShadow = Boolean(spec.castShadow);
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    light.distance = Math.max(0, spec.distance ?? 0);
    light.decay = Math.max(0, spec.decay ?? 2);
  }
  if (light instanceof THREE.SpotLight) {
    light.angle = THREE.MathUtils.clamp(spec.angle ?? Math.PI / 3, 0.001, Math.PI / 2);
    light.penumbra = THREE.MathUtils.clamp(spec.penumbra ?? 0, 0, 1);
  }
  if (light instanceof THREE.RectAreaLight) {
    light.width = Math.max(0.001, spec.width ?? 4);
    light.height = Math.max(0.001, spec.height ?? 4);
    light.lookAt(...(spec.target ?? [0, 0, 0]));
  }
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    light.target.position.set(...(spec.target ?? [0, 0, 0]));
    if (!light.target.parent) scene.add(light.target);
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 100;
  }
}
