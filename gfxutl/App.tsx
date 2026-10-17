import { InspectorPanel } from "./components/inspector-panel";
import { MediaPanel } from "./components/media-panel";
import { PreviewPanel } from "./components/preview-panel";
import { StatusBar } from "./components/status-bar";
import { TimelinePanel } from "./components/timeline-panel";
import { PanelResizers } from "./components/panel-resizers";
import { shallowEqual, useEditor } from "./core/interface";
import { lazy, Suspense, useEffect } from "react";
import { EditorContextMenu } from "./components/editor-context-menu";
import { observeWindowControlsOverlay } from "./core/interface/window-controls-overlay";
import { useI18n } from "./core/i18n";
import { Button } from "./components/ui/button";
import { resolvePreviewTabShortcut } from "./core/interface/preview-tab-shortcut";

const ShaderGraphPanel = lazy(() => import("./components/shader-graph-panel").then((module) => ({ default: module.ShaderGraphPanel })));

export function App() {
  const { state, controller } = useEditor((value) => ({
    activeBottomPane: value.activeBottomPane,
    dialog: value.dialog,
    layout: value.layout,
    notice: value.notice,
    projectDirty: value.projectDirty,
    projectName: value.projectName,
  }), shallowEqual);
  const { t } = useI18n();
  useEffect(() => {
    const root = document.getElementById("main");
    if (!root) return;
    root.style.setProperty("--left-w", `${state.layout.leftPanelWidth}px`);
    root.style.setProperty("--right-w", `${state.layout.rightPanelWidth}px`);
    root.style.setProperty("--timeline-h", `${state.layout.timelineHeight}px`);
  }, [state.layout]);
  useEffect(() => {
    const root = document.getElementById("main");
    return root ? observeWindowControlsOverlay(root) : undefined;
  }, []);
  useEffect(() => {
    document.title = `${state.projectDirty ? "• " : ""}${state.projectName} — GfxUtl`;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.projectDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [state.projectDirty, state.projectName]);
  useEffect(() => {
    const controlKeyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const snapshot = controller.getSnapshot();
        const previewTabShortcut = resolvePreviewTabShortcut(
          event,
          snapshot.previewClipTabs.filter((id) => snapshot.clips.some((clip) => clip.id === id)),
        );
        if (previewTabShortcut) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) {
            if (previewTabShortcut.kind === "view") controller.setPreviewView(previewTabShortcut.view);
            else controller.setPreviewTab(previewTabShortcut.clipId);
          }
          return;
        }
      }
      const target = event.target as HTMLElement | null;
      const editingText = Boolean(target?.closest(
        "input, textarea, select, [role='textbox'], [role='combobox'], [role='listbox'], [contenteditable]:not([contenteditable='false'])",
      ));
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z" && !editingText) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) controller.redo();
        else controller.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "y" && !editingText) {
        event.preventDefault();
        event.stopPropagation();
        controller.redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a" && !editingText) {
        event.preventDefault();
        event.stopPropagation();
        controller.selectAllClips();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "d" && !editingText) {
        event.preventDefault();
        event.stopPropagation();
        controller.duplicateSelection();
        return;
      }
      if (!editingText && (event.key === "Delete" || event.key === "Backspace")) {
        if (!controller.getSnapshot().selectedClipIds.length && !controller.getSnapshot().selectedClipId) return;
        event.preventDefault();
        event.stopPropagation();
        controller.removeSelection();
        return;
      }
      if (!editingText && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        controller.addMarker();
        return;
      }
      if (!editingText && event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) controller.togglePlayback();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (editingText) return;
      if (!controller.getSnapshot().selectedClipIds.length && !controller.getSnapshot().selectedClipId) return;
      event.preventDefault();
      event.stopPropagation();
      controller.nudgeSelectedClips(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", controlKeyboard, { capture: true });
    return () => window.removeEventListener("keydown", controlKeyboard, { capture: true });
  }, [controller]);
  const dialog = state.dialog;
  const dialogMessage = dialog?.kind === "new-project"
    ? t("現在の編集内容を閉じて新規プロジェクトを作成しますか？")
    : dialog?.kind === "rename-marker"
      ? t("マーカー名")
      : "";
  const confirmLabel = dialog?.kind === "new-project"
    ? t("新規作成")
    : t("変更");
  return (
    <>
      <MediaPanel />
      <PreviewPanel />
      <InspectorPanel />
      {state.activeBottomPane === "timeline" ? <TimelinePanel /> : <Suspense fallback={null}><ShaderGraphPanel /></Suspense>}
      <StatusBar />
      <PanelResizers />
      <EditorContextMenu />
      {(state.notice || dialog) && <div className="notification-region">
        {state.notice && <div className="toast" role="status"><span />{t(state.notice)}</div>}
        {dialog && <form
          className="app-dialog"
          role="dialog"
          aria-modal="false"
          aria-label={dialogMessage}
          onSubmit={(event) => { event.preventDefault(); controller.confirmDialog(); }}
        >
          <label>
            <span>{dialogMessage}</span>
            {dialog.kind === "rename-marker" && <input autoFocus aria-label={t("マーカー名")} value={dialog.value} onChange={(event) => controller.updateDialogValue(event.target.value)} />}
          </label>
          <div className="app-dialog-actions">
            <Button size="sm" variant="ghost" onClick={controller.dismissDialog}>{t("キャンセル")}</Button>
            <Button size="sm" type="submit">{confirmLabel}</Button>
          </div>
        </form>}
      </div>}
    </>
  );
}
