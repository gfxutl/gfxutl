import { ArrowLeft, AudioLines, Box, ChevronDown, ChevronRight, File, FileImage, FileVideo, Folder, FolderOpen, Grid2X2, HardDrive, Image, ListTree, Plus, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../core/interface";
import type { MediaAsset } from "../core/interface";
import { clearMediaDirectory, loadMediaDirectory, saveMediaDirectory } from "../core/persistence/handle-project-store";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { ExportPanel } from "./export-panel";
import { SettingsPanel } from "./settings-panel";

type ExplorerNode = {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  handle?: FileSystemDirectoryHandle | FileSystemFileHandle;
  file?: File;
  children?: ExplorerNode[];
  expanded?: boolean;
  loading?: boolean;
  accessRequired?: boolean;
};

const SUPPORTED_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "wav", "mp3", "aac", "flac", "png", "jpg", "jpeg", "webp", "hdr", "exr", "glb"]);

const KindIcon = ({ kind }: { kind: MediaAsset["kind"] }) => kind === "audio" ? <AudioLines /> : kind === "image" ? <Image /> : kind === "model" ? <Box /> : <FileVideo />;

function MediaThumbnail({ asset, playing }: { asset: MediaAsset; playing: boolean }) {
  const { controller } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (asset.kind === "model" || (asset.fileStatus && asset.fileStatus !== "ready")) return;
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
      } catch { /* A disconnected handle is represented by the status badge. */ }
      if (!cancelled && isPreviewing) timer = window.setTimeout(draw, 100);
    };
    void draw();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [asset.duration, asset.fileStatus, asset.id, asset.kind, controller, hovered, playing]);

  return <div className={`media-thumb thumb-${asset.kind}`} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <canvas ref={canvasRef} width={160} height={90} aria-label={`${asset.name} のサムネイル`} />
    <KindIcon kind={asset.kind} />
    {asset.duration > 0 && <time>{formatDuration(asset.duration)}</time>}
    {asset.fileStatus && asset.fileStatus !== "ready" && <span className="media-file-status"><RefreshCw />{asset.fileStatus === "loading" ? "読込中" : "再接続"}</span>}
  </div>;
}

function ExplorerImageThumbnail({ node }: { node: ExplorerNode }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const handle = node.handle?.kind === "file" ? node.handle : undefined;
        const file = node.file ?? await handle?.getFile();
        if (!file || cancelled) return;
        objectUrl = URL.createObjectURL(file);
        if (!cancelled) setUrl(objectUrl);
      } catch { /* The file card remains available even if thumbnail access fails. */ }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [node.file, node.handle, node.path]);

  return url
    ? <img className="explorer-image-thumbnail" src={url} alt={`${node.name} のサムネイル`} draggable={false} />
    : <FileImage />;
}

export function MediaPanel() {
  const { state, controller } = useEditor();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"tree" | "grid">(() => {
    try { return localStorage.getItem("gfxutl:media-view") === "grid" ? "grid" : "tree"; }
    catch { return "tree"; }
  });
  const [root, setRoot] = useState<ExplorerNode | null>(null);
  const [currentDirectoryId, setCurrentDirectoryId] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const importingPaths = useRef(new Set<string>());
  const assetsByPath = useMemo(() => new Map(state.assets.filter((asset) => asset.sourcePath).map((asset) => [asset.sourcePath!, asset])), [state.assets]);
  const standaloneAssets = useMemo(() => state.assets.filter((asset) => !asset.sourcePath && asset.name.toLowerCase().includes(query.toLowerCase())), [state.assets, query]);
  const selectedAsset = state.assets.find((asset) => asset.id === state.selectedAssetId);

  useEffect(() => {
    let cancelled = false;
    void loadMediaDirectory().then(async (handle) => {
      if (!handle || cancelled) return;
      const permission = await queryDirectoryPermission(handle);
      const nextRoot = createRootNode(handle, permission !== "granted");
      if (permission === "granted") nextRoot.children = await readDirectory(handle, nextRoot.path);
      if (!cancelled) { setRoot(nextRoot); setCurrentDirectoryId(nextRoot.id); }
    }).catch(() => { /* IndexedDB or a saved handle may be unavailable. */ });
    return () => { cancelled = true; };
  }, []);

  const openDirectory = async () => {
    setDirectoryError(null);
    try {
      if (window.showDirectoryPicker) {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        const nextRoot = createRootNode(handle, false);
        nextRoot.loading = true;
        setRoot(nextRoot);
        setCurrentDirectoryId(nextRoot.id);
        const children = await readDirectory(handle, nextRoot.path);
        setRoot({ ...nextRoot, children, loading: false });
        await saveMediaDirectory(handle).catch(() => { /* Some private contexts cannot persist handles. */ });
      } else {
        const files = await pickDirectoryFiles();
        const nextRoot = buildFallbackTree(files);
        setRoot(nextRoot);
        setCurrentDirectoryId(nextRoot.id);
      }
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") setDirectoryError("フォルダを開けませんでした");
    }
  };

  const refreshDirectory = async () => {
    if (!root) return;
    const directory = findNode(root, currentDirectoryId) ?? root;
    if (!directory.handle || directory.handle.kind !== "directory") return;
    setRoot((current) => current ? updateNode(current, directory.id, (item) => ({ ...item, loading: true })) : current);
    try {
      const children = await readDirectory(directory.handle, directory.path);
      setRoot((current) => current ? updateNode(current, directory.id, (item) => ({ ...item, children, expanded: true, loading: false, accessRequired: false })) : current);
    } catch {
      setRoot((current) => current ? updateNode(current, directory.id, (item) => ({ ...item, loading: false, accessRequired: true })) : current);
    }
  };

  const closeDirectory = async () => {
    setRoot(null);
    setCurrentDirectoryId(null);
    setDirectoryError(null);
    await clearMediaDirectory();
  };

  const toggleDirectory = async (node: ExplorerNode) => {
    if (node.loading) return;
    if (node.accessRequired && node.handle?.kind === "directory") {
      const permission = await requestDirectoryPermission(node.handle);
      if (permission !== "granted") return;
    }
    if (node.children) {
      setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, expanded: !item.expanded, accessRequired: false })) : current);
      return;
    }
    if (!node.handle || node.handle.kind !== "directory") return;
    setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, expanded: true, loading: true })) : current);
    try {
      const children = await readDirectory(node.handle, node.path);
      setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, children, expanded: true, loading: false, accessRequired: false })) : current);
    } catch {
      setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, loading: false, accessRequired: true })) : current);
    }
  };

  const importNode = async (node: ExplorerNode) => {
    if (!isSupported(node.name) || importingPaths.current.has(node.path)) return assetsByPath.get(node.path)?.id ?? null;
    const existing = assetsByPath.get(node.path);
    if (existing?.fileStatus === "ready") { controller.selectAsset(existing.id); return existing.id; }
    importingPaths.current.add(node.path);
    try {
      const handle = node.handle?.kind === "file" ? node.handle : undefined;
      const file = node.file ?? await handle?.getFile();
      if (!file) return null;
      return await controller.importMediaFile(file, handle, node.path);
    } finally {
      importingPaths.current.delete(node.path);
    }
  };

  const openGridDirectory = async (node: ExplorerNode) => {
    if (node.kind !== "directory" || node.loading) return;
    if (node.accessRequired && node.handle?.kind === "directory") {
      const permission = await requestDirectoryPermission(node.handle);
      if (permission !== "granted") return;
    }
    if (!node.children && node.handle?.kind === "directory") {
      setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, loading: true })) : current);
      try {
        const children = await readDirectory(node.handle, node.path);
        setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, children, loading: false, accessRequired: false })) : current);
      } catch {
        setRoot((current) => current ? updateNode(current, node.id, (item) => ({ ...item, loading: false, accessRequired: true })) : current);
        return;
      }
    }
    setCurrentDirectoryId(node.id);
  };

  const changeView = (next: "tree" | "grid") => {
    setView(next);
    try { localStorage.setItem("gfxutl:media-view", next); } catch { /* Storage may be unavailable. */ }
  };

  const visibleRoot = useMemo(() => root ? filterTree(root, query.trim().toLowerCase()) : null, [query, root]);
  const currentDirectory = root ? findNode(root, currentDirectoryId) ?? root : null;
  const directoryTrail = root && currentDirectory ? findNodeTrail(root, currentDirectory.id) : [];
  const gridChildren = (currentDirectory?.children ?? []).filter((node) => !query || node.name.toLowerCase().includes(query.toLowerCase()));

  return <section className="media-panel panel" onContextMenu={(event) => {
    event.preventDefault();
    event.stopPropagation();
    const assetId = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
    if (assetId) controller.selectAsset(assetId);
    controller.openContextMenu({ x: event.clientX, y: event.clientY, scope: "media", time: state.currentTime, timelineY: 32, positionX: 0, positionY: 0 });
  }}>
    <div className="panel-tabs">
      <button className={state.leftPanelTab === "media" ? "active" : ""} onClick={() => controller.setLeftPanelTab("media")}>メディア</button>
      <button className={state.leftPanelTab === "export" ? "active" : ""} onClick={() => controller.setLeftPanelTab("export")}>出力</button>
      <button className={state.leftPanelTab === "settings" ? "active" : ""} onClick={() => controller.setLeftPanelTab("settings")}>設定</button>
    </div>
    {state.leftPanelTab === "export" ? <ExportPanel /> : state.leftPanelTab === "settings" ? <SettingsPanel /> : <div className="media-explorer">
      <div className="media-toolbar">
        <Button size="icon" onClick={() => void openDirectory()} aria-label="フォルダを開く" title="メディアフォルダを開く"><FolderOpen /></Button>
        <Tooltip label="単体ファイルを読み込む"><Button size="icon" variant="ghost" onClick={controller.openMedia} aria-label="ファイルを読み込む"><Plus /></Button></Tooltip>
        <span className="spacer" />
        <Tooltip label="階層表示"><Button size="icon" variant="ghost" className={view === "tree" ? "active-soft" : ""} onClick={() => changeView("tree")} aria-label="階層表示"><ListTree /></Button></Tooltip>
        <Tooltip label="グリッド表示"><Button size="icon" variant="ghost" className={view === "grid" ? "active-soft" : ""} onClick={() => changeView("grid")} aria-label="グリッド表示"><Grid2X2 /></Button></Tooltip>
        {root && <><Tooltip label="フォルダを更新"><Button size="icon" variant="ghost" onClick={() => void refreshDirectory()} aria-label="フォルダを更新"><RotateCcw /></Button></Tooltip><Tooltip label="フォルダを閉じる"><Button size="icon" variant="ghost" onClick={() => void closeDirectory()} aria-label="フォルダを閉じる"><X /></Button></Tooltip></>}
      </div>
      <label className="search-box"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="フォルダ内を検索" /></label>
      {view === "tree" ? <div className="explorer-location"><HardDrive /><span>{root?.name ?? "メディアフォルダ未選択"}</span><small>{state.assets.length}</small></div> : <div className="explorer-location explorer-breadcrumbs">
        <button aria-label="上のフォルダへ" disabled={directoryTrail.length <= 1} onClick={() => setCurrentDirectoryId(directoryTrail.at(-2)?.id ?? root?.id ?? null)}><ArrowLeft /></button>
        <HardDrive />{directoryTrail.map((node, index) => <button key={node.id} className={index === directoryTrail.length - 1 ? "current" : ""} onClick={() => setCurrentDirectoryId(node.id)}>{node.name}</button>)}
        <small>{gridChildren.length}</small>
      </div>}
      {view === "tree" ? <div className="media-tree" role="tree" aria-label="メディアエクスプローラー">
        {visibleRoot ? <ExplorerRow node={visibleRoot} depth={0} forceExpanded={Boolean(query)} assetsByPath={assetsByPath} selectedAssetId={state.selectedAssetId} onToggle={toggleDirectory} onImport={importNode} onStage={controller.stageExplorerFile} onSelect={controller.selectAsset} /> : <div className="empty-media"><FolderOpen /><strong>メディアフォルダを開く</strong><span>フォルダ階層を展開して素材を選択できます</span></div>}
        {standaloneAssets.length > 0 && <div className="standalone-assets"><div className="media-tree-section"><File /> 単体ファイル</div>{standaloneAssets.map((asset) => <AssetRow key={asset.id} asset={asset} depth={1} selected={state.selectedAssetId === asset.id} onSelect={controller.selectAsset} onRestore={controller.restoreMediaAccess} />)}</div>}
        {directoryError && <div className="explorer-error">{directoryError}</div>}
      </div> : <div className="media-grid-page" role="list" aria-label="メディアグリッド">
        {currentDirectory ? gridChildren.map((node) => <ExplorerGridCard key={node.id} node={node} asset={assetsByPath.get(node.path)} selectedAssetId={state.selectedAssetId} playing={state.playing} onOpenDirectory={openGridDirectory} onImport={importNode} onStage={controller.stageExplorerFile} onSelect={controller.selectAsset} />) : <div className="empty-media"><FolderOpen /><strong>メディアフォルダを開く</strong><span>フォルダごとにページを移動して素材を表示できます</span></div>}
        {currentDirectory && gridChildren.length === 0 && <div className="empty-grid-page">このフォルダに表示できる項目はありません</div>}
        {!root && standaloneAssets.map((asset) => <GridAssetCard key={asset.id} asset={asset} selected={state.selectedAssetId === asset.id} playing={state.playing} onSelect={controller.selectAsset} onRestore={controller.restoreMediaAccess} />)}
        {directoryError && <div className="explorer-error">{directoryError}</div>}
      </div>}
      {selectedAsset && <div className="media-selection-preview"><MediaThumbnail asset={selectedAsset} playing={state.playing} /><div><strong>{selectedAsset.name}</strong><span>{selectedAsset.sourcePath ?? "単体ファイル"}</span><small>{selectedAsset.width ? `${selectedAsset.width} × ${selectedAsset.height}` : formatBytes(selectedAsset.size)}</small></div></div>}
    </div>}
  </section>;
}

function ExplorerGridCard({ node, asset, selectedAssetId, playing, onOpenDirectory, onImport, onStage, onSelect }: {
  node: ExplorerNode; asset?: MediaAsset; selectedAssetId: string | null; playing: boolean;
  onOpenDirectory: (node: ExplorerNode) => Promise<void>; onImport: (node: ExplorerNode) => Promise<string | null>;
  onStage: (path: string, file?: File, handle?: FileSystemFileHandle) => void; onSelect: (id: string | null) => void;
}) {
  if (node.kind === "directory") {
    return <div className="explorer-grid-item" role="listitem">
      <button className={`explorer-grid-card directory-card ${node.accessRequired ? "access-required" : ""}`} aria-label={`${node.name} フォルダを開く`} onClick={() => void onOpenDirectory(node)}>
        <span className="grid-card-visual">{node.loading ? <RefreshCw className="spin" /> : <FolderOpen />}</span>
        <span className="grid-card-name">{node.name}</span>
        <small>{node.accessRequired ? "アクセス許可" : "フォルダ"}</small>
      </button>
    </div>;
  }
  const supported = isSupported(node.name);
  const unavailable = asset?.fileStatus === "permission-required" || asset?.fileStatus === "missing";
  const status = asset?.fileStatus === "loading" ? "読込中" : unavailable ? "再接続" : asset?.width ? `${asset.width} × ${asset.height}` : extensionLabel(node.name);
  return <div className="explorer-grid-item" role="listitem">
      <button data-asset-id={asset?.id} className={`explorer-grid-card media-card ${asset?.id === selectedAssetId ? "selected" : ""} ${supported ? "" : "unsupported"}`} draggable={supported} disabled={!supported} aria-label={node.name} title={supported ? node.path : "未対応のファイル形式"} onClick={() => { if (asset?.fileStatus === "ready") onSelect(asset.id); else void onImport(node); }} onDragStart={(event) => {
      if (asset?.fileStatus === "ready") { setAssetDragData(event.dataTransfer, asset.id); return; }
      const handle = node.handle?.kind === "file" ? node.handle : undefined;
      onStage(node.path, node.file, handle);
      setExplorerDragData(event.dataTransfer, node.path);
    }}>
      <span className="grid-card-visual">{asset ? <MediaThumbnail asset={asset} playing={playing} /> : isBrowserPreviewImage(node.name) ? <ExplorerImageThumbnail node={node} /> : <FileKindIcon name={node.name} />}</span>
      <span className="grid-card-name">{node.name}</span>
      <small className={asset?.fileStatus && asset.fileStatus !== "ready" ? "media-file-status" : ""}>{status}</small>
    </button>
  </div>;
}

function GridAssetCard({ asset, selected, playing, onSelect, onRestore }: {
  asset: MediaAsset; selected: boolean; playing: boolean; onSelect: (id: string | null) => void; onRestore: (id?: string) => Promise<void>;
}) {
  const unavailable = asset.fileStatus === "permission-required" || asset.fileStatus === "missing";
  const status = asset.fileStatus === "loading" ? "読込中" : unavailable ? "再接続" : asset.width ? `${asset.width} × ${asset.height}` : extensionLabel(asset.name);
  return <div className="explorer-grid-item" role="listitem">
    <button data-asset-id={asset.id} className={`explorer-grid-card media-card ${selected ? "selected" : ""} ${unavailable ? "media-unavailable" : ""}`} draggable={asset.fileStatus === "ready" || !asset.handle} aria-label={asset.name} onClick={() => { onSelect(asset.id); if (unavailable) void onRestore(asset.id); }} onDragStart={(event) => setAssetDragData(event.dataTransfer, asset.id)}>
      <span className="grid-card-visual"><MediaThumbnail asset={asset} playing={playing} /></span>
      <span className="grid-card-name">{asset.name}</span>
      <small className={asset.fileStatus && asset.fileStatus !== "ready" ? "media-file-status" : ""}>{status}</small>
    </button>
  </div>;
}

function ExplorerRow({ node, depth, forceExpanded, assetsByPath, selectedAssetId, onToggle, onImport, onStage, onSelect }: {
  node: ExplorerNode; depth: number; forceExpanded: boolean; assetsByPath: Map<string, MediaAsset>; selectedAssetId: string | null;
  onToggle: (node: ExplorerNode) => void; onImport: (node: ExplorerNode) => Promise<string | null>;
  onStage: (path: string, file?: File, handle?: FileSystemFileHandle) => void; onSelect: (id: string | null) => void;
}) {
  if (node.kind === "directory") {
    const expanded = forceExpanded || node.expanded;
    return <div className="media-tree-branch">
      <button role="treeitem" aria-expanded={expanded} className={`media-tree-row folder-row ${node.accessRequired ? "access-required" : ""}`} style={{ paddingLeft: 7 + depth * 15 }} aria-label={`${node.name} フォルダ`} onClick={() => void onToggle(node)}>
        {node.loading ? <RefreshCw className="spin" /> : expanded ? <ChevronDown /> : <ChevronRight />}
        {expanded ? <FolderOpen className="folder-icon" /> : <Folder className="folder-icon" />}<span>{node.name}</span>
        {node.accessRequired && <small>アクセス許可</small>}
      </button>
      {expanded && <div role="group">{node.children?.map((child) => <ExplorerRow key={child.id} node={child} depth={depth + 1} forceExpanded={forceExpanded} assetsByPath={assetsByPath} selectedAssetId={selectedAssetId} onToggle={onToggle} onImport={onImport} onStage={onStage} onSelect={onSelect} />)}
      {node.children?.length === 0 && <div className="empty-directory" style={{ paddingLeft: 31 + depth * 15 }}>空のフォルダ</div>}</div>}
    </div>;
  }
  const asset = assetsByPath.get(node.path);
  const supported = isSupported(node.name);
  return <button data-asset-id={asset?.id} role="treeitem" className={`media-tree-row file-row media-card ${asset?.id === selectedAssetId ? "selected" : ""} ${supported ? "" : "unsupported"}`} style={{ paddingLeft: 25 + depth * 15 }} draggable={supported} aria-label={node.name} title={supported ? node.path : "未対応のファイル形式"} onClick={() => { if (asset?.fileStatus === "ready") onSelect(asset.id); else void onImport(node); }} onDragStart={(event) => {
    if (asset?.fileStatus === "ready") { setAssetDragData(event.dataTransfer, asset.id); return; }
    const handle = node.handle?.kind === "file" ? node.handle : undefined;
    onStage(node.path, node.file, handle);
    setExplorerDragData(event.dataTransfer, node.path);
  }}>
    <FileKindIcon name={node.name} asset={asset} /><span>{node.name}</span><small className={asset?.fileStatus && asset.fileStatus !== "ready" ? "media-file-status" : ""}>{asset?.fileStatus === "loading" ? "読込中" : asset?.fileStatus === "permission-required" || asset?.fileStatus === "missing" ? "再接続" : asset?.width ? `${asset.width} × ${asset.height}` : extensionLabel(node.name)}</small>
  </button>;
}

function AssetRow({ asset, depth, selected, onSelect, onRestore }: { asset: MediaAsset; depth: number; selected: boolean; onSelect: (id: string | null) => void; onRestore: (id?: string) => Promise<void> }) {
  const unavailable = asset.fileStatus === "permission-required" || asset.fileStatus === "missing";
  return <button data-asset-id={asset.id} className={`media-tree-row file-row media-card ${selected ? "selected" : ""}`} style={{ paddingLeft: 25 + depth * 15 }} draggable={asset.fileStatus === "ready" || !asset.handle} onClick={() => { onSelect(asset.id); if (unavailable) void onRestore(asset.id); }} onDragStart={(event) => setAssetDragData(event.dataTransfer, asset.id)}>
    <KindIcon kind={asset.kind} /><span>{asset.name}</span><small className={asset.fileStatus && asset.fileStatus !== "ready" ? "media-file-status" : ""}>{asset.fileStatus === "loading" ? "読込中" : unavailable ? "再接続" : asset.width ? `${asset.width} × ${asset.height}` : extensionLabel(asset.name)}</small>
  </button>;
}

function FileKindIcon({ name, asset }: { name: string; asset?: MediaAsset }) {
  if (asset) return <KindIcon kind={asset.kind} />;
  const extension = extensionLabel(name).toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "hdr", "exr"].includes(extension)) return <FileImage />;
  if (["wav", "mp3", "aac", "flac"].includes(extension)) return <AudioLines />;
  if (extension === "glb") return <Box />;
  return supportedExtension(extension) ? <FileVideo /> : <File />;
}

async function readDirectory(handle: FileSystemDirectoryHandle, parentPath: string) {
  const entries: ExplorerNode[] = [];
  for await (const entry of handle.values()) {
    const path = `${parentPath}/${entry.name}`;
    entries.push({ id: path, name: entry.name, path, kind: entry.kind, handle: entry, expanded: false });
  }
  return sortNodes(entries);
}

function createRootNode(handle: FileSystemDirectoryHandle, accessRequired: boolean): ExplorerNode {
  return { id: `root:${handle.name}`, name: handle.name, path: handle.name, kind: "directory", handle, expanded: true, accessRequired };
}

function updateNode(node: ExplorerNode, id: string, updater: (node: ExplorerNode) => ExplorerNode): ExplorerNode {
  if (node.id === id) return updater(node);
  if (!node.children) return node;
  const children = node.children.map((child) => updateNode(child, id, updater));
  return children.some((child, index) => child !== node.children![index]) ? { ...node, children } : node;
}

function findNode(node: ExplorerNode, id: string | null): ExplorerNode | undefined {
  if (!id) return undefined;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function findNodeTrail(node: ExplorerNode, id: string): ExplorerNode[] {
  if (node.id === id) return [node];
  for (const child of node.children ?? []) {
    const trail = findNodeTrail(child, id);
    if (trail.length) return [node, ...trail];
  }
  return [];
}

function filterTree(node: ExplorerNode, query: string): ExplorerNode | null {
  if (!query) return node;
  const children = node.children?.map((child) => filterTree(child, query)).filter((child): child is ExplorerNode => Boolean(child));
  if (node.name.toLowerCase().includes(query) || children?.length) return { ...node, children: children ?? node.children, expanded: true };
  return null;
}

function buildFallbackTree(files: File[]) {
  const firstPath = files[0]?.webkitRelativePath || files[0]?.name || "選択フォルダ";
  const rootName = firstPath.split("/")[0] || "選択フォルダ";
  const root: ExplorerNode = { id: `fallback:${rootName}`, name: rootName, path: rootName, kind: "directory", expanded: true, children: [] };
  for (const file of files) {
    const rawParts = (file.webkitRelativePath || `${rootName}/${file.name}`).split("/").filter(Boolean);
    const parts = rawParts[0] === rootName ? rawParts.slice(1) : rawParts;
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const path = `${parent.path}/${part}`;
      let directory = parent.children!.find((child) => child.kind === "directory" && child.name === part);
      if (!directory) {
        directory = { id: path, name: part, path, kind: "directory", expanded: false, children: [] };
        parent.children!.push(directory);
      }
      parent = directory;
    }
    const name = parts.at(-1) ?? file.name;
    const path = `${parent.path}/${name}`;
    parent.children!.push({ id: path, name, path, kind: "file", file });
  }
  sortTree(root);
  return root;
}

function sortTree(node: ExplorerNode) { if (node.children) { node.children = sortNodes(node.children); node.children.forEach(sortTree); } }
function sortNodes(nodes: ExplorerNode[]) { return nodes.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, "ja", { numeric: true })); }

function pickDirectoryFiles() {
  return new Promise<File[]>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.onchange = () => input.files?.length ? resolve([...input.files]) : reject(new DOMException("No directory", "AbortError"));
    input.click();
  });
}

async function queryDirectoryPermission(handle: FileSystemDirectoryHandle) {
  const permissionHandle = handle as FileSystemDirectoryHandle & { queryPermission?: (options: { mode: "read" }) => Promise<PermissionState> };
  return permissionHandle.queryPermission ? permissionHandle.queryPermission({ mode: "read" }) : "prompt";
}

async function requestDirectoryPermission(handle: FileSystemDirectoryHandle) {
  const permissionHandle = handle as FileSystemDirectoryHandle & { requestPermission?: (options: { mode: "read" }) => Promise<PermissionState> };
  return permissionHandle.requestPermission ? permissionHandle.requestPermission({ mode: "read" }) : "prompt";
}

function setAssetDragData(dataTransfer: DataTransfer, assetId: string) { dataTransfer.clearData(); dataTransfer.effectAllowed = "copy"; dataTransfer.setData("application/x-gfxutl-asset", assetId); dataTransfer.setData("text/plain", assetId); }
function setExplorerDragData(dataTransfer: DataTransfer, path: string) { dataTransfer.clearData(); dataTransfer.effectAllowed = "copy"; dataTransfer.setData("application/x-gfxutl-path", path); dataTransfer.setData("text/plain", path); }
function supportedExtension(extension: string) { return SUPPORTED_EXTENSIONS.has(extension); }
function isSupported(name: string) { return supportedExtension(extensionLabel(name).toLowerCase()); }
function isBrowserPreviewImage(name: string) { return ["png", "jpg", "jpeg", "webp"].includes(extensionLabel(name).toLowerCase()); }
function extensionLabel(name: string) { return name.includes(".") ? name.split(".").pop()!.toUpperCase() : "FILE"; }
function formatDuration(value: number) { return `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, "0")}`; }
function formatBytes(value: number) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; }
