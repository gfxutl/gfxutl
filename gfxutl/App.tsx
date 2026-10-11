import { InspectorPanel } from "./components/inspector-panel";
import { MediaPanel } from "./components/media-panel";
import { PreviewPanel } from "./components/preview-panel";
import { StatusBar } from "./components/status-bar";
import { TimelinePanel } from "./components/timeline-panel";
import { PanelResizers } from "./components/panel-resizers";
import { useEditor } from "./core/interface";
import { useEffect } from "react";
import { EditorContextMenu } from "./components/editor-context-menu";

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
    const controlKeyboard = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) controller.togglePlayback();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
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
