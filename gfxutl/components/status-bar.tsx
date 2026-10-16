import { Code16Regular as Code, Database16Regular as Database, Delete16Regular as Trash2, Gauge16Regular as Gauge, Timeline20Regular as Timeline } from "@fluentui/react-icons";
import { useEditor } from "../core/interface";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { useI18n } from "../core/i18n";

export function StatusBar() {
  const { state, controller } = useEditor();
  const { locale, t } = useI18n();
  const used = state.cache.usedBytes / 1024 / 1024;
  const max = state.cache.maxBytes / 1024 / 1024;
  const mediaUsed = state.mediaBuffer.usedBytes / 1024 / 1024;
  const mediaMax = state.mediaBuffer.maxBytes / 1024 / 1024;
  const ramPreviewEnabled = state.settings.ramPreviewEnabled;
  const gpuContext = state.engine === "webgpu" ? "WebGPU" : state.engine === "webgl2" ? "WebGL" : state.engine === "unsupported" ? t("GPU利用不可") : t("GPU初期化中");
  return (
    <footer className="status-bar panel">
      <nav className="bottom-pane-tabs" role="tablist" aria-label={t("下部ペイン")}>
        <button className={`bottom-pane-tab bottom-pane-tab-timeline ${state.activeBottomPane === "timeline" ? "active" : ""}`} role="tab" aria-selected={state.activeBottomPane === "timeline"} onClick={() => controller.setBottomPane("timeline")}><Timeline /><span>{t("タイムライン")}</span></button>
        {state.shaderGraphs.map((graph) => {
          const active = state.activeBottomPane === "shader" && state.activeShaderGraphId === graph.id;
          return <button key={graph.id} className={`bottom-pane-tab bottom-pane-tab-object ${active ? "active" : ""}`} role="tab" aria-selected={active} onClick={() => controller.setBottomPane("shader", graph.id)} title={graph.sourcePath ?? graph.name}><Code /><span>{graph.name}{graph.dirty ? " •" : ""}</span></button>;
        })}
        {!state.shaderGraphs.length && <button className={`bottom-pane-tab bottom-pane-tab-object ${state.activeBottomPane === "shader" ? "active" : ""}`} role="tab" aria-selected={state.activeBottomPane === "shader"} onClick={() => controller.setBottomPane("shader")}><Code /><span>{t("シェーダーグラフ")}</span></button>}
      </nav>
      <div className="status-center">
        <span className="gpu-context" data-gpu-context={state.engine}><i className={`engine-light ${state.engine}`} /><Gauge />{gpuContext}</span>
        <span className="renderer-stats" title={`Lines ${state.rendererStats.lines} / Points ${state.rendererStats.points} / Geometries ${state.rendererStats.geometries} / Textures ${state.rendererStats.textures}`}>
          {state.rendererStats.calls} calls · {state.rendererStats.triangles.toLocaleString(locale)} tris · {state.rendererStats.frameMs.toFixed(1)} ms
        </span>
      </div>
      <div className="media-buffer-meter" data-media-buffer-entries={state.mediaBuffer.entries} data-media-buffer-pending={state.mediaBuffer.pending}>
        <Database />
        <span>{t("メディアバッファ")}</span>
        <div className="meter"><i style={{ width: `${mediaMax > 0 ? Math.min(100, mediaUsed / mediaMax * 100) : 0}%` }} /></div>
        <strong>{mediaUsed.toFixed(1)} / {mediaMax.toFixed(0)} MB</strong>
        <span className="codec">{state.mediaBuffer.entries} files · {state.mediaBuffer.instances} instances{state.mediaBuffer.pending ? ` · ${state.mediaBuffer.pending} loading` : ""}</span>
      </div>
      <div className={`cache-meter ${ramPreviewEnabled ? "" : "disabled"}`} data-cache-entries={state.cache.entries} data-cache-enabled={ramPreviewEnabled}>
        <Database />
        <span>{t("RAMプレビュー")}</span>
        <div className="meter"><i style={{ width: `${ramPreviewEnabled && max > 0 ? Math.min(100, used / max * 100) : 0}%` }} /></div>
        <strong>{ramPreviewEnabled ? `${used.toFixed(1)} / ${max.toFixed(0)} MB` : t("無効")}</strong>
        <span className="codec">H.264</span>
        <Tooltip label={t("キャッシュを消去")}><Button variant="ghost" size="icon" disabled={!ramPreviewEnabled || !state.cache.entries} onClick={controller.clearCache}><Trash2 /></Button></Tooltip>
      </div>
    </footer>
  );
}
