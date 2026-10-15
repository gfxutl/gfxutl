import {
  AlignCenterHorizontal16Regular as AlignCenterHorizontal,
  AlignCenterVertical16Regular as AlignCenterVertical,
  ArrowDown16Regular as ArrowDown,
  ArrowRedo16Regular as Redo2,
  ArrowUndo16Regular as Undo2,
  ArrowUp16Regular as ArrowUp,
  Circle16Regular as Circle,
  ChevronDoubleDown16Regular as ChevronDoubleDown,
  ChevronDoubleUp16Regular as ChevronDoubleUp,
  ChevronRight16Regular as ChevronRight,
  Clipboard16Regular as Clipboard,
  ClipboardPaste16Regular as ClipboardPaste,
  Copy16Regular as Copy,
  Cube16Regular as Box,
  Cut16Regular as Scissors,
  Delete16Regular as Trash2,
  Flag16Regular as Flag,
  FolderList16Regular as FolderTree,
  LayerDiagonal16Regular as Layers,
  Pentagon20Regular as Pentagon,
  Sparkle16Regular as Sparkles,
  Target16Regular as Magnet,
  TextFont16Regular as Type,
} from "@fluentui/react-icons";
import { useEffect, type MouseEvent } from "react";
import { useEditor } from "../core/interface";

export function EditorContextMenu() {
  const { state, controller } = useEditor();
  const menu = state.contextMenu;

  useEffect(() => {
    const close = () => controller.closeContextMenu();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "c") { event.preventDefault(); void controller.copySelection(); }
      if (event.key.toLowerCase() === "x") { event.preventDefault(); void controller.cutSelection(); }
      if (event.key.toLowerCase() === "v") { event.preventDefault(); void controller.pasteFromClipboard(); }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [controller]);

  if (!menu) return null;
  const targetMarker = menu.markerId ? state.markers.find((marker) => marker.id === menu.markerId) : undefined;
  const placement = { time: menu.time, timelineY: menu.timelineY, positionX: menu.positionX, positionY: menu.positionY };
  const hasPreviewSelection = state.clips.some((clip) => state.selectedClipIds.includes(clip.id) && clip.kind !== "audio" && clip.kind !== "group");
  const menuLeft = Math.min(menu.x, window.innerWidth - 224);
  const submenuOpensLeft = menuLeft + 440 > window.innerWidth;
  const run = (event: MouseEvent, action: () => void | Promise<unknown>) => {
    event.stopPropagation();
    void action();
  };
  return <div
    className={`editor-context-menu${submenuOpensLeft ? " submenu-opens-left" : ""}`}
    role="menu"
    aria-label="編集メニュー"
    style={{ left: menuLeft, top: Math.max(4, Math.min(menu.y, window.innerHeight - 396)) }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    <div className="context-menu-label"><Clipboard /> 編集</div>
    <div className="context-menu-action-row context-menu-action-row-two" role="group" aria-label="履歴操作">
      <button role="menuitem" aria-keyshortcuts="Meta+Z Control+Z" title="元に戻す (⌘Z)" disabled={!state.canUndo} onClick={(event) => run(event, () => { controller.undo(); controller.closeContextMenu(); })}><Undo2 /><span>元に戻す</span></button>
      <button role="menuitem" aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z" title="やり直す (⇧⌘Z)" disabled={!state.canRedo} onClick={(event) => run(event, () => { controller.redo(); controller.closeContextMenu(); })}><Redo2 /><span>やり直す</span></button>
    </div>
    <div className="context-menu-action-row context-menu-action-row-three" role="group" aria-label="クリップボード操作">
      <button role="menuitem" aria-keyshortcuts="Meta+X Control+X" title="切り取り (⌘X)" disabled={!state.selectedClipId} onClick={(event) => run(event, async () => { await controller.cutSelection(); controller.closeContextMenu(); })}><Scissors /><span>切り取り</span></button>
      <button role="menuitem" aria-keyshortcuts="Meta+C Control+C" title="コピー (⌘C)" disabled={!state.selectedClipId} onClick={(event) => run(event, async () => { await controller.copySelection(); controller.closeContextMenu(); })}><Copy /><span>コピー</span></button>
      <button role="menuitem" aria-keyshortcuts="Meta+V Control+V" title="貼り付け (⌘V)" onClick={(event) => run(event, () => controller.pasteFromClipboard())}><ClipboardPaste /><span>貼り付け</span></button>
    </div>
    {(menu.scope === "timeline" || menu.scope === "clip") && <>
      <div className="context-menu-separator" />
      <div className="context-menu-label">タイムライン</div>
      <button role="menuitem" disabled={!state.selectedClipIds.length} onClick={(event) => run(event, () => { controller.splitSelectionAt(menu.time); controller.closeContextMenu(); })}><Scissors />カット<kbd>{menu.time.toFixed(2)}s</kbd></button>
      {targetMarker
        ? <button role="menuitem" onClick={(event) => run(event, () => { controller.removeMarker(targetMarker.id); controller.closeContextMenu(); })}><Trash2 />このマーカーを削除</button>
        : <button role="menuitem" onClick={(event) => run(event, () => { controller.addMarker(menu.time); controller.closeContextMenu(); })}><Flag />マーカーを追加<kbd>M</kbd></button>}
      <button role="menuitemcheckbox" aria-checked={state.snapEnabled} className={state.snapEnabled ? "checked" : ""} onClick={(event) => run(event, () => { controller.toggleSnap(); controller.closeContextMenu(); })}><Magnet />マグネット<kbd>{state.snapEnabled ? "ON" : "OFF"}</kbd></button>
    </>}
    <div className="context-menu-separator" />
    <div className="context-menu-submenu">
      <button role="menuitem" aria-haspopup="menu"><Sparkles /><span>新規</span><ChevronRight className="context-menu-chevron" /></button>
      <div className="context-menu-submenu-panel" role="menu" aria-label="新規オブジェクト">
        <button role="menuitem" onClick={(event) => run(event, () => controller.addGroupObject(placement))}><FolderTree />グループ</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.addText2DObject(placement))}><Type />2D Text</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.addText3DObject(placement))}><Type />3D Text</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.addGeometryObject("shape", placement))}><Pentagon />シェイプ</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.addGeometryObject("box", placement))}><Box />立方体</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.addGeometryObject("sphere", placement))}><Circle />球体</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.addParticleObject(placement))}><Sparkles />GPUパーティクル</button>
      </div>
    </div>
    {menu.scope === "preview" && <div className="context-menu-submenu">
      <button role="menuitem" aria-haspopup="menu" disabled={!hasPreviewSelection}><Layers /><span>配置</span><ChevronRight className="context-menu-chevron" /></button>
      {hasPreviewSelection && <div className="context-menu-submenu-panel" role="menu" aria-label="配置">
        <button role="menuitem" onClick={(event) => run(event, () => controller.arrangePreviewSelection("front"))}><ChevronDoubleUp />最前面に配置</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.arrangePreviewSelection("forward"))}><ArrowUp />前面に配置</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.arrangePreviewSelection("backward"))}><ArrowDown />後面に配置</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.arrangePreviewSelection("back"))}><ChevronDoubleDown />最後面に配置</button>
        <div className="context-menu-separator" />
        <button role="menuitem" onClick={(event) => run(event, () => controller.centerPreviewSelection("both"))}><AlignCenterHorizontal />上下左右中央に配置</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.centerPreviewSelection("vertical"))}><AlignCenterHorizontal />上下中央に配置</button>
        <button role="menuitem" onClick={(event) => run(event, () => controller.centerPreviewSelection("horizontal"))}><AlignCenterVertical />左右中央に配置</button>
      </div>}
    </div>}
  </div>;
}
