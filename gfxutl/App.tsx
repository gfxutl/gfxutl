import { InspectorPanel } from "./components/inspector-panel";
import { MediaPanel } from "./components/media-panel";
import { PreviewPanel } from "./components/preview-panel";
import { StatusBar } from "./components/status-bar";
import { TimelinePanel } from "./components/timeline-panel";
import { PanelResizers } from "./components/panel-resizers";
import { useEditor } from "./core/interface";
import { useEffect } from "react";
import { EditorContextMenu } from "./components/editor-context-menu";
import { observeWindowControlsOverlay } from "./core/interface/window-controls-overlay";

export function App() {
  const { state, controller } = useEditor();
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
    const controlKeyboard = (event: KeyboardEvent) => {
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
  return (
    <>
      <MediaPanel />
      <PreviewPanel />
      <InspectorPanel />
      <TimelinePanel />
      <StatusBar />
      <PanelResizers />
      <EditorContextMenu />
      {state.notice && <div className="toast" role="status"><span />{state.notice}</div>}
    </>
  );
}
