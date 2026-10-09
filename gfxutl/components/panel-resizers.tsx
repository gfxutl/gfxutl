import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { EditorLayout } from "../core/interface";
import { useEditor } from "../core/interface";

type ResizeKey = keyof EditorLayout;

const labels: Record<ResizeKey, string> = {
  leftPanelWidth: "メディアパネルの幅",
  rightPanelWidth: "インスペクタの幅",
  timelineHeight: "タイムラインの高さ",
};

export function PanelResizers() {
  const { state, controller } = useEditor();

  const clampSize = (key: ResizeKey, value: number) => {
    if (key === "timelineHeight") {
      return Math.max(190, Math.min(value, Math.min(520, window.innerHeight - 300)));
    }
    const other = key === "leftPanelWidth" ? state.layout.rightPanelWidth : state.layout.leftPanelWidth;
    return Math.max(210, Math.min(value, Math.min(460, window.innerWidth - other - 520)));
  };

  const beginResize = (key: ResizeKey, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startValue = state.layout[key];
    const orientation = key === "timelineHeight" ? "ns" : "ew";
    document.body.classList.add("is-resizing", `is-resizing-${orientation}`);

    const move = (pointer: PointerEvent) => {
      const delta = key === "timelineHeight"
        ? startY - pointer.clientY
        : key === "rightPanelWidth"
          ? startX - pointer.clientX
          : pointer.clientX - startX;
      controller.setLayout({ [key]: Math.round(clampSize(key, startValue + delta)) });
    };
    const end = () => {
      document.body.classList.remove("is-resizing", `is-resizing-${orientation}`);
      controller.setLayout({}, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const nudge = (key: ResizeKey, event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    const signedDirection = key === "rightPanelWidth" && (event.key === "ArrowLeft" || event.key === "ArrowRight") ? -direction : direction;
    controller.setLayout({ [key]: clampSize(key, state.layout[key] + signedDirection * 8) }, true);
  };

  const splitter = (key: ResizeKey, orientation: "vertical" | "horizontal") => (
    <div
      className={`panel-resizer resizer-${key}`}
      role="separator"
      aria-label={labels[key]}
      aria-orientation={orientation}
      aria-valuenow={state.layout[key]}
      tabIndex={0}
      onPointerDown={(event) => beginResize(key, event)}
      onDoubleClick={() => controller.resetLayout(key)}
      onKeyDown={(event) => nudge(key, event)}
    />
  );

  return (
    <>
      {splitter("leftPanelWidth", "vertical")}
      {splitter("rightPanelWidth", "vertical")}
      {splitter("timelineHeight", "horizontal")}
    </>
  );
}
