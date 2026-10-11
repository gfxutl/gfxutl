import { Box, Clipboard, ClipboardPaste, Copy, Flag, FolderTree, Magnet, Scissors, Sparkles, Type, Circle, Undo2, Redo2, Pentagon } from "lucide-react";
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
  const placement = { time: menu.time, timelineY: menu.timelineY, positionX: menu.positionX, positionY: menu.positionY };
  const run = (event: MouseEvent, action: () => void | Promise<unknown>) => {
    event.stopPropagation();
    void action();
  };
  return <div
    className="editor-context-menu"
    role="menu"
    aria-label="編集メニュー"
    style={{ left: Math.min(menu.x, window.innerWidth - 224), top: Math.max(4, Math.min(menu.y, window.innerHeight - 370)) }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    <div className="context-menu-label"><Clipboard /> 編集</div>
    <button role="menuitem" disabled={!state.canUndo} onClick={(event) => run(event, () => { controller.undo(); controller.closeContextMenu(); })}><Undo2 />元に戻す<kbd>⌘Z</kbd></button>
    <button role="menuitem" disabled={!state.canRedo} onClick={(event) => run(event, () => { controller.redo(); controller.closeContextMenu(); })}><Redo2 />やり直す<kbd>⇧⌘Z</kbd></button>
    <button role="menuitem" disabled={!state.selectedClipId} onClick={(event) => run(event, async () => { await controller.cutSelection(); controller.closeContextMenu(); })}><Scissors />切り取り<kbd>⌘X</kbd></button>
    <button role="menuitem" disabled={!state.selectedClipId} onClick={(event) => run(event, async () => { await controller.copySelection(); controller.closeContextMenu(); })}><Copy />コピー<kbd>⌘C</kbd></button>
    <button role="menuitem" onClick={(event) => run(event, () => controller.pasteFromClipboard())}><ClipboardPaste />貼り付け<kbd>⌘V</kbd></button>
    {(menu.scope === "timeline" || menu.scope === "clip") && <>
      <div className="context-menu-separator" />
      <div className="context-menu-label">タイムライン</div>
      <button role="menuitem" disabled={!state.selectedClipIds.length} onClick={(event) => run(event, () => { controller.splitSelectionAt(menu.time); controller.closeContextMenu(); })}><Scissors />カット<kbd>{menu.time.toFixed(2)}s</kbd></button>
      <button role="menuitem" onClick={(event) => run(event, () => { controller.addMarker(menu.time); controller.closeContextMenu(); })}><Flag />マーカーを追加<kbd>M</kbd></button>
      <button role="menuitemcheckbox" aria-checked={state.snapEnabled} className={state.snapEnabled ? "checked" : ""} onClick={(event) => run(event, () => { controller.toggleSnap(); controller.closeContextMenu(); })}><Magnet />マグネット<kbd>{state.snapEnabled ? "ON" : "OFF"}</kbd></button>
    </>}
    <div className="context-menu-separator" />
    <div className="context-menu-label">オブジェクトを追加</div>
    <button role="menuitem" onClick={(event) => run(event, () => controller.addGroupObject(placement))}><FolderTree />グループ</button>
    <button role="menuitem" onClick={(event) => run(event, () => controller.addTextObject(placement))}><Type />テキスト</button>
    <button role="menuitem" onClick={(event) => run(event, () => controller.addGeometryObject("shape", placement))}><Pentagon />シェイプ</button>
    <button role="menuitem" onClick={(event) => run(event, () => controller.addGeometryObject("box", placement))}><Box />立方体</button>
    <button role="menuitem" onClick={(event) => run(event, () => controller.addGeometryObject("sphere", placement))}><Circle />球体</button>
    <button role="menuitem" onClick={(event) => run(event, () => controller.addParticleObject(placement))}><Sparkles />GPUパーティクル</button>
  </div>;
}
