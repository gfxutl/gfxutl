import { ChevronsLeft, ChevronsRight, Expand, ExternalLink, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useEditor } from "../core/interface";
import type { TimelineClip } from "../core/interface";
import type { MediaAsset } from "../core/interface";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

export function PreviewPanel() {
  const { state, controller } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const popoutRef = useRef<Window | null>(null);
  const popoutObserverRef = useRef<ResizeObserver | null>(null);
  const pickFrameRef = useRef<number | null>(null);
  const pickSequenceRef = useRef(0);
  const pendingPickRef = useRef<{ x: number; y: number } | null>(null);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [poppedOut, setPoppedOut] = useState(false);
  const [surfaceKey, setSurfaceKey] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || poppedOut) return;
    const rect = stage.getBoundingClientRect();
    controller.connectPreview(canvas, Math.floor(rect.width), Math.floor(rect.height));
    const observer = new ResizeObserver(([entry]) => controller.resizePreview(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height)));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [controller, poppedOut, surfaceKey]);

  useEffect(() => () => {
    if (pickFrameRef.current !== null) cancelAnimationFrame(pickFrameRef.current);
    popoutObserverRef.current?.disconnect();
    if (popoutRef.current && !popoutRef.current.closed) popoutRef.current.close();
  }, []);

  const returnFromPopout = () => {
    popoutObserverRef.current?.disconnect();
    popoutObserverRef.current = null;
    popoutRef.current = null;
    setPoppedOut(false);
    setSurfaceKey((value) => value + 1);
  };

  const popOutPreview = () => {
    const popup = window.open("", "gfxutl-preview", "popup=yes,width=960,height=600");
    if (!popup) return;
    popup.document.title = "GfxUtl プレビュー";
    popup.document.body.innerHTML = `<main><canvas></canvas><button type="button" aria-label="プレビューを戻す">GfxUtlへ戻す</button></main>`;
    const style = popup.document.createElement("style");
    style.textContent = "html,body,main{margin:0;width:100%;height:100%;overflow:hidden;background:#111}canvas{display:block;width:100%;height:100%}button{position:fixed;right:12px;top:12px;border:1px solid #777;background:#202225;color:#fff;padding:8px 12px;border-radius:4px;cursor:pointer}";
    popup.document.head.append(style);
    const popupCanvas = popup.document.querySelector("canvas") as HTMLCanvasElement | null;
    const returnButton = popup.document.querySelector("button") as HTMLButtonElement | null;
    if (!popupCanvas || !returnButton) { popup.close(); return; }
    popoutRef.current = popup;
    setPoppedOut(true);
    const attach = () => {
      const rect = popupCanvas.getBoundingClientRect();
      controller.connectPreview(popupCanvas, Math.max(2, Math.floor(rect.width)), Math.max(2, Math.floor(rect.height)));
    };
    attach();
    popoutObserverRef.current = new ResizeObserver(([entry]) => controller.resizePreview(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height)));
    popoutObserverRef.current.observe(popupCanvas);
    returnButton.addEventListener("click", () => popup.close());
    popup.addEventListener("beforeunload", returnFromPopout, { once: true });
  };

  useEffect(() => { if (state.playing) setHoveredClipId(null); }, [state.playing]);

  const previewObjects = useMemo(() => state.clips
    .filter((clip) => clip.kind !== "audio" && state.currentTime >= clip.start && state.currentTime < clip.start + clip.duration)
    .map((clip) => previewBounds(animatedClip(clip, state.currentTime), state.assets.find((asset) => asset.id === clip.assetId)))
    .sort((a, b) => (b.clip.positionZ ?? 0) - (a.clip.positionZ ?? 0) || a.clip.y - b.clip.y), [state.clips, state.assets, state.currentTime]);
  const hoveredObject = previewObjects.find((object) => object.clip.id === hoveredClipId);

  const pickPoint = async (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const ndcX = (clientX - rect.left) / rect.width * 2 - 1;
    const ndcY = 1 - (clientY - rect.top) / rect.height * 2;
    return controller.pickPreview(ndcX, ndcY);
  };

  const hoverObject = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (state.playing) return;
    if ((event.target as HTMLElement).closest(".preview-transform-box")) return;
    pendingPickRef.current = { x: event.clientX, y: event.clientY };
    if (pickFrameRef.current !== null) return;
    const element = event.currentTarget;
    pickFrameRef.current = requestAnimationFrame(async () => {
      pickFrameRef.current = null;
      const point = pendingPickRef.current;
      if (!point) return;
      const sequence = ++pickSequenceRef.current;
      const clipId = await pickPoint(element, point.x, point.y);
      if (sequence === pickSequenceRef.current) setHoveredClipId(clipId ?? null);
    });
  };

  const selectObjectAtPointer = async (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".preview-transform-box")) return;
    const clipId = await pickPoint(event.currentTarget, event.clientX, event.clientY);
    if (clipId) controller.selectClip(clipId);
    else controller.selectBackground();
  };

  const beginResize = (event: ReactPointerEvent<HTMLElement>, object: PreviewObjectBounds, handle: string) => {
    event.preventDefault();
    event.stopPropagation();
    controller.selectClip(object.clip.id);
    const stage = stageRef.current;
    if (!stage) return;
    const startScaleX = object.clip.scaleX ?? 100;
    const startScaleY = object.clip.scaleY ?? 100;
    const resizeX = handle.includes("e") || handle.includes("w");
    const resizeY = handle.includes("n") || handle.includes("s");
    const move = (pointer: PointerEvent) => {
      const point = previewWorldPoint(stage, pointer.clientX, pointer.clientY);
      const radians = THREE_DEGREES * object.rotation;
      const dx = point.x - object.x;
      const dy = point.y - object.y;
      const localX = Math.cos(radians) * dx - Math.sin(radians) * dy;
      const localY = Math.sin(radians) * dx + Math.cos(radians) * dy;
      controller.updateClip(object.clip.id, {
        scaleX: resizeX ? Math.max(1, Math.min(5_000, startScaleX * Math.max(0.04, Math.abs(localX) * 2) / object.width)) : startScaleX,
        scaleY: resizeY ? Math.max(1, Math.min(5_000, startScaleY * Math.max(0.04, Math.abs(localY) * 2) / object.height)) : startScaleY,
      });
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

  const beginRotate = (event: ReactPointerEvent<HTMLElement>, object: PreviewObjectBounds) => {
    event.preventDefault();
    event.stopPropagation();
    controller.selectClip(object.clip.id);
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + (0.5 + object.x / 16) * rect.width;
    const centerY = rect.top + (0.5 - object.y / 9) * rect.height;
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const startRotation = object.rotation;
    const move = (pointer: PointerEvent) => {
      const angle = Math.atan2(pointer.clientY - centerY, pointer.clientX - centerX);
      controller.updateClip(object.clip.id, { rotation: startRotation + (angle - startAngle) / THREE_DEGREES });
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

  const timecode = toTimecode(state.currentTime, state.fps);
  return (
    <section className="preview-panel panel" ref={panelRef}>
      <div className={`preview-stage ${poppedOut ? "preview-popped-out" : ""}`} ref={stageRef} onMouseMove={hoverObject} onMouseLeave={() => { pickSequenceRef.current += 1; setHoveredClipId(null); }} onClick={selectObjectAtPointer} onContextMenu={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        controller.openContextMenu({
          x: event.clientX, y: event.clientY, scope: "preview", time: state.currentTime, timelineY: 32,
          positionX: ((event.clientX - rect.left) / rect.width - 0.5) * 1600,
          positionY: ((event.clientY - rect.top) / rect.height - 0.5) * 900,
        });
      }}>
        {!poppedOut ? <canvas key={surfaceKey} ref={canvasRef} data-camera-projection={state.cameraProjection} data-video-frames={state.videoFramesRendered} data-geometry-objects={state.geometryObjectsReady} data-active-scene-objects={state.activeSceneObjects} data-active-image-objects={state.activeImageObjects} data-playing-audio-objects={state.playingAudioObjects} data-preview-source={state.previewSource} data-cache-frames={state.cachedFramesDisplayed} data-preview-frames={state.previewFramesRendered} /> : <div className="preview-popout-placeholder"><ExternalLink /><span>プレビューは別ウィンドウで表示中です</span><button type="button" onClick={(event) => { event.stopPropagation(); popoutRef.current?.close(); }}>この画面に戻す</button></div>}
        <div className="safe-area" />
        {!state.playing && hoveredObject && <TransformHandles object={hoveredObject} onResize={beginResize} onRotate={beginRotate} />}
      </div>
      <div className="transport">
        <div className="transport-left"><span className="timecode active">{timecode}</span><span className="slash">/</span><span className="timecode">{toTimecode(state.duration, state.fps)}</span></div>
        <div className="transport-center">
          <Tooltip label="先頭へ"><Button variant="ghost" size="icon" onClick={() => controller.setTime(0)}><SkipBack /></Button></Tooltip>
          <Tooltip label="1フレーム戻る"><Button variant="ghost" size="icon" onClick={() => controller.nudge(-1)}><ChevronsLeft /></Button></Tooltip>
          <Button size="icon" className="play-button" onClick={controller.togglePlayback}>{state.playing ? <Pause /> : <Play />}</Button>
          <Tooltip label="1フレーム進む"><Button variant="ghost" size="icon" onClick={() => controller.nudge(1)}><ChevronsRight /></Button></Tooltip>
          <Tooltip label="末尾へ"><Button variant="ghost" size="icon" onClick={() => controller.setTime(state.duration)}><SkipForward /></Button></Tooltip>
        </div>
        <div className="transport-right">
          <Tooltip label="別ウィンドウで表示"><Button variant="ghost" size="icon" aria-label="プレビューを別ウィンドウで表示" onClick={popOutPreview} disabled={poppedOut}><ExternalLink /></Button></Tooltip>
          <Tooltip label="フルスクリーン"><Button variant="ghost" size="icon" onClick={() => panelRef.current?.requestFullscreen()}><Expand /></Button></Tooltip>
        </div>
      </div>
    </section>
  );
}

interface PreviewObjectBounds {
  clip: TimelineClip;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

function animatedClip(clip: TimelineClip, timelineTime: number): TimelineClip {
  if (!clip.keyframes?.length) return clip;
  const result = { ...clip };
  const localTime = Math.max(0, Math.min(clip.duration, timelineTime - clip.start));
  for (const property of new Set(clip.keyframes.map((keyframe) => keyframe.property))) {
    const keys = clip.keyframes.filter((keyframe) => keyframe.property === property).sort((a, b) => a.time - b.time);
    const left = [...keys].reverse().find((keyframe) => keyframe.time <= localTime) ?? keys[0];
    const right = keys.find((keyframe) => keyframe.time >= localTime) ?? keys.at(-1)!;
    let value = left.value;
    if (left !== right && left.interpolation !== "step") {
      let alpha = Math.max(0, Math.min(1, (localTime - left.time) / Math.max(0.000001, right.time - left.time)));
      if (left.interpolation === "smooth") alpha = alpha * alpha * (3 - 2 * alpha);
      value = left.value + (right.value - left.value) * alpha;
    }
    (result as unknown as Record<string, unknown>)[property] = value;
  }
  return result;
}

function previewBounds(clip: TimelineClip, asset?: MediaAsset): PreviewObjectBounds {
  const scale = Math.max(0.001, (clip.scale ?? 100) / 100);
  let width = 2.5;
  let height = 2.5;
  if (clip.kind === "title") {
    const size = clip.fontSize ?? 1.2;
    const lines = (clip.text ?? clip.name).split("\n");
    width = Math.max(0.35, Math.max(...lines.map((line) => [...line].length), 1) * size * 0.62);
    height = Math.max(size, lines.length * size * 1.25);
  } else if (clip.kind === "object") {
    const args = clip.geometry?.args ?? [];
    if (clip.particleSystem) width = height = clip.particleSystem.spread * 2;
    else if (clip.geometry?.kind === "box" || clip.geometry?.kind === "plane") [width = 2, height = 2] = args;
    else if (clip.geometry?.kind === "sphere") width = height = (args[0] ?? 1) * 2;
    else if (clip.geometry?.kind === "torus" || clip.geometry?.kind === "torusKnot") width = height = ((args[0] ?? 1) + (args[1] ?? 0.3)) * 2;
  } else if (asset?.width && asset.height) {
    const aspect = asset.width / asset.height;
    if (aspect >= 15.4 / 8.6) { width = 15.4; height = 15.4 / aspect; }
    else { width = 8.6 * aspect; height = 8.6; }
  }
  return {
    clip, x: (clip.positionX ?? 0) / 100, y: -(clip.positionY ?? 0) / 100,
    width: width * scale * ((clip.scaleX ?? 100) / 100),
    height: height * scale * ((clip.scaleY ?? 100) / 100), rotation: clip.rotation ?? 0,
  };
}

const THREE_DEGREES = Math.PI / 180;
const HANDLE_POSITIONS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

function previewWorldPoint(stage: HTMLElement, clientX: number, clientY: number) {
  const rect = stage.getBoundingClientRect();
  return { x: ((clientX - rect.left) / rect.width - 0.5) * 16, y: (0.5 - (clientY - rect.top) / rect.height) * 9 };
}

function TransformHandles({ object, onResize, onRotate }: {
  object: PreviewObjectBounds;
  onResize: (event: ReactPointerEvent<HTMLElement>, object: PreviewObjectBounds, handle: string) => void;
  onRotate: (event: ReactPointerEvent<HTMLElement>, object: PreviewObjectBounds) => void;
}) {
  return <div className="preview-transform-box" data-clip-id={object.clip.id} style={{
    left: `${50 + object.x / 16 * 100}%`, top: `${50 - object.y / 9 * 100}%`,
    width: `${object.width / 16 * 100}%`, height: `${object.height / 9 * 100}%`,
    transform: `translate(-50%, -50%) rotate(${object.rotation}deg)`,
  }}>
    {HANDLE_POSITIONS.map((position) => <i key={position} className={`dimension-handle handle-${position}`} data-handle={position} onPointerDown={(event) => onResize(event, object, position)} />)}
    <span className="rotation-stem" />
    <i className="rotation-handle" data-handle="rotation" onPointerDown={(event) => onRotate(event, object)} />
  </div>;
}

function toTimecode(seconds: number, fps: number) {
  const totalFrames = Math.max(0, Math.floor(seconds * fps));
  const frame = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const second = totalSeconds % 60;
  const minute = Math.floor(totalSeconds / 60) % 60;
  const hour = Math.floor(totalSeconds / 3600);
  return [hour, minute, second, frame].map((value) => String(value).padStart(2, "0")).join(":");
}
