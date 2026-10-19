import * as THREE from "three/webgpu";
import { builtinAOContext, emissive, float, int, mrt, normalView, orthographicDepthToViewZ, output, pass, renderOutput, screenUV, velocity } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { motionBlur } from "three/addons/tsl/display/MotionBlur.js";
import type { LightSpec, PreviewView, SceneSettings, ToneMappingKind } from "../protocol/engine-protocol";
import { objectPreviewFrustum } from "../protocol/object-preview-camera";
import { nativePreviewPixelRatio } from "../protocol/preview-resolution";
import { INSPECTOR_HELPERS_LAYER, TRANSFORM_HANDLES_LAYER } from "./editor-layers";

const INSPECTOR_LAYER = INSPECTOR_HELPERS_LAYER;
const MAX_PREVIEW_MSAA_SAMPLES = 4;

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
  private objectPreviewCamera = new THREE.OrthographicCamera();
  private inspectorCamera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 10_000);
  private cameraHelper: THREE.CameraHelper | null = null;
  private readonly inspectorGrid = new THREE.GridHelper(30, 30, 0x59636c, 0x343b41);
  private readonly inspectorAxes = new THREE.AxesHelper(2);
  private readonly inspectorTarget = new THREE.Vector3();
  private inspectorCameraInitialized = false;
  private previewView: PreviewView = "camera";
  private objectPreviewActive = false;
  private lights = new Map<string, THREE.Light>();
  private renderPipeline: THREE.RenderPipeline | null = null;
  private renderPipelineSignature = "";
  private disposing = false;
  private settings: SceneSettings;
  private callbacks: RendererCallbacks;
  private width = 16;
  private height = 9;
  private dpr = 1;
  private appliedPixelRatio = 0;
  private rendererSettingsSignature = "";
  private sceneSettingsSignature = "";
  private cameraSettingsSignature = "";
  private lightsSignature = "";
  private appliedSettingsSource: SceneSettings | null = null;

  private constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, settings: SceneSettings, callbacks: RendererCallbacks) {
    this.renderer = renderer;
    this.scene = scene;
    this.settings = structuredClone(settings);
    this.callbacks = callbacks;
    this.inspectorCamera.layers.enableAll();
    this.inspectorCamera.layers.disable(TRANSFORM_HANDLES_LAYER);
    this.objectPreviewCamera.position.set(0, 0, 10);
    this.objectPreviewCamera.up.set(0, 1, 0);
    this.objectPreviewCamera.lookAt(0, 0, 0);
    this.objectPreviewCamera.layers.enableAll();
    this.objectPreviewCamera.layers.disable(INSPECTOR_LAYER);
    this.inspectorGrid.layers.set(INSPECTOR_LAYER);
    this.inspectorGrid.name = "editor:inspector-grid";
    this.inspectorAxes.layers.set(INSPECTOR_LAYER);
    this.inspectorAxes.name = "editor:inspector-axes";
    this.scene.add(this.inspectorGrid, this.inspectorAxes);
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
  get previewCamera() { return this.previewView === "inspector" ? this.inspectorCamera : this.objectPreviewActive ? this.objectPreviewCamera : this.activeCamera; }

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
    this.dpr = nativePreviewPixelRatio(dpr);
    this.applyPreviewResolution(true);
    this.updateCameraProjection(this.activeCamera, this.width / this.height);
    this.updateObjectPreviewProjection(this.width / this.height);
    this.inspectorCamera.aspect = this.width / this.height;
    this.inspectorCamera.updateProjectionMatrix();
  }

  private applyPreviewResolution(force = false) {
    const pixelRatio = this.dpr;
    if (!force && Math.abs(pixelRatio - this.appliedPixelRatio) < 0.001) return;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.appliedPixelRatio = pixelRatio;
  }

  createCameraForSize(width: number, height: number) {
    const camera = this.activeCamera.clone();
    camera.layers.disable(TRANSFORM_HANDLES_LAYER);
    this.updateCameraProjection(camera, Math.max(1, width) / Math.max(1, height));
    return camera;
  }

  setObjectPreviewActive(active: boolean) {
    this.objectPreviewActive = active;
  }

  applySettings(settings: SceneSettings) {
    if (settings === this.appliedSettingsSource) return;
    const rendererSignature = JSON.stringify(settings.renderer);
    const sceneSignature = JSON.stringify(settings.background);
    const cameraSignature = JSON.stringify(settings.camera);
    const lightsSignature = JSON.stringify(settings.lights);
    const rendererChanged = rendererSignature !== this.rendererSettingsSignature;
    const sceneChanged = sceneSignature !== this.sceneSettingsSignature;
    const cameraChanged = cameraSignature !== this.cameraSettingsSignature;
    const lightsChanged = lightsSignature !== this.lightsSignature;
    this.appliedSettingsSource = settings;
    if (!rendererChanged && !sceneChanged && !cameraChanged && !lightsChanged) return;
    this.settings = structuredClone(settings);
    if (rendererChanged) {
      this.rendererSettingsSignature = rendererSignature;
      this.applyRendererSettings(settings);
    }
    if (sceneChanged) {
      this.sceneSettingsSignature = sceneSignature;
      this.applySceneSettings(settings);
    }
    if (cameraChanged) {
      this.cameraSettingsSignature = cameraSignature;
      this.applyCameraSettings(settings);
    }
    if (lightsChanged) {
      this.lightsSignature = lightsSignature;
      this.applyLights(settings.lights);
    }
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
    const samples = settings.renderer.antialias ? THREE.MathUtils.clamp(Math.floor(settings.renderer.samples), 0, MAX_PREVIEW_MSAA_SAMPLES) : 0;
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
    this.activeCamera.layers.disable(INSPECTOR_LAYER);
    this.activeCamera.up.set(0, 1, 0);
    this.activeCamera.lookAt(...cameraSettings.target);
    this.updateCameraProjection(this.activeCamera, this.width / this.height);
    this.activeCamera.userData.projection = cameraSettings.projection;
    this.updateCameraHelper();
  }

  private updateCameraHelper() {
    if (!this.cameraHelper || this.cameraHelper.camera !== this.activeCamera) {
      this.cameraHelper?.removeFromParent();
      this.cameraHelper?.dispose();
      this.cameraHelper = new THREE.CameraHelper(this.activeCamera);
      this.cameraHelper.name = `editor:${this.settings.camera.id}`;
      this.cameraHelper.layers.set(INSPECTOR_LAYER);
      this.scene.add(this.cameraHelper);
    }
    this.activeCamera.updateMatrixWorld(true);
    this.cameraHelper.update();
  }

  private updateInspectorCamera() {
    this.updateCameraHelper();
    if (!this.inspectorCameraInitialized) this.frameInspectorCamera();
    this.inspectorCamera.lookAt(this.inspectorTarget);
    this.inspectorCamera.updateProjectionMatrix();
    this.inspectorCamera.updateMatrixWorld(true);
  }

  private frameInspectorCamera() {
    const bounds = new THREE.Box3();
    const target = new THREE.Vector3(...this.settings.camera.target);
    bounds.expandByPoint(target);
    bounds.expandByPoint(this.activeCamera.position);
    for (const child of this.scene.children) {
      if (!child.visible || child.layers.test(this.inspectorGrid.layers) || child instanceof THREE.Light) continue;
      if (child === this.activeCamera || child === this.inspectorCamera) continue;
      bounds.expandByObject(child, true);
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(4, size.length() * 0.65);
    const direction = new THREE.Vector3(1, 0.72, 1).normalize();
    this.inspectorTarget.copy(center);
    this.inspectorCamera.position.copy(center).addScaledVector(direction, radius * 2.35);
    this.inspectorCamera.near = Math.max(0.01, radius / 250);
    this.inspectorCamera.far = Math.max(1_000, radius * 12);
    this.inspectorCamera.up.set(0, 1, 0);
    this.inspectorCameraInitialized = true;
  }

  moveInspectorCamera(operation: "orbit" | "pan" | "walk", deltaX: number, deltaY: number) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.updateInspectorCamera();
    const offset = this.inspectorCamera.position.clone().sub(this.inspectorTarget);
    const distance = Math.max(0.01, offset.length());
    if (operation === "orbit") {
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= deltaX * 0.008;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - deltaY * 0.008, 0.05, Math.PI - 0.05);
      this.inspectorCamera.position.copy(this.inspectorTarget).add(offset.setFromSpherical(spherical));
    } else {
      const forward = this.inspectorTarget.clone().sub(this.inspectorCamera.position).normalize();
      const right = new THREE.Vector3().crossVectors(forward, this.inspectorCamera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();
      const worldUnitsPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.inspectorCamera.fov / 2)) / Math.max(1, this.height);
      const translation = operation === "pan"
        ? right.multiplyScalar(-deltaX * worldUnitsPerPixel).addScaledVector(up, deltaY * worldUnitsPerPixel)
        : right.multiplyScalar(-deltaX * worldUnitsPerPixel).addScaledVector(forward, -deltaY * worldUnitsPerPixel);
      this.inspectorTarget.add(translation);
      this.inspectorCamera.position.add(translation);
    }
    this.inspectorCamera.lookAt(this.inspectorTarget);
    this.inspectorCamera.updateMatrixWorld(true);
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

  private updateObjectPreviewProjection(aspect: number) {
    const bounds = objectPreviewFrustum(aspect);
    this.objectPreviewCamera.left = bounds.left;
    this.objectPreviewCamera.right = bounds.right;
    this.objectPreviewCamera.top = bounds.top;
    this.objectPreviewCamera.bottom = bounds.bottom;
    this.objectPreviewCamera.near = 0.01;
    this.objectPreviewCamera.far = 10_000;
    this.objectPreviewCamera.zoom = 1;
    this.objectPreviewCamera.updateProjectionMatrix();
    this.objectPreviewCamera.updateMatrixWorld(true);
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

  render(view: PreviewView = this.previewView) {
    this.previewView = view;
    this.applyPreviewResolution();
    if (view === "inspector") {
      this.renderPipeline?.dispose();
      this.renderPipeline = null;
      this.renderPipelineSignature = "";
      this.updateInspectorCamera();
      this.renderer.render(this.scene, this.inspectorCamera);
      return;
    }
    const camera = this.objectPreviewActive ? this.objectPreviewCamera : this.activeCamera;
    if (!this.settings.renderer.postProcessing) {
      this.renderPipeline?.dispose();
      this.renderPipeline = null;
      this.renderPipelineSignature = "";
      this.renderer.render(this.scene, camera);
      return;
    }
    const signature = renderPipelineSettingsSignature(this.settings, camera.uuid);
    if (!this.renderPipeline || signature !== this.renderPipelineSignature) {
      this.renderPipeline?.dispose();
      this.renderPipeline = createRenderPipeline(this.renderer, this.scene, camera, this.settings);
      this.renderPipelineSignature = signature;
    }
    this.renderPipeline.render();
  }

  async precompile() { await this.renderer.compileAsync(this.scene, this.activeCamera); }

  async dispose() {
    this.disposing = true;
    this.renderPipeline?.dispose();
    this.renderPipeline = null;
    this.cameraHelper?.removeFromParent();
    this.cameraHelper?.dispose();
    this.cameraHelper = null;
    this.inspectorGrid.removeFromParent();
    this.inspectorGrid.geometry.dispose();
    if (Array.isArray(this.inspectorGrid.material)) this.inspectorGrid.material.forEach((material) => material.dispose());
    else this.inspectorGrid.material.dispose();
    this.inspectorAxes.removeFromParent();
    this.inspectorAxes.geometry.dispose();
    if (Array.isArray(this.inspectorAxes.material)) this.inspectorAxes.material.forEach((material) => material.dispose());
    else this.inspectorAxes.material.dispose();
    for (const light of this.lights.values()) { light.removeFromParent(); light.dispose(); }
    this.lights.clear();
    await this.renderer.dispose();
    this.disposing = false;
  }
}

export function createRenderPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, settings: SceneSettings) {
  const scenePass = pass(scene, camera);
  const mrtOutputs: Record<string, THREE.Node> = { output };
  if (settings.renderer.bloomStrength > 0) mrtOutputs.emissive = emissive;
  if (settings.renderer.motionBlurEnabled) mrtOutputs.velocity = velocity;
  scenePass.setMRT(mrt(mrtOutputs));

  if (settings.renderer.gtaoEnabled) {
    const normalPass = pass(scene, camera);
    normalPass.setMRT(mrt({ output: normalView }));
    const gtao = ao(normalPass.getTextureNode("depth"), normalPass.getTextureNode(), camera);
    gtao.radius.value = Math.max(0.001, settings.renderer.gtaoRadius ?? 0.25);
    gtao.thickness.value = Math.max(0.001, settings.renderer.gtaoThickness ?? 1);
    gtao.scale.value = Math.max(0, settings.renderer.gtaoScale ?? 1);
    gtao.samples.value = Math.max(1, Math.min(32, Math.floor(settings.renderer.gtaoSamples ?? 16)));
    scenePass.contextNode = builtinAOContext(gtao.getTextureNode().sample(screenUV).r);
  }

  const color = scenePass.getTextureNode("output");
  let outputNode: any = color;
  if (settings.renderer.motionBlurEnabled) {
    outputNode = motionBlur(color, scenePass.getTextureNode("velocity"), int(Math.max(2, Math.min(32, Math.floor(settings.renderer.motionBlurSamples ?? 12)))));
  }
  if (settings.renderer.bloomStrength > 0) {
    outputNode = outputNode.add(bloom(scenePass.getTextureNode("emissive"), settings.renderer.bloomStrength, settings.renderer.bloomRadius, settings.renderer.bloomThreshold));
  }
  if (settings.renderer.depthOfFieldEnabled) {
    const depth = scenePass.getTextureNode("depth");
    const viewZ = camera instanceof THREE.OrthographicCamera
      ? orthographicDepthToViewZ(depth, float(camera.near), float(camera.far))
      : scenePass.getViewZNode("depth");
    outputNode = dof(outputNode, viewZ, Math.max(0, settings.renderer.depthOfFieldFocusDistance ?? 10), Math.max(0.001, settings.renderer.depthOfFieldFocalLength ?? 1), Math.max(0, settings.renderer.depthOfFieldBokehScale ?? 1));
  }
  const antialiased = settings.renderer.fxaa ? fxaa(renderOutput(outputNode)) : outputNode;
  const pipeline = new THREE.RenderPipeline(renderer, antialiased);
  if (settings.renderer.fxaa) pipeline.outputColorTransform = false;
  return pipeline;
}

export function renderPipelineSettingsSignature(settings: SceneSettings, cameraKey: string = settings.camera.projection) {
  const renderer = settings.renderer;
  return JSON.stringify([
    cameraKey, renderer.postProcessing, renderer.fxaa,
    renderer.bloomStrength, renderer.bloomRadius, renderer.bloomThreshold,
    renderer.gtaoEnabled, renderer.gtaoRadius, renderer.gtaoThickness, renderer.gtaoScale, renderer.gtaoSamples,
    renderer.depthOfFieldEnabled, renderer.depthOfFieldFocusDistance, renderer.depthOfFieldFocalLength, renderer.depthOfFieldBokehScale,
    renderer.motionBlurEnabled, renderer.motionBlurSamples,
  ]);
}

function rendererOptions(canvas: OffscreenCanvas, settings: SceneSettings) {
  return {
    canvas,
    antialias: settings.renderer.antialias,
    samples: THREE.MathUtils.clamp(Math.floor(settings.renderer.samples), 0, MAX_PREVIEW_MSAA_SAMPLES),
    // Keep an alpha-capable swap chain so transparency can be toggled live.
    alpha: true,
    outputBufferType: settings.renderer.outputBuffer === "float16" ? THREE.HalfFloatType : THREE.UnsignedByteType,
  };
}

export function toneMappingFrom(kind: ToneMappingKind) {
  return ({ none: THREE.NoToneMapping, linear: THREE.LinearToneMapping, reinhard: THREE.ReinhardToneMapping, cineon: THREE.CineonToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping })[kind];
}

export function shadowTypeFrom(kind: SceneSettings["renderer"]["shadowType"]) {
  return ({ basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, pcfSoft: THREE.PCFSoftShadowMap, vsm: THREE.VSMShadowMap })[kind];
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
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 100;
  }
}
