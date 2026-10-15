import { ArrowSync16Regular, Delete16Regular, FolderOpen16Regular } from "@fluentui/react-icons";
import { useEditor } from "../core/interface";
import { Button } from "./ui/button";

function formatBytes(bytes?: number) {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

export function PluginPanel() {
  const { state, controller } = useEditor();
  return <div className="plugin-panel">
    <div className="plugin-panel-intro">
      <strong>レンダラープラグイン</strong>
      <p>ESMパッケージをOxc/RolldownでWorker内バンドルし、レンダラースレッドで実行します。Workerからの外部接続は遮断されます。</p>
      <Button size="sm" onClick={() => void controller.loadRendererPlugin()} disabled={!state.fileSystemAccess}><FolderOpen16Regular /> ディレクトリを選択</Button>
    </div>
    {!state.plugins.length && <div className="plugin-empty">package.json のあるプラグインディレクトリを選択してください</div>}
    <div className="plugin-list">{state.plugins.map((plugin) => <article className="plugin-card" key={plugin.id}>
      <div className="plugin-card-heading">
        <div><strong>{plugin.name}</strong>{plugin.version && <small>v{plugin.version}</small>}</div>
        <span className={`plugin-status ${plugin.status}`}>{plugin.status === "active" ? "実行中" : plugin.status === "bundling" ? "バンドル中" : "エラー"}</span>
      </div>
      <code title={plugin.entry}>{plugin.entry}</code>
      <div className="plugin-card-meta"><span>{plugin.moduleCount} modules</span><span>{formatBytes(plugin.bundleBytes)}</span></div>
      {plugin.error && <p className="plugin-error">{plugin.error}</p>}
      <div className="plugin-card-actions">
        <Button size="sm" variant="ghost" onClick={() => void controller.reloadRendererPlugin(plugin.id)}><ArrowSync16Regular /> 再読込</Button>
        <Button size="sm" variant="ghost" onClick={() => controller.removeRendererPlugin(plugin.id)}><Delete16Regular /> 削除</Button>
      </div>
    </article>)}</div>
  </div>;
}
