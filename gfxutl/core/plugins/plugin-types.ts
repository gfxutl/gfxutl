export type RendererPluginStatus = "bundling" | "active" | "error";

export interface RendererPluginFile {
  path: string;
  source: string;
}

export interface RendererPluginPackage {
  id: string;
  name: string;
  version?: string;
  entry: string;
  files: RendererPluginFile[];
}

export interface RendererPluginBundle {
  id: string;
  name: string;
  version?: string;
  entry: string;
  moduleCount: number;
  code: string;
}

export interface RendererPluginInfo {
  id: string;
  name: string;
  version?: string;
  entry: string;
  status: RendererPluginStatus;
  moduleCount: number;
  bundleBytes?: number;
  error?: string;
}

export interface RendererPluginFrame {
  time: number;
  fps: number;
  mode: "realtime" | "playback";
}
