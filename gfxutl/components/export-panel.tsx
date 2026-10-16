import {
  CheckmarkCircle16Regular as CheckCircle2,
  Gauge16Regular as Gauge,
  Settings16Regular as Settings2,
  VideoClip16Regular as FileVideo2,
  Image16Regular as Image,
} from "@fluentui/react-icons";
import { shallowEqual, useEditor } from "../core/interface";
import { COMPOSITION_SIZE_PRESETS } from "../core/interface/composition-size";
import { Button } from "./ui/button";
import { useI18n } from "../core/i18n";

export function ExportPanel() {
  const { state, controller } = useEditor((value) => ({ exportProgress: value.exportProgress, exportSettings: value.exportSettings, exportStatus: value.exportStatus }), shallowEqual);
  const { t } = useI18n();
  const settings = state.exportSettings;
  const estimatedMb = (settings.bitrate + (settings.audioCodec === "none" ? 0 : settings.audioBitrate)) * Math.max(0, settings.endTime - settings.startTime) / 8 / 1024 / 1024;
  const presetValue = `${settings.width}x${settings.height}`;
  const hasPreset = COMPOSITION_SIZE_PRESETS.some(({ width, height }) => width === settings.width && height === settings.height);
  const busy = state.exportStatus === "exporting";

  return (
    <div className="export-panel">
      <div className="export-group">
        <div className="export-group-title"><FileVideo2 /> {t("ファイル")}</div>
        <label className="export-field"><span>{t("ファイル名")}</span><input value={settings.filename} onChange={(event) => controller.updateExportSettings({ filename: event.target.value })} /></label>
        <label className="export-field"><span>{t("形式")}</span><select value={settings.format} onChange={(event) => controller.updateExportSettings({ format: event.target.value as "mp4" | "webm" })}><option value="mp4">MP4</option><option value="webm">WebM</option></select></label>
      </div>
      <div className="export-group">
        <div className="export-group-title"><Settings2 /> {t("映像")}</div>
        <label className="export-field"><span>{t("映像コーデック")}</span><select value={settings.videoCodec} onChange={(event) => controller.updateExportSettings({ videoCodec: event.target.value as typeof settings.videoCodec })}>
          {settings.format === "mp4" ? <><option value="avc">H.264 / AVC</option><option value="hevc">H.265 / HEVC</option><option value="av1">AV1</option></> : <><option value="vp9">VP9</option><option value="vp8">VP8</option><option value="av1">AV1</option></>}
        </select></label>
        <div className="export-field"><span>{t("範囲（秒）")}</span><div className="export-range"><input aria-label={t("開始時間")} type="number" min={0} max={settings.endTime} step={0.1} value={settings.startTime} onChange={(event) => controller.updateExportSettings({ startTime: Number(event.target.value) })} /><i>–</i><input aria-label={t("終了時間")} type="number" min={settings.startTime} step={0.1} value={settings.endTime} onChange={(event) => controller.updateExportSettings({ endTime: Number(event.target.value) })} /></div></div>
        <label className="export-field"><span>{t("解像度")}</span><select value={hasPreset ? presetValue : "custom"} onChange={(event) => {
          const [width, height] = event.target.value.split("x").map(Number);
          if (Number.isFinite(width) && Number.isFinite(height)) controller.updateExportSettings({ width, height });
        }}>{COMPOSITION_SIZE_PRESETS.map((preset) => <option key={`${preset.width}x${preset.height}`} value={`${preset.width}x${preset.height}`}>{preset.width} × {preset.height}</option>)}{!hasPreset && <option value="custom">{t("カスタム")}</option>}</select></label>
        <div className="export-dimensions"><input type="number" min={2} max={7680} step={2} value={settings.width} onChange={(event) => controller.updateExportSettings({ width: Number(event.target.value) })} /><span>×</span><input type="number" min={2} max={4320} step={2} value={settings.height} onChange={(event) => controller.updateExportSettings({ height: Number(event.target.value) })} /></div>
        <label className="export-field"><span>{t("フレームレート")}</span><select value={settings.fps} onChange={(event) => controller.updateExportSettings({ fps: Number(event.target.value) })}>{[24, 25, 30, 50, 60].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}</select></label>
        <label className="export-field"><span>{t("ビットレート")}</span><div className="bitrate-input"><input type="number" min={1} max={100} value={settings.bitrate / 1_000_000} onChange={(event) => controller.updateExportSettings({ bitrate: Number(event.target.value) * 1_000_000 })} /><small>Mbps</small></div></label>
      </div>
      <div className="export-group">
        <div className="export-group-title"><Settings2 /> {t("音声")}</div>
        <label className="export-field"><span>{t("音声コーデック")}</span><select value={settings.audioCodec} onChange={(event) => controller.updateExportSettings({ audioCodec: event.target.value as typeof settings.audioCodec })}>
          <option value="none">{t("音声なし")}</option>
          {settings.format === "mp4" ? <><option value="aac">AAC</option><option value="opus">Opus</option></> : <><option value="opus">Opus</option><option value="vorbis">Vorbis</option></>}
        </select></label>
        {settings.audioCodec !== "none" && <label className="export-field"><span>{t("音声レート")}</span><div className="bitrate-input"><input type="number" min={32} max={512} step={16} value={settings.audioBitrate / 1000} onChange={(event) => controller.updateExportSettings({ audioBitrate: Number(event.target.value) * 1000 })} /><small>kbps</small></div></label>}
      </div>
      <div className="export-estimate"><Gauge /><span>{t("推定ファイルサイズ")}</span><strong>{t("約 {value} MB", { value: estimatedMb.toFixed(1) })}</strong></div>
      {busy && <div className="export-progress"><div><i style={{ width: `${state.exportProgress * 100}%` }} /></div><span>{Math.round(state.exportProgress * 100)}%</span></div>}
      {state.exportStatus === "done" && <div className="export-done"><CheckCircle2 /> {t("書き出しが完了しました")}</div>}
      <Button className="export-submit" variant="outline" disabled={busy} onClick={controller.exportCurrentFrame}><Image />{t("現在フレームをPNG保存")}</Button>
      <Button className="export-submit" variant={busy ? "outline" : "default"} onClick={busy ? controller.cancelExport : controller.exportVideo}>{t(busy ? "書き出しをキャンセル" : "書き出しを開始")}</Button>
    </div>
  );
}
