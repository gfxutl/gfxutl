import * as THREE from "three/webgpu";
import type { RendererPluginBundle, RendererPluginFrame, RendererPluginInfo } from "../plugins/plugin-types";

type RendererContext = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
};

type RendererPluginApi = {
  readonly version: 1;
  readonly three: typeof THREE;
  readonly renderer: THREE.WebGPURenderer | undefined;
  readonly scene: THREE.Scene | undefined;
  readonly camera: THREE.Camera | undefined;
  addObject(object: THREE.Object3D): void;
  removeObject(object: THREE.Object3D): void;
  requestRender(): void;
  log(...values: unknown[]): void;
};

type PluginDefinition = {
  activate?: (api: RendererPluginApi) => unknown | Promise<unknown>;
  onFrame?: (frame: RendererPluginFrame, api: RendererPluginApi) => unknown | Promise<unknown>;
  dispose?: () => unknown | Promise<unknown>;
};

type PluginInstance = {
  info: RendererPluginInfo;
  api: RendererPluginApi;
  objects: Set<THREE.Object3D>;
  onFrame?: PluginDefinition["onFrame"];
  dispose?: PluginDefinition["dispose"];
};

type RuntimeHost = {
  context(): RendererContext | undefined;
  requestRender(): void;
  state(info: RendererPluginInfo): void;
};

export class RendererPluginRuntime {
  private instances = new Map<string, PluginInstance>();
  private frameContext?: RendererContext;

  constructor(private host: RuntimeHost) {}

  async load(source: RendererPluginBundle) {
    await this.unload(source.id, false);
    const baseInfo: RendererPluginInfo = {
      id: source.id,
      name: source.name,
      version: source.version,
      entry: source.entry,
      status: "bundling",
      moduleCount: source.moduleCount,
    };
    this.host.state(baseInfo);
    try {
      const objects = new Set<THREE.Object3D>();
      const api = this.createApi(source.id, objects);
      const exports = evaluatePluginBundle(source.code);
      const exported = (exports.default ?? exports.plugin ?? exports) as PluginDefinition | PluginDefinition["activate"];
      if (!exported || (typeof exported !== "function" && typeof exported !== "object")) throw new Error("既定exportはプラグインオブジェクトまたはactivate関数である必要があります");
      const definition: PluginDefinition = typeof exported === "function" ? { activate: exported } : exported;
      const activated = await definition.activate?.(api);
      const activation = activated && typeof activated === "object" ? activated as PluginDefinition : undefined;
      const dispose = typeof activated === "function" ? activated as PluginDefinition["dispose"] : activation?.dispose ?? definition.dispose;
      const info: RendererPluginInfo = { ...baseInfo, status: "active", bundleBytes: new TextEncoder().encode(source.code).byteLength };
      this.instances.set(source.id, { info, api, objects, onFrame: activation?.onFrame ?? definition.onFrame, dispose });
      this.host.state(info);
      this.host.requestRender();
      return info;
    } catch (error) {
      const info: RendererPluginInfo = { ...baseInfo, status: "error", error: errorMessage(error) };
      this.host.state(info);
      return info;
    }
  }

  async unload(id: string, notify = true) {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.instances.delete(id);
    try { await instance.dispose?.(); } catch (error) { console.error(`[plugin:${id}] dispose`, error); }
    for (const object of instance.objects) object.removeFromParent();
    instance.objects.clear();
    if (notify) this.host.requestRender();
  }

  async runFrame(frame: RendererPluginFrame, context?: RendererContext) {
    this.frameContext = context;
    try {
      for (const instance of this.instances.values()) {
        if (!instance.onFrame) continue;
        try {
          await instance.onFrame(Object.freeze({ ...frame }), instance.api);
        } catch (error) {
          instance.info = { ...instance.info, status: "error", error: `onFrame: ${errorMessage(error)}` };
          instance.onFrame = undefined;
          this.host.state(instance.info);
        }
      }
    } finally {
      this.frameContext = undefined;
    }
  }

  private createApi(id: string, objects: Set<THREE.Object3D>): RendererPluginApi {
    const host = this.host;
    const context = () => this.frameContext ?? host.context();
    return Object.freeze({
      version: 1 as const,
      three: THREE,
      get renderer() { return context()?.renderer; },
      get scene() { return context()?.scene; },
      get camera() { return context()?.camera; },
      addObject(object: THREE.Object3D) {
        const scene = context()?.scene;
        if (!scene) throw new Error("レンダラーはまだ初期化されていません");
        object.userData.gfxutlPlugin = id;
        objects.add(object);
        scene.add(object);
      },
      removeObject(object: THREE.Object3D) {
        objects.delete(object);
        object.removeFromParent();
      },
      requestRender: () => host.requestRender(),
      log: (...values: unknown[]) => console.info(`[plugin:${id}]`, ...values),
    });
  }
}

function evaluatePluginBundle(code: string) {
  const load = new Function(`"use strict";\n${code}\nreturn __gfxutlPluginExports;`);
  const exports = load() as Record<string, unknown> | undefined;
  if (!exports || typeof exports !== "object") throw new Error("ESM exportをロードできませんでした");
  return exports;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "プラグインのロードに失敗しました");
}
