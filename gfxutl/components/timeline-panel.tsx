import { memo, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useEditor } from "../core/interface";
import type { TimelineClip } from "../core/interface";

const MIN_WORKSPACE_HEIGHT = 720;
const BASE_PX_PER_SECOND = 26;
const MIN_CLIP_WIDTH = 34;
const TITLE_CLIP_HEIGHT = 24;
const MEDIA_CLIP_HEIGHT = 32;

function clipHeight(clip: TimelineClip) {
  return clip.kind === "title" ? TITLE_CLIP_HEIGHT : MEDIA_CLIP_HEIGHT;
}

export function TimelinePanel() {
  const { state, controller } = useEditor();
  const pxPerSecond = BASE_PX_PER_SECOND * state.zoom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropPoint, setDropPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [cursorGuideX, setCursorGuideX] = useState<number | null>(null);
  const workspaceHeight = useMemo(() => Math.max(MIN_WORKSPACE_HEIGHT, ...state.clips.map((clip) => clip.y + 80)), [state.clips]);
  const workspaceWidth = state.duration * pxPerSecond + 160;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const zoomAtPointer = (event: WheelEvent) => {
      // Browsers expose a trackpad pinch as a ctrlKey WheelEvent. A physical
      // mouse reaches the same path only while the user is holding Ctrl.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const timeAtPointer = (scroll.scrollLeft + pointerX) / (BASE_PX_PER_SECOND * state.zoom);
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const nextZoom = Math.max(0.6, Math.min(2.4, state.zoom * Math.exp(-delta * 0.0025)));
      if (nextZoom === state.zoom) return;
      controller.setZoom(nextZoom);
      requestAnimationFrame(() => {
        scroll.scrollLeft = Math.max(0, timeAtPointer * BASE_PX_PER_SECOND * nextZoom - pointerX);
      });
    };
    scroll.addEventListener("wheel", zoomAtPointer, { passive: false });
    return () => scroll.removeEventListener("wheel", zoomAtPointer);
  }, [controller, state.zoom]);

  const positionFromPointer = (clientX: number, clientY: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return { time: 0, y: 0 };
    const rect = scroll.getBoundingClientRect();
    return {
      time: Math.max(0, (clientX - rect.left + scroll.scrollLeft) / pxPerSecond),
      y: Math.max(0, clientY - rect.top + scroll.scrollTop),
    };
  };

  const beginSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".timeline-clip")) return;
    event.preventDefault();
    const origin = positionFromPointer(event.clientX, event.clientY);
    const originX = origin.time * pxPerSecond;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const baseSelection = additive ? [...state.selectedClipIds] : [];
    let dragged = false;
    const move = (pointer: PointerEvent) => {
      const point = positionFromPointer(pointer.clientX, pointer.clientY);
      const x = point.time * pxPerSecond;
      if (!dragged && Math.hypot(pointer.clientX - event.clientX, pointer.clientY - event.clientY) < 4) return;
      dragged = true;
      const box = { left: Math.min(originX, x), top: Math.min(origin.y, point.y), width: Math.abs(x - originX), height: Math.abs(point.y - origin.y) };
      setSelectionBox(box);
      const ids = state.clips.filter((clip) => {
        const left = clip.start * pxPerSecond;
        const right = left + Math.max(MIN_CLIP_WIDTH, clip.duration * pxPerSecond);
        const bottom = clip.y + clipHeight(clip);
        return left <= box.left + box.width && right >= box.left && clip.y <= box.top + box.height && bottom >= box.top;
      }).map((clip) => clip.id);
      controller.selectClips([...new Set([...baseSelection, ...ids])]);
    };
    const end = () => {
      if (!dragged) {
        controller.setTime(origin.time);
        if (!additive) controller.selectClips([]);
      }
      setSelectionBox(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const dragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const point = positionFromPointer(event.clientX, event.clientY);
    setDropPoint({ x: point.time * pxPerSecond, y: point.y });
  };

  const dropAsset = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData("application/x-gfxutl-asset") || event.dataTransfer.getData("text/plain");
    const point = positionFromPointer(event.clientX, event.clientY);
    setDropPoint(null);
    if (assetId) controller.addAssetToTimeline(assetId, point.time, point.y);
  };

  return (
    <section className="timeline-panel panel">
      <div className="timeline-scroll free-timeline-scroll" ref={scrollRef}>
        <div
          className={`timeline-workspace ${dropPoint ? "drop-active" : ""}`}
          style={{ width: workspaceWidth, height: workspaceHeight }}
          onPointerDown={beginSelection}
          onMouseMove={(event) => setCursorGuideX(positionFromPointer(event.clientX, event.clientY).time * pxPerSecond)}
          onMouseLeave={() => setCursorGuideX(null)}
          onDragOver={dragOver}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPoint(null); }}
          onDrop={dropAsset}
          onContextMenu={(event) => {
            event.preventDefault();
            const point = positionFromPointer(event.clientX, event.clientY);
            controller.openContextMenu({ x: event.clientX, y: event.clientY, scope: "timeline", time: point.time, timelineY: point.y, positionX: 0, positionY: 0 });
          }}
        >
          {dropPoint && <div className="asset-drop-ghost" style={{ left: dropPoint.x, top: dropPoint.y }}><span>ここに配置</span></div>}
          {cursorGuideX !== null && <div className="timeline-cursor-guide" style={{ left: cursorGuideX }} />}
          {selectionBox && <div className="timeline-selection-box" style={selectionBox} />}
          {state.clips.map((clip) => <Clip key={clip.id} clip={clip} pxPerSecond={pxPerSecond} selected={state.selectedClipIds.includes(clip.id)} fps={state.fps} snapEnabled={state.snapEnabled} controller={controller} />)}
          <div className="playhead free-playhead" style={{ left: state.currentTime * pxPerSecond }}><div className="playhead-cap" /><i /></div>
        </div>
      </div>
    </section>
  );
}

const Clip = memo(function Clip({ clip, pxPerSecond, selected, fps, snapEnabled, controller }: { clip: TimelineClip; pxPerSecond: number; selected: boolean; fps: number; snapEnabled: boolean; controller: typeof import("../core/interface").editorController }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originalStart: number; originalY: number; lastStart: number; lastY: number } | null>(null);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originalStart: clip.start, originalY: clip.y, lastStart: clip.start, lastY: clip.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.shiftKey || event.ctrlKey || event.metaKey) controller.selectClip(clip.id, true);
    else if (!selected) controller.selectClip(clip.id);
    setDragging(true);
  };

  const dragClip = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const rawStart = active.originalStart + (event.clientX - active.startX) / pxPerSecond;
    active.lastStart = Math.max(0, !snapEnabled || event.shiftKey ? rawStart : Math.round(rawStart * fps) / fps);
    active.lastY = Math.max(0, active.originalY + event.clientY - active.startY);
    controller.moveClip(clip.id, active.lastStart, active.lastY);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    controller.moveClip(clip.id, active.lastStart, active.lastY);
    drag.current = null;
    setDragging(false);
  };

  return (
    <button
      className={`timeline-clip free-clip clip-${clip.kind} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      onPointerDown={beginDrag}
      onPointerMove={dragClip}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!selected) controller.selectClip(clip.id);
        const rect = event.currentTarget.getBoundingClientRect();
        const time = clip.start + Math.min(clip.duration, Math.max(0, (event.clientX - rect.left) / pxPerSecond));
        controller.openContextMenu({ x: event.clientX, y: event.clientY, scope: "clip", time, timelineY: clip.y, positionX: clip.positionX ?? 0, positionY: clip.positionY ?? 0 });
      }}
      style={{ left: clip.start * pxPerSecond, top: clip.y, width: Math.max(MIN_CLIP_WIDTH, clip.duration * pxPerSecond), height: clipHeight(clip), zIndex: dragging ? 30_000 : Math.max(1, 10_000 - Math.round(clip.y)), "--clip-color": clip.color } as React.CSSProperties}
    >
      {dragging && <output className="clip-drag-readout">{clip.start.toFixed(2)}s · y {Math.round(clip.y)}</output>}
      <span>{clip.kind === "title" ? "T" : clip.kind === "audio" ? "♫" : clip.kind === "object" ? "◆" : "◈"}</span><strong>{clip.name}</strong>
      {(clip.keyframes ?? []).map((keyframe) => <i className="timeline-keyframe" key={keyframe.id} title={`${keyframe.property}: ${keyframe.value}`} style={{ left: `${Math.max(0, Math.min(100, keyframe.time / Math.max(0.001, clip.duration) * 100))}%` }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); controller.setTime(clip.start + keyframe.time); controller.selectClip(clip.id); }} />)}
      {clip.kind === "audio" && <div className="waveform">{Array.from({ length: Math.max(10, Math.floor(clip.duration * 3)) }, (_, i) => <i key={i} style={{ height: `${16 + ((i * 17 + 9) % 70)}%` }} />)}</div>}
      {clip.kind === "video" && <div className="frame-strip">{Array.from({ length: Math.max(3, Math.floor(clip.duration / 3)) }, (_, i) => <i key={i} />)}</div>}
    </button>
  );
}, (previous, next) => previous.clip === next.clip
  && previous.pxPerSecond === next.pxPerSecond
  && previous.selected === next.selected
  && previous.fps === next.fps
  && previous.snapEnabled === next.snapEnabled);
