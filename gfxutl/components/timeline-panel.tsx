import {
  ArrowRepeatAll16Regular as Repeat2,
  ChevronDoubleLeft16Regular as ChevronsLeft,
  ChevronDoubleRight16Regular as ChevronsRight,
  Cube16Regular,
  Eye16Regular as Eye,
  EyeOff16Regular as EyeOff,
  FolderList16Regular,
  FullScreenMaximize16Regular as Expand,
  MusicNote216Regular,
  Next16Regular as SkipForward,
  Open16Regular as ExternalLink,
  Pause16Regular as Pause,
  Play16Regular as Play,
  Previous16Regular as SkipBack,
  SpeakerMute16Regular as SpeakerMute,
  TextT12Regular,
  VideoClip16Regular,
} from "@fluentui/react-icons";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clampTimelineVerticalZoom, clampTimelineZoom, MIN_GROUP_HEIGHT, timelineClipHeight, timelineGroupDescendants, useEditor } from "../core/interface";
import type { MediaAsset, SceneKeyframe, TimelineClip } from "../core/interface";
import { useI18n } from "../core/i18n";

const MIN_WORKSPACE_HEIGHT = 720;
const BASE_PX_PER_SECOND = 26;
const MIN_CLIP_WIDTH = 34;
const TIME_RULER_HEIGHT = 24;
const TIMELINE_THUMBNAIL_WIDTH = 72;
const TIMELINE_THUMBNAIL_CACHE_LIMIT = 160;
const TIMELINE_THUMBNAIL_CONCURRENCY = 2;
const timelineThumbnailCache = new Map<string, Promise<HTMLCanvasElement>>();
const timelineThumbnailQueue: Array<() => Promise<void>> = [];
let activeTimelineThumbnailRequests = 0;
type GroupResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type TimelineEdge = "start" | "end";
interface AlignmentSuggestion {
  x: number;
  top: number;
  height: number;
  targetId: string;
  movingEdge: TimelineEdge;
  targetEdge: TimelineEdge;
}

interface CameraKeyframeGroup {
  time: number;
  keyframes: SceneKeyframe[];
}

function isVisualClip(clip: TimelineClip) {
  return clip.kind === "video" || clip.kind === "title" || clip.kind === "object";
}

function zoomAnchorScrollLeft(time: number, pointerX: number, zoom: number, duration: number, viewportWidth: number) {
  const desired = time * BASE_PX_PER_SECOND * zoom - pointerX;
  const maximum = Math.max(0, duration * BASE_PX_PER_SECOND * zoom + 160 - viewportWidth);
  return Math.max(0, Math.min(maximum, desired));
}

export function TimelinePanel() {
  const { state, controller } = useEditor();
  const { t } = useI18n();
  const pxPerSecond = BASE_PX_PER_SECOND * state.zoom;
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingZoomAnchorRef = useRef<{ zoom: number; time: number; pointerX: number } | null>(null);
  const pendingVerticalZoomAnchorRef = useRef<{ zoom: number; y: number; pointerY: number } | null>(null);
  const [dropPoint, setDropPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [cursorGuideX, setCursorGuideX] = useState<number | null>(null);
  const [alignmentSuggestion, setAlignmentSuggestion] = useState<AlignmentSuggestion | null>(null);
  const [timelineViewport, setTimelineViewport] = useState({ scrollLeft: 0, scrollTop: 0, width: 0, height: 0 });
  const resizableAssetIds = useMemo(() => new Set(state.assets.filter((asset) => asset.kind === "image").map((asset) => asset.id)), [state.assets]);
  const logicalWorkspaceHeight = useMemo(() => Math.max(...state.clips.map((clip) => clip.y + timelineClipHeight(clip) + 48), MIN_WORKSPACE_HEIGHT), [state.clips]);
  const workspaceHeight = Math.max(MIN_WORKSPACE_HEIGHT, logicalWorkspaceHeight * state.timelineVerticalZoom);
  const nestingDepths = useMemo(() => timelineNestingDepths(state.clips), [state.clips]);
  const orderedClips = useMemo(() => [...state.clips].sort((a, b) => {
    if (a.kind !== b.kind && (a.kind === "group" || b.kind === "group")) return a.kind === "group" ? -1 : 1;
    return (nestingDepths.get(a.id) ?? 0) - (nestingDepths.get(b.id) ?? 0);
  }), [nestingDepths, state.clips]);
  const cameraKeyframeGroups = useMemo(() => groupCameraKeyframes(state.background.scene.keyframes ?? [], state.fps), [state.background.scene.keyframes, state.fps]);
  const assetsById = useMemo(() => new Map(state.assets.map((asset) => [asset.id, asset])), [state.assets]);
  const workspaceWidth = state.duration * pxPerSecond + 160;

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const anchor = pendingZoomAnchorRef.current;
    if (!scroll || !anchor || anchor.zoom !== state.zoom) return;
    scroll.scrollLeft = zoomAnchorScrollLeft(anchor.time, anchor.pointerX, state.zoom, state.duration, scroll.clientWidth);
    pendingZoomAnchorRef.current = null;
  }, [state.duration, state.zoom]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const anchor = pendingVerticalZoomAnchorRef.current;
    if (!scroll || !anchor || anchor.zoom !== state.timelineVerticalZoom) return;
    const desired = anchor.y * state.timelineVerticalZoom + TIME_RULER_HEIGHT - anchor.pointerY;
    scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, desired));
    pendingVerticalZoomAnchorRef.current = null;
  }, [state.timelineVerticalZoom, workspaceHeight]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setTimelineViewport((current) => {
        const next = { scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop, width: scroll.clientWidth, height: scroll.clientHeight };
        return current.scrollLeft === next.scrollLeft && current.scrollTop === next.scrollTop && current.width === next.width && current.height === next.height ? current : next;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    const scroll = scrollRef.current;
    if (!panel || !scroll) return;
    const zoomAtPointer = (event: WheelEvent) => {
      if (event.shiftKey) {
        event.preventDefault();
        const rect = scroll.getBoundingClientRect();
        const pointerY = Math.max(0, Math.min(scroll.clientHeight, event.clientY - rect.top));
        const snapshot = controller.getSnapshot();
        const currentZoom = snapshot.timelineVerticalZoom;
        const pendingAnchor = pendingVerticalZoomAnchorRef.current;
        const currentScrollTop = pendingAnchor?.zoom === currentZoom
          ? Math.max(0, pendingAnchor.y * currentZoom + TIME_RULER_HEIGHT - pendingAnchor.pointerY)
          : scroll.scrollTop;
        const yAtPointer = Math.max(0, (currentScrollTop + pointerY - TIME_RULER_HEIGHT) / currentZoom);
        const wheelDelta = event.deltaY || event.deltaX;
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? wheelDelta * 16 : wheelDelta;
        const nextZoom = clampTimelineVerticalZoom(currentZoom * Math.exp(-delta * 0.0025));
        if (nextZoom === currentZoom) return;
        pendingVerticalZoomAnchorRef.current = { zoom: nextZoom, y: yAtPointer, pointerY };
        controller.setTimelineVerticalZoom(nextZoom);
        return;
      }
      // Browsers expose a trackpad pinch as a ctrlKey WheelEvent. A physical
      // mouse reaches the same path only while the user is holding Ctrl.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const pointerX = Math.max(0, Math.min(scroll.clientWidth, event.clientX - rect.left));
      const snapshot = controller.getSnapshot();
      const currentZoom = snapshot.zoom;
      const pendingAnchor = pendingZoomAnchorRef.current;
      const currentScrollLeft = pendingAnchor?.zoom === currentZoom
        ? zoomAnchorScrollLeft(pendingAnchor.time, pendingAnchor.pointerX, currentZoom, snapshot.duration, scroll.clientWidth)
        : scroll.scrollLeft;
      const timeAtPointer = (currentScrollLeft + pointerX) / (BASE_PX_PER_SECOND * currentZoom);
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const nextZoom = clampTimelineZoom(currentZoom * Math.exp(-delta * 0.0025));
      if (nextZoom === currentZoom) return;
      pendingZoomAnchorRef.current = { zoom: nextZoom, time: timeAtPointer, pointerX };
      controller.setZoom(nextZoom);
    };
    // Capture on the whole panel so pinch gestures that begin over an overlay
    // (including the transport pill) still control the timeline zoom.
    panel.addEventListener("wheel", zoomAtPointer, { passive: false, capture: true });
    return () => panel.removeEventListener("wheel", zoomAtPointer, { capture: true });
  }, [controller]);

  const positionFromPointer = (clientX: number, clientY: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return { time: 0, y: 0 };
    const rect = scroll.getBoundingClientRect();
    return {
      time: Math.max(0, (clientX - rect.left + scroll.scrollLeft) / pxPerSecond),
      y: Math.max(0, (clientY - rect.top + scroll.scrollTop - TIME_RULER_HEIGHT) / state.timelineVerticalZoom),
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
      setSelectionBox({ ...box, top: box.top * state.timelineVerticalZoom, height: box.height * state.timelineVerticalZoom });
      const ids = state.clips.filter((clip) => {
        const left = clip.start * pxPerSecond;
        const right = left + Math.max(MIN_CLIP_WIDTH, clip.duration * pxPerSecond);
        const bottom = clip.y + timelineClipHeight(clip);
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
    const assetId = event.dataTransfer.getData("application/x-gfxutl-asset");
    const explorerPath = event.dataTransfer.getData("application/x-gfxutl-path");
    const legacyAssetId = !assetId && !explorerPath ? event.dataTransfer.getData("text/plain") : "";
    const point = positionFromPointer(event.clientX, event.clientY);
    setDropPoint(null);
    if (assetId) controller.addAssetToTimeline(assetId, point.time, point.y);
    else if (explorerPath) void controller.addExplorerFileToTimeline(explorerPath, point.time, point.y);
    else if (legacyAssetId) controller.addAssetToTimeline(legacyAssetId, point.time, point.y);
  };

  const beginRulerScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const update = (clientX: number) => controller.setTime(Math.min(state.duration, positionFromPointer(clientX, event.clientY).time));
    update(event.clientX);
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) update(pointer.clientX);
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const addCameraKeyframeFromRuler = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    controller.addCameraKeyframe(Math.min(state.duration, positionFromPointer(event.clientX, event.clientY).time));
  };

  return (
    <section className="timeline-panel panel" ref={panelRef}>
      <div className="timeline-transport-pill" role="toolbar" aria-label={t("タイムライン再生コントロール")}>
        <time className="timeline-pill-clock timeline-pill-clock-compact" dateTime={`PT${Math.max(0, state.currentTime)}S`}>{formatClock(state.currentTime)}</time>
        <time className="timeline-pill-clock timeline-pill-clock-precise" dateTime={`PT${Math.max(0, state.currentTime)}S`}>{formatPreciseClock(state.currentTime)}</time>
        <div className="timeline-pill-expanded" onPointerUpCapture={(event) => (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.blur()}>
          <span className="timeline-pill-duration">/ {formatClock(state.duration)}</span>
          <i className="timeline-pill-divider" />
          <button type="button" title={t("先頭へ")} aria-label={t("先頭へ")} onClick={() => controller.setTime(0)}><SkipBack /></button>
          <button type="button" title={t("1フレーム戻る")} aria-label={t("1フレーム戻る")} onClick={() => controller.nudge(-1)}><ChevronsLeft /></button>
          <button type="button" className="play-button" title={t(state.playing ? "一時停止" : "再生")} aria-label={t(state.playing ? "一時停止" : "再生")} onClick={controller.togglePlayback}>{state.playing ? <Pause /> : <Play />}</button>
          <button type="button" title={t("1フレーム進む")} aria-label={t("1フレーム進む")} onClick={() => controller.nudge(1)}><ChevronsRight /></button>
          <button type="button" title={t("末尾へ")} aria-label={t("末尾へ")} onClick={() => controller.setTime(state.duration)}><SkipForward /></button>
          <i className="timeline-pill-divider" />
          <button type="button" className={state.loopPlayback ? "active" : ""} title={`${t("出力範囲をループ")} ${state.loopPlayback ? "ON" : "OFF"}`} aria-label={t("出力範囲をループ")} aria-pressed={state.loopPlayback} onClick={controller.toggleLoopPlayback}><Repeat2 /></button>
          <button type="button" title={t("別ウィンドウで表示")} aria-label={t("プレビューを別ウィンドウで表示")} onClick={() => requestPreviewAction("popout")}><ExternalLink /></button>
          <button type="button" title={t("フルスクリーン")} aria-label={t("プレビューをフルスクリーン表示")} onClick={() => requestPreviewAction("fullscreen")}><Expand /></button>
        </div>
      </div>
      <div className="timeline-scroll free-timeline-scroll" ref={scrollRef}>
        <div
          className={`timeline-workspace ${dropPoint ? "drop-active" : ""}`}
          style={{ width: workspaceWidth, height: workspaceHeight + TIME_RULER_HEIGHT, "--timeline-grid-y": `${26 * state.timelineVerticalZoom}px`, "--timeline-ruler-h": `${TIME_RULER_HEIGHT}px` } as React.CSSProperties}
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
          <TimelineRuler duration={state.duration} fps={state.fps} pxPerSecond={pxPerSecond} scrollLeft={timelineViewport.scrollLeft} viewportWidth={timelineViewport.width} cameraKeyframes={cameraKeyframeGroups} selectedCameraKeyframeIds={state.selectedCameraKeyframeIds} controller={controller} onPointerDown={beginRulerScrub} onDoubleClick={addCameraKeyframeFromRuler} />
          {cursorGuideX !== null && <div className="timeline-cursor-guide" style={{ left: cursorGuideX }} />}
          {state.markers.map((marker) => <button key={marker.id} className="timeline-marker" title={`${marker.label} · ${t("クリックで移動 / ダブルクリックで改名 / Shift+クリックで削除")}`} style={{ left: marker.time * pxPerSecond, "--marker-color": marker.color } as React.CSSProperties} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); const point = positionFromPointer(event.clientX, event.clientY); controller.openContextMenu({ x: event.clientX, y: event.clientY, scope: "timeline", time: marker.time, timelineY: point.y, positionX: 0, positionY: 0, markerId: marker.id }); }} onDoubleClick={(event) => { event.stopPropagation(); controller.openMarkerRenameDialog(marker.id); }} onClick={(event) => { event.stopPropagation(); if (event.shiftKey) controller.removeMarker(marker.id); else controller.setTime(marker.time); }}><i /><span>{marker.label}</span></button>)}
          <div className="timeline-track-surface" style={{ height: workspaceHeight }}>
            {dropPoint && <div className="asset-drop-ghost" style={{ left: dropPoint.x, top: dropPoint.y * state.timelineVerticalZoom }}><span>{t("ここに配置")}</span></div>}
            {alignmentSuggestion && <div
              className="timeline-alignment-guide"
              data-target-clip-id={alignmentSuggestion.targetId}
              data-moving-edge={alignmentSuggestion.movingEdge}
              data-target-edge={alignmentSuggestion.targetEdge}
              style={{ left: alignmentSuggestion.x, top: alignmentSuggestion.top * state.timelineVerticalZoom, height: alignmentSuggestion.height * state.timelineVerticalZoom }}
            ><span>{t("端を揃える")}</span></div>}
            {selectionBox && <div className="timeline-selection-box" style={selectionBox} />}
            {orderedClips.map((clip) => {
              const asset = clip.assetId ? assetsById.get(clip.assetId) : undefined;
              return <Clip key={clip.id} clip={clip} asset={asset} waveformPeaks={asset?.waveformPeaks} pxPerSecond={pxPerSecond} verticalZoom={state.timelineVerticalZoom} timelineViewport={timelineViewport} selected={state.selectedClipIds.includes(clip.id)} durationResizable={clip.kind === "group" || clip.kind === "title" || clip.kind === "object" || Boolean(clip.assetId && resizableAssetIds.has(clip.assetId))} childCount={state.clips.filter((item) => item.groupId === clip.id).length} nestingDepth={nestingDepths.get(clip.id) ?? 0} fps={state.fps} snapEnabled={state.snapEnabled} onAlignmentSuggestion={setAlignmentSuggestion} controller={controller} />;
            })}
          </div>
          <div className="playhead free-playhead" style={{ left: state.currentTime * pxPerSecond }}><div className="playhead-cap" /><i /></div>
        </div>
      </div>
    </section>
  );
}

function TimelineRuler({ duration, fps, pxPerSecond, scrollLeft, viewportWidth, cameraKeyframes, selectedCameraKeyframeIds, controller, onPointerDown, onDoubleClick }: {
  duration: number;
  fps: number;
  pxPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
  cameraKeyframes: CameraKeyframeGroup[];
  selectedCameraKeyframeIds: string[];
  controller: typeof import("../core/interface").editorController;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const majorStep = niceTimelineStep(76 / Math.max(0.001, pxPerSecond));
  const minorStep = majorStep / 5;
  const ticks = useMemo(() => {
    const buffer = 24;
    const startTime = Math.max(0, (scrollLeft - buffer) / pxPerSecond);
    const endTime = Math.min(duration, (scrollLeft + Math.max(1, viewportWidth) + buffer) / pxPerSecond);
    const firstIndex = Math.max(0, Math.floor(startTime / minorStep));
    const lastIndex = Math.max(firstIndex, Math.ceil(endTime / minorStep));
    return Array.from({ length: lastIndex - firstIndex + 1 }, (_, offset) => {
      const index = firstIndex + offset;
      const time = Math.min(duration, index * minorStep);
      return { index, time, major: index % 5 === 0 };
    });
  }, [duration, majorStep, minorStep, pxPerSecond, scrollLeft, viewportWidth]);
  const visibleCameraKeyframes = cameraKeyframes.filter((group) => {
    const x = group.time * pxPerSecond;
    return x >= scrollLeft - 20 && x <= scrollLeft + viewportWidth + 20;
  });
  return (
    <div className="timeline-time-ruler" aria-label={t("タイムライン時間ルーラー")} title={t("ダブルクリックでカメラキーフレームを追加")} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      {ticks.map((tick) => <i key={tick.index} className={tick.major ? "major" : "minor"} style={{ left: tick.time * pxPerSecond }}>
        {tick.major && <time dateTime={`PT${tick.time}S`}>{formatRulerTime(tick.time, duration, majorStep)}</time>}
      </i>)}
      {visibleCameraKeyframes.map((group) => <CameraKeyframeMarker key={group.keyframes.map((keyframe) => keyframe.id).join(":")} group={group} duration={duration} fps={fps} pxPerSecond={pxPerSecond} selected={group.keyframes.some((keyframe) => selectedCameraKeyframeIds.includes(keyframe.id))} controller={controller} />)}
    </div>
  );
}

function CameraKeyframeMarker({ group, duration, fps, pxPerSecond, selected, controller }: {
  group: CameraKeyframeGroup;
  duration: number;
  fps: number;
  pxPerSecond: number;
  selected: boolean;
  controller: typeof import("../core/interface").editorController;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const begin = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originTime = group.time;
    const ids = group.keyframes.map((keyframe) => keyframe.id);
    controller.selectCameraKeyframes(ids);
    let moved = false;
    let lastTime = originTime;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const delta = pointer.clientX - originX;
      if (!moved && Math.abs(delta) < 3) return;
      moved = true;
      setDragging(true);
      const rawTime = Math.max(0, Math.min(duration, originTime + delta / pxPerSecond));
      lastTime = pointer.shiftKey ? rawTime : Math.round(rawTime * fps) / fps;
      controller.moveCameraKeyframes(ids, lastTime);
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (pointer.type !== "pointercancel") {
        if (!moved) {
          if (pointer.shiftKey) controller.removeCameraKeyframes(ids);
          else controller.setTime(originTime);
        } else controller.moveCameraKeyframes(ids, lastTime);
      }
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const label = t("カメラキーフレーム {time}s（{count}項目）", { time: group.time.toFixed(3), count: group.keyframes.length });
  return <button
    type="button"
    className={`timeline-camera-keyframe ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
    style={{ left: group.time * pxPerSecond }}
    title={`${label} · ${t("ドラッグで移動 / Shift+クリックで削除")}`}
    aria-label={label}
    onPointerDown={begin}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === "Delete" || event.key === "Backspace") controller.removeCameraKeyframes(group.keyframes.map((keyframe) => keyframe.id));
      else if (event.key === "Enter" || event.key === " ") {
        controller.selectCameraKeyframes(group.keyframes.map((keyframe) => keyframe.id));
        controller.setTime(group.time);
      }
    }}
  />;
}

function groupCameraKeyframes(keyframes: readonly SceneKeyframe[], fps: number): CameraKeyframeGroup[] {
  const groups = new Map<number, SceneKeyframe[]>();
  for (const keyframe of keyframes) {
    if (!keyframe.property.startsWith("camera.")) continue;
    const frame = Math.round(keyframe.time * Math.max(1, fps));
    const group = groups.get(frame) ?? [];
    group.push(keyframe);
    groups.set(frame, group);
  }
  return [...groups.values()]
    .map((group) => ({ time: group.reduce((sum, keyframe) => sum + keyframe.time, 0) / group.length, keyframes: group }))
    .sort((left, right) => left.time - right.time);
}

function niceTimelineStep(seconds: number) {
  const exponent = Math.floor(Math.log10(Math.max(0.000001, seconds)));
  const magnitude = 10 ** exponent;
  const normalized = seconds / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function formatRulerTime(seconds: number, duration: number, step: number) {
  const decimals = step < 1 ? Math.min(3, Math.max(1, Math.ceil(-Math.log10(step)))) : 0;
  const scale = 10 ** decimals;
  const safe = Math.round(Math.max(0, seconds) * scale) / scale;
  const wholeSeconds = Math.floor(safe);
  const fraction = decimals ? `.${Math.round((safe - wholeSeconds) * scale).toString().padStart(decimals, "0")}` : "";
  const second = wholeSeconds % 60;
  const minute = Math.floor(wholeSeconds / 60) % 60;
  if (duration >= 3600) return `${String(Math.floor(wholeSeconds / 3600)).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${fraction}`;
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, "0")}:${String(second).padStart(2, "0")}${fraction}`;
}

function formatClock(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const second = totalSeconds % 60;
  const minute = Math.floor(totalSeconds / 60) % 60;
  const hour = Math.floor(totalSeconds / 3600);
  return [hour, minute, second].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatPreciseClock(seconds: number) {
  const safe = Math.max(0, seconds);
  const centiseconds = Math.floor(safe * 100 + 0.000001) % 100;
  return `${formatClock(safe)}.${String(centiseconds).padStart(2, "0")}`;
}

function requestPreviewAction(action: "popout" | "fullscreen") {
  window.dispatchEvent(new CustomEvent("gfxutl:preview-action", { detail: action }));
}

const Clip = memo(function Clip({ clip, asset, waveformPeaks, pxPerSecond, verticalZoom, timelineViewport, selected, durationResizable, childCount, nestingDepth, fps, snapEnabled, onAlignmentSuggestion, controller }: { clip: TimelineClip; asset?: MediaAsset; waveformPeaks?: number[]; pxPerSecond: number; verticalZoom: number; timelineViewport: { scrollLeft: number; scrollTop: number; width: number; height: number }; selected: boolean; durationResizable: boolean; childCount: number; nestingDepth: number; fps: number; snapEnabled: boolean; onAlignmentSuggestion: (suggestion: AlignmentSuggestion | null) => void; controller: typeof import("../core/interface").editorController }) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originalStart: number; originalY: number; lastStart: number; lastY: number } | null>(null);
  const visual = isVisualClip(clip);
  const muted = (clip.kind === "video" || clip.kind === "audio") && (clip.volume ?? 0) <= -60;
  const clipWidth = Math.max(MIN_CLIP_WIDTH, clip.duration * pxPerSecond);
  const clipHeight = timelineClipHeight(clip) * verticalZoom;
  const viewportTop = Math.max(0, timelineViewport.scrollTop - TIME_RULER_HEIGHT);
  const verticallyVisible = clip.y * verticalZoom < viewportTop + timelineViewport.height && clip.y * verticalZoom + clipHeight > viewportTop;

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
    active.lastY = Math.max(0, active.originalY + (event.clientY - active.startY) / verticalZoom);
    const snapshot = controller.getSnapshot();
    const excludedIds = timelineGroupDescendants(snapshot.clips, snapshot.selectedClipIds.includes(clip.id) ? snapshot.selectedClipIds : [clip.id]);
    const alignment = findTimelineAlignment({ start: Math.max(0, rawStart), duration: clip.duration, y: active.lastY, height: timelineClipHeight(clip) }, snapshot.clips, excludedIds, pxPerSecond);
    onAlignmentSuggestion(alignment?.suggestion ?? null);
    const suggestedStart = alignment?.start ?? rawStart;
    active.lastStart = Math.max(0, !snapEnabled || event.shiftKey ? rawStart : alignment ? suggestedStart : Math.round(rawStart * fps) / fps);
    controller.moveClip(clip.id, active.lastStart, active.lastY);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    controller.moveClip(clip.id, active.lastStart, active.lastY);
    onAlignmentSuggestion(null);
    drag.current = null;
    setDragging(false);
  };

  const beginResize = (edge: "start" | "end", event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !durationResizable) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selected) controller.selectClip(clip.id);
    const originX = event.clientX;
    const originalStart = clip.start;
    const originalDuration = clip.duration;
    const originalEnd = originalStart + originalDuration;
    const minimumDuration = 1 / fps;
    setResizing(true);
    const move = (pointer: PointerEvent) => {
      const delta = (pointer.clientX - originX) / pxPerSecond;
      if (edge === "start") {
        const rawStart = originalStart + delta;
        const candidateStart = Math.max(0, Math.min(originalEnd - minimumDuration, rawStart));
        const snapshot = controller.getSnapshot();
        const alignment = findTimelineAlignment({ start: candidateStart, duration: originalEnd - candidateStart, y: clip.y, height: timelineClipHeight(clip) }, snapshot.clips, new Set([clip.id]), pxPerSecond, ["start"]);
        onAlignmentSuggestion(alignment?.suggestion ?? null);
        const snappedStart = !snapEnabled || pointer.shiftKey ? rawStart : alignment ? alignment.start : Math.round(rawStart * fps) / fps;
        const start = Math.max(0, Math.min(originalEnd - minimumDuration, snappedStart));
        controller.resizeStaticClip(clip.id, start, originalEnd - start);
      } else {
        const rawDuration = originalDuration + delta;
        const candidateDuration = Math.max(minimumDuration, rawDuration);
        const snapshot = controller.getSnapshot();
        const alignment = findTimelineAlignment({ start: originalStart, duration: candidateDuration, y: clip.y, height: timelineClipHeight(clip) }, snapshot.clips, new Set([clip.id]), pxPerSecond, ["end"]);
        onAlignmentSuggestion(alignment?.suggestion ?? null);
        const duration = Math.max(minimumDuration, !snapEnabled || pointer.shiftKey ? rawDuration : alignment ? alignment.time - originalStart : Math.round(rawDuration * fps) / fps);
        controller.resizeStaticClip(clip.id, originalStart, duration);
      }
    };
    const end = () => {
      setResizing(false);
      onAlignmentSuggestion(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const beginGroupResize = (edge: GroupResizeEdge, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || clip.kind !== "group") return;
    event.preventDefault();
    event.stopPropagation();
    if (!selected) controller.selectClip(clip.id);
    const originX = event.clientX;
    const originY = event.clientY;
    const originalStart = clip.start;
    const originalEnd = clip.start + clip.duration;
    const originalTop = clip.y;
    const originalBottom = clip.y + timelineClipHeight(clip);
    const minimumDuration = 1 / fps;
    setResizing(true);
    const move = (pointer: PointerEvent) => {
      const rawDeltaTime = (pointer.clientX - originX) / pxPerSecond;
      const deltaTime = !snapEnabled || pointer.shiftKey ? rawDeltaTime : Math.round(rawDeltaTime * fps) / fps;
      const deltaY = (pointer.clientY - originY) / verticalZoom;
      let left = originalStart;
      let right = originalEnd;
      let top = originalTop;
      let bottom = originalBottom;
      if (edge.includes("w")) left = Math.max(0, Math.min(originalEnd - minimumDuration, originalStart + deltaTime));
      if (edge.includes("e")) right = Math.max(originalStart + minimumDuration, originalEnd + deltaTime);
      if (edge.includes("n")) top = Math.max(0, Math.min(originalBottom - MIN_GROUP_HEIGHT, originalTop + deltaY));
      if (edge.includes("s")) bottom = Math.max(originalTop + MIN_GROUP_HEIGHT, originalBottom + deltaY);
      if (edge.includes("w") || edge.includes("e")) {
        const snapshot = controller.getSnapshot();
        const alignment = findTimelineAlignment({ start: left, duration: right - left, y: top, height: bottom - top }, snapshot.clips, timelineGroupDescendants(snapshot.clips, [clip.id]), pxPerSecond, edge.includes("w") ? ["start"] : ["end"]);
        onAlignmentSuggestion(alignment?.suggestion ?? null);
        if (alignment && snapEnabled && !pointer.shiftKey) {
          if (edge.includes("w")) left = Math.min(right - minimumDuration, alignment.start);
          else right = Math.max(left + minimumDuration, alignment.time);
        }
      } else onAlignmentSuggestion(null);
      controller.resizeTimelineGroup(clip.id, left, top, right - left, bottom - top);
    };
    const end = () => {
      setResizing(false);
      onAlignmentSuggestion(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const beginKeyframeDrag = (keyframeId: string, originalTime: number, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const originX = event.clientX;
    const move = (pointer: PointerEvent) => {
      const rawTime = Math.max(0, Math.min(clip.duration, originalTime + (pointer.clientX - originX) / pxPerSecond));
      const time = !snapEnabled || pointer.shiftKey ? rawTime : Math.round(rawTime * fps) / fps;
      controller.updateKeyframe(clip.id, keyframeId, { time });
      controller.setTime(clip.start + time);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  return (
    <button
      className={`timeline-clip free-clip clip-${clip.kind} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${resizing ? "resizing" : ""} ${clip.groupId ? "nested" : ""} ${visual && clip.visible === false ? "visual-hidden" : ""} ${visual || muted ? "has-status" : ""} ${visual && muted ? "has-two-status" : ""}`}
      data-clip-id={clip.id}
      data-group-id={clip.groupId ?? ""}
      data-start={clip.start}
      data-y={clip.y}
      data-duration={clip.duration}
      data-height={timelineClipHeight(clip)}
      data-nesting-depth={nestingDepth}
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
      style={{ left: clip.start * pxPerSecond, top: clip.y * verticalZoom, width: clipWidth, height: clipHeight, zIndex: dragging ? 30_000 : clip.kind === "group" ? 100 + nestingDepth * 100 + (selected ? 1 : 0) : Math.max(1_000, 10_000 + nestingDepth * 100 - Math.round(clip.y)), "--clip-color": clip.color } as React.CSSProperties}
    >
      {(dragging || resizing) && <output className="clip-drag-readout">{resizing ? `${clip.duration.toFixed(2)}s` : `${clip.start.toFixed(2)}s · y ${Math.round(clip.y)}`}</output>}
      <span className="timeline-clip-kind">{clip.kind === "group" ? <FolderList16Regular /> : clip.kind === "title" ? <TextT12Regular /> : clip.kind === "audio" ? <MusicNote216Regular /> : clip.kind === "object" ? <Cube16Regular /> : <VideoClip16Regular />}</span><strong>{clip.name}{clip.kind === "group" ? ` · ${childCount}` : ""}</strong>
      {(muted || visual) && <span className="timeline-clip-status" role="img" aria-label={[muted ? t("ミュート") : "", visual ? t(clip.visible === false ? "非表示" : "表示") : ""].filter(Boolean).join(", ")}>
        {muted && <span title={t("ミュート")}><SpeakerMute /></span>}
        {visual && <span title={t(clip.visible === false ? "非表示" : "表示")}>{clip.visible === false ? <EyeOff /> : <Eye />}</span>}
      </span>}
      {selected && (clip.keyframes ?? []).map((keyframe) => <i className="timeline-keyframe" key={keyframe.id} title={`${keyframe.property}: ${keyframe.value} · ${t("ドラッグで時刻変更")}`} style={{ left: `${Math.max(0, Math.min(100, keyframe.time / Math.max(0.001, clip.duration) * 100))}%` }} onPointerDown={(event) => beginKeyframeDrag(keyframe.id, keyframe.time, event)} onClick={(event) => { event.stopPropagation(); controller.setTime(clip.start + keyframe.time); controller.selectClip(clip.id); }} />)}
      {clip.kind === "audio" && <div className="waveform" data-waveform-source={waveformPeaks?.length ? "media" : "pending"}>{(waveformPeaks?.length ? waveformPeaks : Array.from({ length: 24 }, () => 0.08)).map((peak, i) => <i key={i} style={{ height: `${Math.max(4, Math.min(100, peak * 100))}%` }} />)}</div>}
      {verticallyVisible && clip.kind === "video" && asset && (asset.kind === "video" || asset.kind === "image") && <TimelineMediaStrip asset={asset} clip={clip} width={clipWidth} height={clipHeight} pxPerSecond={pxPerSecond} viewport={timelineViewport} controller={controller} />}
      {selected && durationResizable && clip.kind !== "group" && <><i className="clip-trim-handle trim-start" title={t("左端をドラッグして長さを変更")} onPointerDown={(event) => beginResize("start", event)} /><i className="clip-trim-handle trim-end" title={t("右端をドラッグして長さを変更")} onPointerDown={(event) => beginResize("end", event)} /></>}
      {selected && clip.kind === "group" && (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as GroupResizeEdge[]).map((edge) => <i key={edge} className={`group-resize-handle group-resize-${edge}`} data-resize-edge={edge} title={t("グループ境界を伸縮")} onPointerDown={(event) => beginGroupResize(edge, event)} />)}
    </button>
  );
}, (previous, next) => previous.clip === next.clip
  && previous.asset === next.asset
  && previous.waveformPeaks === next.waveformPeaks
  && previous.pxPerSecond === next.pxPerSecond
  && previous.verticalZoom === next.verticalZoom
  && previous.timelineViewport.scrollLeft === next.timelineViewport.scrollLeft
  && previous.timelineViewport.scrollTop === next.timelineViewport.scrollTop
  && previous.timelineViewport.width === next.timelineViewport.width
  && previous.timelineViewport.height === next.timelineViewport.height
  && previous.selected === next.selected
  && previous.durationResizable === next.durationResizable
  && previous.childCount === next.childCount
  && previous.nestingDepth === next.nestingDepth
  && previous.fps === next.fps
  && previous.snapEnabled === next.snapEnabled
  && previous.onAlignmentSuggestion === next.onAlignmentSuggestion);

function TimelineMediaStrip({ asset, clip, width, height, pxPerSecond, viewport, controller }: {
  asset: MediaAsset;
  clip: TimelineClip;
  width: number;
  height: number;
  pxPerSecond: number;
  viewport: { scrollLeft: number; width: number };
  controller: typeof import("../core/interface").editorController;
}) {
  const clipLeft = clip.start * pxPerSecond;
  const visibleStart = Math.max(0, viewport.scrollLeft - clipLeft);
  const visibleEnd = Math.min(width, viewport.scrollLeft + viewport.width - clipLeft);
  if (visibleEnd <= visibleStart || viewport.width <= 0) return <div className="frame-strip timeline-media-strip" data-thumbnail-source={asset.kind} />;

  const first = Math.max(0, Math.floor(visibleStart / TIMELINE_THUMBNAIL_WIDTH) - 1);
  const last = Math.min(Math.ceil(width / TIMELINE_THUMBNAIL_WIDTH), Math.ceil(visibleEnd / TIMELINE_THUMBNAIL_WIDTH) + 1);
  const tiles = Array.from({ length: Math.max(0, last - first) }, (_, index) => {
    const tileIndex = first + index;
    const left = tileIndex * TIMELINE_THUMBNAIL_WIDTH;
    const tileWidth = Math.min(TIMELINE_THUMBNAIL_WIDTH, width - left);
    // Derive the sampled frame from the cell's actual ruler position so the
    // visible image stays aligned with the time represented at that point.
    const localTime = Math.max(0, Math.min(clip.duration, (left + tileWidth / 2) / Math.max(0.001, pxPerSecond)));
    const speed = Math.max(0.01, Math.min(10, evaluateTimelineSpeed(clip, localTime) / 100));
    const sourceTime = asset.kind === "image"
      ? 0
      : Math.max(0, Math.min(Math.max(0, asset.duration - 0.001), clip.offset + localTime * speed));
    return { tileIndex, left, width: tileWidth, sourceTime };
  });

  return <div className="frame-strip timeline-media-strip" data-thumbnail-source={asset.kind}>
    {tiles.map((tile) => <TimelineThumbnailCanvas
      key={`${tile.tileIndex}:${tile.sourceTime.toFixed(6)}`}
      assetId={asset.id}
      sourceTime={tile.sourceTime}
      left={tile.left}
      width={tile.width}
      height={height}
      enabled={!asset.fileStatus || asset.fileStatus === "ready"}
      controller={controller}
    />)}
  </div>;
}

function TimelineThumbnailCanvas({ assetId, sourceTime, left, width, height, enabled, controller }: {
  assetId: string;
  sourceTime: number;
  left: number;
  width: number;
  height: number;
  enabled: boolean;
  controller: typeof import("../core/interface").editorController;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getTimelineThumbnailCanvas(controller, assetId, sourceTime, width, height).then((source) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      canvas.width = source.width;
      canvas.height = source.height;
      context.drawImage(source, 0, 0);
      canvas.dataset.thumbnailReady = "true";
    }).catch(() => { /* The clip color remains visible while its media is unavailable. */ });
    return () => { cancelled = true; };
  }, [assetId, controller, enabled, height, sourceTime, width]);

  return <canvas ref={canvasRef} style={{ left, width }} data-source-time={sourceTime.toFixed(6)} aria-hidden="true" />;
}

function getTimelineThumbnailCanvas(controller: typeof import("../core/interface").editorController, assetId: string, time: number, cssWidth: number, cssHeight: number) {
  const scale = Math.min(2, window.devicePixelRatio || 1, 512 / Math.max(1, cssWidth), 256 / Math.max(1, cssHeight));
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  const key = `${assetId}:${time.toFixed(6)}:${width}x${height}`;
  const cached = timelineThumbnailCache.get(key);
  if (cached) {
    timelineThumbnailCache.delete(key);
    timelineThumbnailCache.set(key, cached);
    return cached;
  }

  const request = scheduleTimelineThumbnail(() => controller.getMediaThumbnail(assetId, time)).then((thumbnail) => {
    const raster = thumbnail.frame ?? thumbnail.bitmap;
    if (!raster) throw new Error("Timeline thumbnail has no raster image");
    const sourceWidth = raster instanceof VideoFrame ? raster.displayWidth : raster.width;
    const sourceHeight = raster instanceof VideoFrame ? raster.displayHeight : raster.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      raster.close();
      throw new Error("Timeline thumbnail canvas is unavailable");
    }
    const coverScale = Math.max(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
    const targetWidth = sourceWidth * coverScale;
    const targetHeight = sourceHeight * coverScale;
    try {
      context.drawImage(raster, (width - targetWidth) / 2, (height - targetHeight) / 2, targetWidth, targetHeight);
    } finally {
      raster.close();
    }
    return canvas;
  }).catch((error) => {
    if (timelineThumbnailCache.get(key) === request) timelineThumbnailCache.delete(key);
    throw error;
  });
  timelineThumbnailCache.set(key, request);
  while (timelineThumbnailCache.size > TIMELINE_THUMBNAIL_CACHE_LIMIT) timelineThumbnailCache.delete(timelineThumbnailCache.keys().next().value!);
  return request;
}

function scheduleTimelineThumbnail<T>(request: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    timelineThumbnailQueue.push(async () => {
      try { resolve(await request()); } catch (error) { reject(error); }
    });
    drainTimelineThumbnailQueue();
  });
}

function drainTimelineThumbnailQueue() {
  while (activeTimelineThumbnailRequests < TIMELINE_THUMBNAIL_CONCURRENCY && timelineThumbnailQueue.length) {
    const request = timelineThumbnailQueue.shift()!;
    activeTimelineThumbnailRequests++;
    void request().finally(() => {
      activeTimelineThumbnailRequests--;
      drainTimelineThumbnailQueue();
    });
  }
}

function evaluateTimelineSpeed(clip: TimelineClip, localTime: number) {
  const keys = (clip.keyframes ?? []).filter((keyframe) => keyframe.property === "speed").sort((left, right) => left.time - right.time);
  if (!keys.length) return clip.speed ?? 100;
  const left = [...keys].reverse().find((keyframe) => keyframe.time <= localTime) ?? keys[0];
  const right = keys.find((keyframe) => keyframe.time >= localTime) ?? keys.at(-1)!;
  if (left === right || left.interpolation === "step") return left.value;
  let alpha = Math.max(0, Math.min(1, (localTime - left.time) / Math.max(0.000001, right.time - left.time)));
  if (left.interpolation === "smooth") alpha = alpha * alpha * (3 - 2 * alpha);
  else if (left.interpolation === "bezier") alpha = timelineCubicBezierAt(left.easing, alpha);
  return left.value + (right.value - left.value) * alpha;
}

function timelineCubicBezierAt(easing: NonNullable<TimelineClip["keyframes"]>[number]["easing"], x: number) {
  const { x1, y1, x2, y2 } = easing ?? { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
  let time = x;
  for (let index = 0; index < 6; index++) {
    const inverse = 1 - time;
    const estimate = 3 * inverse * inverse * time * x1 + 3 * inverse * time * time * x2 + time * time * time;
    const derivative = 3 * inverse * inverse * x1 + 6 * inverse * time * (x2 - x1) + 3 * time * time * (1 - x2);
    if (Math.abs(derivative) < 0.000001) break;
    time = Math.max(0, Math.min(1, time - (estimate - x) / derivative));
  }
  const inverse = 1 - time;
  return 3 * inverse * inverse * time * y1 + 3 * inverse * time * time * y2 + time * time * time;
}

function findTimelineAlignment(candidate: { start: number; duration: number; y: number; height: number }, clips: readonly TimelineClip[], excludedIds: ReadonlySet<string>, pxPerSecond: number, movingEdges: readonly TimelineEdge[] = ["start", "end"]) {
  const movingWidth = Math.max(MIN_CLIP_WIDTH, candidate.duration * pxPerSecond);
  const movingBottom = candidate.y + candidate.height;
  const threshold = 9;
  let best: { distance: number; start: number; duration: number; time: number; suggestion: AlignmentSuggestion } | null = null;
  for (const target of clips) {
    if (excludedIds.has(target.id)) continue;
    const targetHeight = timelineClipHeight(target);
    const verticalGap = Math.max(0, target.y - movingBottom, candidate.y - (target.y + targetHeight));
    if (verticalGap > movingWidth) continue;
    const targetEdges: Array<[TimelineEdge, number]> = [["start", target.start], ["end", target.start + target.duration]];
    for (const movingEdge of movingEdges) {
      const movingTime = movingEdge === "start" ? candidate.start : candidate.start + candidate.duration;
      for (const [targetEdge, targetTime] of targetEdges) {
        const distance = Math.abs(targetTime - movingTime) * pxPerSecond;
        if (distance > threshold || (best && distance >= best.distance)) continue;
        const start = movingEdge === "start" ? targetTime : targetTime - candidate.duration;
        if (start < 0) continue;
        const top = Math.min(candidate.y, target.y);
        const bottom = Math.max(movingBottom, target.y + targetHeight);
        best = {
          distance,
          start,
          duration: candidate.duration,
          time: targetTime,
          suggestion: { x: targetTime * pxPerSecond, top, height: Math.max(1, bottom - top), targetId: target.id, movingEdge, targetEdge },
        };
      }
    }
  }
  return best;
}

function timelineNestingDepths(clips: readonly TimelineClip[]) {
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const depths = new Map<string, number>();
  const depthOf = (clip: TimelineClip, visiting = new Set<string>()): number => {
    const cached = depths.get(clip.id);
    if (cached !== undefined) return cached;
    if (!clip.groupId || visiting.has(clip.id)) return 0;
    const parent = clipsById.get(clip.groupId);
    if (!parent || parent.kind !== "group") return 0;
    visiting.add(clip.id);
    const depth = depthOf(parent, visiting) + 1;
    visiting.delete(clip.id);
    depths.set(clip.id, depth);
    return depth;
  };
  for (const clip of clips) depths.set(clip.id, depthOf(clip));
  return depths;
}
