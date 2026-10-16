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
import { useI18n } from "../core/i18n";

const MiB = 1024 * 1024;

export function SettingsPanel() {
  const { state, controller } = useEditor();
  const { locale, setLocale, t } = useI18n();
  const settings = state.settings;
  const maxMb = Math.round(settings.ramPreviewMaxBytes / MiB);
  const usedMb = state.cache.usedBytes / MiB;

  return <div className="settings-panel">
    <section className="settings-group" aria-labelledby="language-settings">
      <div className="settings-group-title" id="language-settings"><Settings2 /> {t("言語")}</div>
      <label className="settings-field"><span>{t("表示言語")}</span><select aria-label={t("表示言語")} value={locale} onChange={(event) => setLocale(event.target.value as "ja" | "en")}><option value="ja">{t("日本語")}</option><option value="en">{t("英語")}</option></select></label>
    </section>

    <section className="settings-group project-settings" aria-labelledby="project-settings">
      <div className="settings-group-title" id="project-settings"><FileDown /> {t("プロジェクト")}</div>
      <label className="settings-field"><span>{t("名前")}</span><input aria-label={t("プロジェクト名")} value={state.projectName} onChange={(event) => controller.renameProject(event.target.value)} /></label>
      <label className="settings-field"><span>{t("長さ")}</span><div className="settings-number"><input aria-label={t("シーケンス長")} type="number" min={1 / state.fps} step={1 / state.fps} value={Number(state.duration.toFixed(3))} onChange={(event) => controller.updateSequenceSettings({ duration: Number(event.target.value) })} /><small>s</small></div></label>
      <label className="settings-field"><span>{t("フレームレート")}</span><div className="settings-number"><input aria-label={t("シーケンスのフレームレート")} type="number" min={1} max={240} step={1} value={state.fps} onChange={(event) => controller.updateSequenceSettings({ fps: Number(event.target.value) })} /><small>fps</small></div></label>
      <div className="project-actions">
        <Button size="sm" variant="ghost" onClick={controller.newProject}><FilePlus2 />{t("新規")}</Button>
        <Button size="sm" variant="ghost" onClick={() => void controller.openProject()}><FolderOpen />{t("開く")}</Button>
        <Button size="sm" onClick={() => void controller.saveProject()}><Save />{t("保存")}</Button>
      </div>
      <button className="project-save-as" type="button" onClick={() => void controller.saveProjectAs()}>{t("別名で保存")}</button>
    </section>

    <section className="settings-group" aria-labelledby="ram-preview-settings">
      <div className="settings-group-title" id="ram-preview-settings"><Database /> {t("RAMプレビュー")}</div>
      <label className="settings-switch">
        <span><strong>{t("RAMプレビューを使用")}</strong></span>
        <input type="checkbox" aria-label={t("RAMプレビューを有効化")} checked={settings.ramPreviewEnabled} onChange={(event) => controller.updateSettings({ ramPreviewEnabled: event.target.checked })} />
        <i aria-hidden="true" />
      </label>
      <label className="settings-field">
        <span>{t("容量上限")}</span>
        <div className="settings-number"><input aria-label={t("RAMプレビュー容量")} type="number" min={32} max={2048} step={32} value={maxMb} onChange={(event) => controller.updateSettings({ ramPreviewMaxBytes: Number(event.target.value) * MiB })} /><small>MB</small></div>
      </label>
      <Slider className="settings-range" aria-label={t("RAMプレビュー容量スライダー")} min={32} max={2048} step={32} value={maxMb} onChange={(event) => controller.updateSettings({ ramPreviewMaxBytes: Number(event.target.value) * MiB })} />
      <div className={`settings-cache-state ${settings.ramPreviewEnabled ? "" : "disabled"}`}>
        <span>{settings.ramPreviewEnabled ? t("{value} MB 使用中", { value: usedMb.toFixed(1) }) : t("RAMプレビューは無効です")}</span>
        <strong>{t("{count} フレーム", { count: state.cache.entries })}</strong>
        <Button variant="ghost" size="icon" aria-label={t("RAMプレビューを消去")} disabled={!state.cache.entries} onClick={controller.clearCache}><Trash2 /></Button>
      </div>
    </section>

    <section className="settings-group" aria-labelledby="editing-settings">
      <div className="settings-group-title" id="editing-settings"><Settings2 /> {t("編集")}</div>
      <label className="settings-switch"><span><strong>{t("オートキー")}</strong><small>{t("変更した値を現在位置へ記録")}</small></span><input type="checkbox" aria-label={t("オートキーを有効化")} checked={settings.autoKeyEnabled} onChange={(event) => controller.updateSettings({ autoKeyEnabled: event.target.checked })} /><i aria-hidden="true" /></label>
    </section>

    <section className="settings-group" aria-labelledby="audio-channel-settings">
      <div className="settings-group-title" id="audio-channel-settings"><AudioLines /> {t("オーディオ")}</div>
      <fieldset className="settings-choice">
        <legend>{t("チャンネル")}</legend>
        <label className={settings.audioChannels === "stereo" ? "active" : ""}><input type="radio" name="audio-channels" value="stereo" checked={settings.audioChannels === "stereo"} onChange={() => controller.updateSettings({ audioChannels: "stereo" })} /><span>{t("ステレオ")}</span><small>{t("左右 2チャンネル")}</small></label>
        <label className={settings.audioChannels === "mono" ? "active" : ""}><input type="radio" name="audio-channels" value="mono" checked={settings.audioChannels === "mono"} onChange={() => controller.updateSettings({ audioChannels: "mono" })} /><span>{t("モノラル")}</span><small>{t("1チャンネルへミックス")}</small></label>
      </fieldset>
    </section>
  </div>;
}
