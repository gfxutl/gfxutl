import { CheckCircle2, FileVideo2, Gauge, MonitorUp, Settings2 } from "lucide-react";
import { useEditor } from "../core/interface";
import { Button } from "./ui/button";

const presets = [
  { label: "HD 720p", width: 1280, height: 720 },
  { label: "Full HD 1080p", width: 1920, height: 1080 },
  { label: "Ultra HD 4K", width: 3840, height: 2160 },
];

export function ExportPanel() {
  const { state, controller } = useEditor();
  const settings = state.exportSettings;
  const estimatedMb = (settings.bitrate + (settings.audioCodec === "none" ? 0 : settings.audioBitrate)) * Math.max(0, settings.endTime - settings.startTime) / 8 / 1024 / 1024;
  const presetValue = `${settings.width}x${settings.height}`;
  const busy = state.exportStatus === "exporting";

  return (
    <div className="export-panel">
      <div className="export-heading"><MonitorUp /><div><strong>映像を書き出す</strong><small>タイムラインを1本の映像ファイルにレンダリングします</small></div></div>
      <div className="export-group">
        <div className="export-group-title"><FileVideo2 /> ファイル</div>
        <label className="export-field"><span>ファイル名</span><input value={settings.filename} onChange={(event) => controller.updateExportSettings({ filename: event.target.value })} /></label>
        <label className="export-field"><span>形式</span><select value={settings.format} onChange={(event) => controller.updateExportSettings({ format: event.target.value as "mp4" | "webm" })}><option value="mp4">MP4</option><option value="webm">WebM</option></select></label>
      </div>
      <div className="export-group">
        <div className="export-group-title"><Settings2 /> 映像</div>
        <label className="export-field"><span>映像コーデック</span><select value={settings.videoCodec} onChange={(event) => controller.updateExportSettings({ videoCodec: event.target.value as typeof settings.videoCodec })}>
          {settings.format === "mp4" ? <><option value="avc">H.264 / AVC</option><option value="hevc">H.265 / HEVC</option><option value="av1">AV1</option></> : <><option value="vp9">VP9</option><option value="vp8">VP8</option><option value="av1">AV1</option></>}
        </select></label>
        <div className="export-field"><span>範囲（秒）</span><div className="export-range"><input aria-label="開始時間" type="number" min={0} max={settings.endTime} step={0.1} value={settings.startTime} onChange={(event) => controller.updateExportSettings({ startTime: Math.max(0, Number(event.target.value)) })} /><i>–</i><input aria-label="終了時間" type="number" min={settings.startTime} max={state.duration} step={0.1} value={settings.endTime} onChange={(event) => controller.updateExportSettings({ endTime: Math.min(state.duration, Number(event.target.value)) })} /></div></div>
        <label className="export-field"><span>解像度</span><select value={presetValue} onChange={(event) => {
          const [width, height] = event.target.value.split("x").map(Number);
          controller.updateExportSettings({ width, height });
        }}>{presets.map((preset) => <option key={preset.label} value={`${preset.width}x${preset.height}`}>{preset.label}</option>)}</select></label>
        <div className="export-dimensions"><input type="number" min={2} max={7680} step={2} value={settings.width} onChange={(event) => controller.updateExportSettings({ width: Number(event.target.value) })} /><span>×</span><input type="number" min={2} max={4320} step={2} value={settings.height} onChange={(event) => controller.updateExportSettings({ height: Number(event.target.value) })} /></div>
        <label className="export-field"><span>フレームレート</span><select value={settings.fps} onChange={(event) => controller.updateExportSettings({ fps: Number(event.target.value) })}>{[24, 25, 30, 50, 60].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}</select></label>
        <label className="export-field"><span>ビットレート</span><div className="bitrate-input"><input type="number" min={1} max={100} value={settings.bitrate / 1_000_000} onChange={(event) => controller.updateExportSettings({ bitrate: Number(event.target.value) * 1_000_000 })} /><small>Mbps</small></div></label>
      </div>
      <div className="export-group">
        <div className="export-group-title"><Settings2 /> 音声</div>
        <label className="export-field"><span>音声コーデック</span><select value={settings.audioCodec} onChange={(event) => controller.updateExportSettings({ audioCodec: event.target.value as typeof settings.audioCodec })}>
          <option value="none">音声なし</option>
          {settings.format === "mp4" ? <><option value="aac">AAC</option><option value="opus">Opus</option></> : <><option value="opus">Opus</option><option value="vorbis">Vorbis</option></>}
        </select></label>
        {settings.audioCodec !== "none" && <label className="export-field"><span>音声レート</span><div className="bitrate-input"><input type="number" min={32} max={512} step={16} value={settings.audioBitrate / 1000} onChange={(event) => controller.updateExportSettings({ audioBitrate: Number(event.target.value) * 1000 })} /><small>kbps</small></div></label>}
      </div>
      <div className="export-estimate"><Gauge /><span>推定ファイルサイズ</span><strong>約 {estimatedMb.toFixed(1)} MB</strong></div>
      {busy && <div className="export-progress"><div><i style={{ width: `${state.exportProgress * 100}%` }} /></div><span>{Math.round(state.exportProgress * 100)}%</span></div>}
      {state.exportStatus === "done" && <div className="export-done"><CheckCircle2 /> 書き出しが完了しました</div>}
      <Button className="export-submit" disabled={busy} onClick={controller.exportVideo}>{busy ? "レンダリング中…" : "書き出しを開始"}</Button>
      <Button variant="ghost" className="export-still" disabled={busy} onClick={() => void controller.exportCurrentFrame()}>現在フレームをPNGで保存</Button>
    </div>
  );
}
