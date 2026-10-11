import { Database, Gauge, Trash2 } from "lucide-react";
import { useEditor } from "../core/interface";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

export function StatusBar() {
  const { state, controller } = useEditor();
  const used = state.cache.usedBytes / 1024 / 1024;
  const max = state.cache.maxBytes / 1024 / 1024;
  const ramPreviewEnabled = state.settings.ramPreviewEnabled;
  const gpuContext = state.engine === "webgpu" ? "WebGPU" : state.engine === "webgl2" ? "WebGL" : state.engine === "unsupported" ? "GPU利用不可" : "GPU初期化中";
  return (
    <footer className="status-bar panel">
      <div className="status-center">
        <span className="gpu-context" data-gpu-context={state.engine}><i className={`engine-light ${state.engine}`} /><Gauge />{gpuContext}</span>
        <span className="renderer-stats" title={`Lines ${state.rendererStats.lines} / Points ${state.rendererStats.points} / Geometries ${state.rendererStats.geometries} / Textures ${state.rendererStats.textures}`}>
          {state.rendererStats.calls} calls · {state.rendererStats.triangles.toLocaleString()} tris · {state.rendererStats.frameMs.toFixed(1)} ms
        </span>
      </div>
      <div className={`cache-meter ${ramPreviewEnabled ? "" : "disabled"}`} data-cache-entries={state.cache.entries} data-cache-enabled={ramPreviewEnabled}>
        <Database />
        <span>RAMプレビュー</span>
        <div className="meter"><i style={{ width: `${ramPreviewEnabled && max > 0 ? Math.min(100, used / max * 100) : 0}%` }} /></div>
        <strong>{ramPreviewEnabled ? `${used.toFixed(1)} / ${max.toFixed(0)} MB` : "無効"}</strong>
        <span className="codec">H.264</span>
        <Tooltip label="キャッシュを消去"><Button variant="ghost" size="icon" disabled={!ramPreviewEnabled || !state.cache.entries} onClick={controller.clearCache}><Trash2 /></Button></Tooltip>
      </div>
    </footer>
  );
}
