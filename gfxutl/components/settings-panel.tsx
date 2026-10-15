import {
  Database16Regular as Database,
  Delete16Regular as Trash2,
  DocumentAdd16Regular as FilePlus2,
  DocumentArrowDown16Regular as FileDown,
  FolderOpen16Regular as FolderOpen,
  Save16Regular as Save,
  Settings16Regular as Settings2,
  SoundWaveCircle16Regular as AudioLines,
} from "@fluentui/react-icons";
import { useEditor } from "../core/interface";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";

const MiB = 1024 * 1024;

export function SettingsPanel() {
  const { state, controller } = useEditor();
  const settings = state.settings;
  const maxMb = Math.round(settings.ramPreviewMaxBytes / MiB);
  const usedMb = state.cache.usedBytes / MiB;

  return <div className="settings-panel">
    <div className="settings-heading"><Settings2 /><div><strong>エディター設定</strong><small>プレビューとオーディオの動作を設定します</small></div></div>

    <section className="settings-group project-settings" aria-labelledby="project-settings">
      <div className="settings-group-title" id="project-settings"><FileDown /> プロジェクト</div>
      <label className="settings-field"><span>名前</span><input aria-label="プロジェクト名" value={state.projectName} onChange={(event) => controller.renameProject(event.target.value)} /></label>
      <div className="project-actions">
        <Button size="sm" variant="ghost" onClick={controller.newProject}><FilePlus2 />新規</Button>
        <Button size="sm" variant="ghost" onClick={() => void controller.openProject()}><FolderOpen />開く</Button>
        <Button size="sm" onClick={() => void controller.saveProject()}><Save />保存</Button>
      </div>
      <button className="project-save-as" type="button" onClick={() => void controller.saveProjectAs()}>別名で保存</button>
    </section>

    <section className="settings-group" aria-labelledby="ram-preview-settings">
      <div className="settings-group-title" id="ram-preview-settings"><Database /> RAMプレビュー</div>
      <label className="settings-switch">
        <span><strong>RAMプレビューを使用</strong><small>停止中のフレームをH.264でメモリへキャッシュします</small></span>
        <input type="checkbox" aria-label="RAMプレビューを有効化" checked={settings.ramPreviewEnabled} onChange={(event) => controller.updateSettings({ ramPreviewEnabled: event.target.checked })} />
        <i aria-hidden="true" />
      </label>
      <label className="settings-field">
        <span>容量上限</span>
        <div className="settings-number"><input aria-label="RAMプレビュー容量" type="number" min={32} max={2048} step={32} value={maxMb} onChange={(event) => controller.updateSettings({ ramPreviewMaxBytes: Number(event.target.value) * MiB })} /><small>MB</small></div>
      </label>
      <Slider className="settings-range" aria-label="RAMプレビュー容量スライダー" min={32} max={2048} step={32} value={maxMb} onChange={(event) => controller.updateSettings({ ramPreviewMaxBytes: Number(event.target.value) * MiB })} />
      <div className={`settings-cache-state ${settings.ramPreviewEnabled ? "" : "disabled"}`}>
        <span>{settings.ramPreviewEnabled ? `${usedMb.toFixed(1)} MB 使用中` : "RAMプレビューは無効です"}</span>
        <strong>{state.cache.entries} フレーム</strong>
        <Button variant="ghost" size="icon" aria-label="RAMプレビューを消去" disabled={!state.cache.entries} onClick={controller.clearCache}><Trash2 /></Button>
      </div>
    </section>

    <section className="settings-group" aria-labelledby="audio-channel-settings">
      <div className="settings-group-title" id="audio-channel-settings"><AudioLines /> オーディオ</div>
      <fieldset className="settings-choice">
        <legend>チャンネル</legend>
        <label className={settings.audioChannels === "stereo" ? "active" : ""}><input type="radio" name="audio-channels" value="stereo" checked={settings.audioChannels === "stereo"} onChange={() => controller.updateSettings({ audioChannels: "stereo" })} /><span>ステレオ</span><small>左右 2チャンネル</small></label>
        <label className={settings.audioChannels === "mono" ? "active" : ""}><input type="radio" name="audio-channels" value="mono" checked={settings.audioChannels === "mono"} onChange={() => controller.updateSettings({ audioChannels: "mono" })} /><span>モノラル</span><small>1チャンネルへミックス</small></label>
      </fieldset>
      <p className="settings-note">プレビュー再生と書き出しの両方に適用されます。</p>
    </section>
  </div>;
}
