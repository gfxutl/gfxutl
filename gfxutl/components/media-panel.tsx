import { AudioLines, Box, Film, FolderOpen, Grid2X2, Image, List, MoreVertical, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../core/interface";
import type { MediaAsset } from "../core/interface";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { ExportPanel } from "./export-panel";

const KindIcon = ({ kind }: { kind: MediaAsset["kind"] }) => kind === "audio" ? <AudioLines /> : kind === "image" ? <Image /> : kind === "model" ? <Box /> : <Film />;

function MediaThumbnail({ asset, playing }: { asset: MediaAsset; playing: boolean }) {
  const { controller } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (asset.kind === "model") return;
    if (asset.fileStatus && asset.fileStatus !== "ready") return;
    let cancelled = false;
    let timer = 0;
    const startedAt = performance.now();
    const draw = async () => {
      if (playing) return;
      const isPreviewing = hovered && asset.kind === "video" && asset.duration > 0;
      const elapsed = (performance.now() - startedAt) / 1000;
      const time = isPreviewing ? elapsed % asset.duration : asset.kind === "video" ? Math.min(asset.duration * 0.1, Math.max(0, asset.duration - 0.04)) : 0;
      try {
        const thumbnail = await controller.getMediaThumbnail(asset.id, time);
        if (cancelled) { thumbnail.bitmap?.close(); return; }
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (canvas && context) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          if (thumbnail.bitmap) {
            const scale = Math.max(canvas.width / thumbnail.bitmap.width, canvas.height / thumbnail.bitmap.height);
            const targetWidth = thumbnail.bitmap.width * scale;
            const targetHeight = thumbnail.bitmap.height * scale;
            context.drawImage(thumbnail.bitmap, (canvas.width - targetWidth) / 2, (canvas.height - targetHeight) / 2, targetWidth, targetHeight);
            thumbnail.bitmap.close();
          } else if (thumbnail.peaks?.length) {
            context.fillStyle = "#182923";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#80b8a2";
            const barWidth = canvas.width / thumbnail.peaks.length;
            thumbnail.peaks.forEach((peak, index) => {
              const barHeight = Math.max(1, peak * canvas.height * 0.88);
              context.fillRect(index * barWidth + 1, (canvas.height - barHeight) / 2, Math.max(1, barWidth - 2), barHeight);
            });
          }
        }
      } catch {
        // A restored handle can become ready between renders; the next state change retries it.
      }
      if (!cancelled && isPreviewing) timer = window.setTimeout(draw, 100);
    };
    void draw();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [asset.duration, asset.fileStatus, asset.id, asset.kind, controller, hovered, playing]);

  return <div className={`media-thumb thumb-${asset.kind}`} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <canvas ref={canvasRef} width={160} height={90} aria-label={`${asset.name} のサムネイル`} />
    <KindIcon kind={asset.kind} />
    {asset.duration > 0 && <time>{formatDuration(asset.duration)}</time>}
    {asset.fileStatus && asset.fileStatus !== "ready" && <span className="media-file-status"><RefreshCw />{asset.fileStatus === "loading" ? "復元中" : "再接続"}</span>}
  </div>;
}

export function MediaPanel() {
  const { state, controller } = useEditor();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const filtered = useMemo(() => state.assets.filter((asset) => asset.name.toLowerCase().includes(query.toLowerCase())), [state.assets, query]);

  return (
    <section className="media-panel panel">
      <div className="panel-tabs">
        <button className={state.leftPanelTab === "media" ? "active" : ""} onClick={() => controller.setLeftPanelTab("media")}>メディア</button>
        <button className={state.leftPanelTab === "export" ? "active" : ""} onClick={() => controller.setLeftPanelTab("export")}>出力</button>
      </div>
      {state.leftPanelTab === "export" ? <ExportPanel /> : <>
      <div className="media-toolbar">
        <Button size="icon" onClick={controller.openMedia} aria-label="メディアを読み込む" title="メディアを読み込む"><Plus /></Button>
        <Button size="icon" variant="ghost" onClick={controller.openModel} aria-label="GLBモデルを追加" title="GLBモデルを追加"><Box /></Button>
        <span className="spacer" />
        <Tooltip label="グリッド"><Button variant="ghost" size="icon" className={view === "grid" ? "active-soft" : ""} onClick={() => setView("grid")}><Grid2X2 /></Button></Tooltip>
        <Tooltip label="リスト"><Button variant="ghost" size="icon" className={view === "list" ? "active-soft" : ""} onClick={() => setView("list")}><List /></Button></Tooltip>
      </div>
      <label className="search-box">
        <Search />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="メディアを検索" />
      </label>
      <div className="bin-row"><FolderOpen /> <span>プロジェクトメディア</span><small>{filtered.length}</small></div>
      <div className={`media-grid ${view === "list" ? "list-view" : ""}`}>
        {filtered.map((asset) => (
          <button key={asset.id} draggable={asset.fileStatus === "ready" || !asset.handle} className={`media-card ${state.selectedAssetId === asset.id ? "selected" : ""} ${asset.fileStatus && asset.fileStatus !== "ready" ? "media-unavailable" : ""}`} onClick={() => {
            controller.selectAsset(asset.id);
            if (asset.fileStatus === "permission-required" || asset.fileStatus === "missing") void controller.restoreMediaAccess(asset.id);
          }} onDragStart={(event) => {
            if (asset.fileStatus && asset.fileStatus !== "ready") { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-gfxutl-asset", asset.id);
            event.dataTransfer.setData("text/plain", asset.id);
          }}>
            <MediaThumbnail asset={asset} playing={state.playing} />
            <div className="media-card-meta">
              <span>{asset.name}</span>
              <small>{asset.width ? `${asset.width} × ${asset.height}` : `${(asset.size / 1024 / 1024).toFixed(1)} MB`}</small>
            </div>
            <MoreVertical className="card-menu" />
          </button>
        ))}
      </div>
      {filtered.length === 0 && <div className="empty-media">一致するメディアはありません</div>}
      </>}
    </section>
  );
}

function formatDuration(value: number) {
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${Math.floor(value / 60)}:${seconds}`;
}
