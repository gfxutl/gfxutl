import { Camera16Regular as Camera, Dismiss16Regular as X, Eye16Regular as Inspector, MicRecord16Regular as MicRecord, Open16Regular as ExternalLink, TextFont16Regular as TextFont } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { shallowEqual, useEditor } from "../core/interface";
import type { CameraHandleKind, TimelineClip, TransformHandleKind } from "../core/interface";
import type { MediaAsset } from "../core/interface";
import { resolvePreviewResize } from "../core/interface/preview-resize";
import { AudioWaveformEditor } from "./audio-waveform-editor";
import { useI18n } from "../core/i18n";
import { AudioRecordingPanel } from "./audio-recording-panel";
import { OPEN_AUDIO_RECORDING_EVENT } from "../core/interface/recording-events";
import { GfxTextEditor } from "./gfxtext-editor";
import { OPEN_GFX_TEXT_EVENT, type GfxTextEditorEntry } from "../core/interface/gfxtext-document";

export function PreviewPanel() {
  const { state, controller } = useEditor((value) => ({
    activeImageObjects: value.activeImageObjects,
    activePreviewClipId: value.activePreviewClipId,
    activePreviewView: value.activePreviewView,
    activeSceneObjects: value.activeSceneObjects,
    assets: value.assets,
    background: value.background,
    cachedFramesDisplayed: value.cachedFramesDisplayed,
    cameraProjection: value.cameraProjection,
    clips: value.clips,
    currentTime: value.playing ? -1 : value.currentTime,
    fps: value.fps,
    geometryObjectsReady: value.geometryObjectsReady,
    playing: value.playing,
    playingAudioObjects: value.playingAudioObjects,
    previewClipTabs: value.previewClipTabs,
    previewFramesRendered: value.previewFramesRendered,
    previewSource: value.previewSource,
    selectedClipIds: value.selectedClipIds,
    videoFramesRendered: value.videoFramesRendered,
  }), shallowEqual);
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const popoutRef = useRef<Window | null>(null);
  const popoutObserverRef = useRef<ResizeObserver | null>(null);
  const pickFrameRef = useRef<number | null>(null);
  const pickSequenceRef = useRef(0);
  const pendingPickRef = useRef<{ x: number; y: number } | null>(null);
  const inspectorNavigationClickRef = useRef(false);
  const hoveredCameraHandleRef = useRef<CameraHandleKind | null>(null);
  const draggingCameraHandleRef = useRef<CameraHandleKind | null>(null);
  const cameraWheelTimerRef = useRef(0);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<TransformHandleKind | null>(null);
  const [hoveredCamera, setHoveredCamera] = useState(false);
  const [hoveredCameraHandle, setHoveredCameraHandle] = useState<CameraHandleKind | null>(null);
  const [draggingCameraHandle, setDraggingCameraHandle] = useState<CameraHandleKind | null>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [inspectorNavigation, setInspectorNavigation] = useState<"orbit" | "pan" | "walk" | null>(null);
  const [poppedOut, setPoppedOut] = useState(false);
  const [surfaceKey, setSurfaceKey] = useState(0);
  const [recordingTabOpen, setRecordingTabOpen] = useState(false);
  const [recordingTabActive, setRecordingTabActive] = useState(false);
  const [audioRecording, setAudioRecording] = useState(false);
  const [gfxTextTabs, setGfxTextTabs] = useState<GfxTextEditorEntry[]>([]);
  const [activeGfxTextId, setActiveGfxTextId] = useState<string | null>(null);
  const previewTabs = useMemo(() => state.previewClipTabs
    .map((id) => state.clips.find((clip) => clip.id === id))
    .filter((clip): clip is TimelineClip => Boolean(clip)), [state.clips, state.previewClipTabs]);
  const activePreviewClip = state.clips.find((clip) => clip.id === state.activePreviewClipId);
  const activeAudioClip = activePreviewClip?.kind === "audio" ? activePreviewClip : undefined;
  const inspectorView = !recordingTabActive && !activeGfxTextId && state.activePreviewClipId === null && state.activePreviewView === "inspector";
  const cameraName = state.background.scene.camera.name;
  const compositionAspect = state.background.width / state.background.height;
  const previewWorldHeight = 9;
  const previewWorldWidth = previewWorldHeight * compositionAspect;
  const previewStyle = {
    "--preview-aspect": `${state.background.width} / ${state.background.height}`,
    "--preview-aspect-ratio": compositionAspect,
  } as CSSProperties;

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || poppedOut || activeAudioClip || recordingTabActive || activeGfxTextId) return;
    const rect = stage.getBoundingClientRect();
    controller.connectPreview(canvas, Math.floor(rect.width), Math.floor(rect.height));
    const observer = new ResizeObserver(([entry]) => controller.resizePreview(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height)));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [controller, poppedOut, surfaceKey, activeAudioClip?.id, recordingTabActive, activeGfxTextId]);

  useEffect(() => {
    const openRecording = () => {
      setRecordingTabOpen(true);
      setRecordingTabActive(true);
      setActiveGfxTextId(null);
    };
    window.addEventListener(OPEN_AUDIO_RECORDING_EVENT, openRecording);
    return () => window.removeEventListener(OPEN_AUDIO_RECORDING_EVENT, openRecording);
  }, []);

  useEffect(() => {
    const openTextEditor = (event: Event) => {
      const entry = (event as CustomEvent<GfxTextEditorEntry>).detail;
      setGfxTextTabs((current) => current.some((item) => item.id === entry.id)
        ? current.map((item) => item.id === entry.id ? entry : item)
        : [...current, entry]);
      setRecordingTabActive(false);
      setActiveGfxTextId(entry.id);
    };
    window.addEventListener(OPEN_GFX_TEXT_EVENT, openTextEditor);
    return () => window.removeEventListener(OPEN_GFX_TEXT_EVENT, openTextEditor);
  }, []);

  useEffect(() => () => {
    if (pickFrameRef.current !== null) cancelAnimationFrame(pickFrameRef.current);
    window.clearTimeout(cameraWheelTimerRef.current);
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
    popup.document.title = t("GfxUtl プレビュー");
    popup.document.body.innerHTML = `<main><canvas></canvas><button type="button"></button></main>`;
    const style = popup.document.createElement("style");
    style.textContent = "html,body,main{margin:0;width:100%;height:100%;overflow:hidden;background:#111}main{display:grid;place-items:center}canvas{display:block;width:min(100vw,calc(100vh * var(--preview-aspect-ratio)));height:min(100vh,calc(100vw * var(--preview-aspect-inverse)))}button{position:fixed;right:12px;top:12px;border:1px solid #777;background:#202225;color:#fff;padding:8px 12px;border-radius:4px;cursor:pointer}";
    popup.document.head.append(style);
    popup.document.documentElement.style.setProperty("--preview-aspect-ratio", String(compositionAspect));
    popup.document.documentElement.style.setProperty("--preview-aspect-inverse", String(1 / compositionAspect));
    const popupCanvas = popup.document.querySelector("canvas") as HTMLCanvasElement | null;
    const returnButton = popup.document.querySelector("button") as HTMLButtonElement | null;
    if (!popupCanvas || !returnButton) { popup.close(); return; }
    returnButton.textContent = t("GfxUtlへ戻す");
    returnButton.setAttribute("aria-label", t("プレビューを戻す"));
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

  useEffect(() => {
    const handlePreviewAction = (event: Event) => {
      const action = (event as CustomEvent<"popout" | "fullscreen">).detail;
      if (action === "popout") {
        if (!poppedOut) popOutPreview();
      } else if (action === "fullscreen") {
        void panelRef.current?.requestFullscreen();
      }
    };
    window.addEventListener("gfxutl:preview-action", handlePreviewAction);
    return () => window.removeEventListener("gfxutl:preview-action", handlePreviewAction);
  }, [poppedOut]);

  useEffect(() => {
    const popup = popoutRef.current;
    if (!poppedOut || !popup || popup.closed) return;
    popup.document.documentElement.style.setProperty("--preview-aspect-ratio", String(compositionAspect));
    popup.document.documentElement.style.setProperty("--preview-aspect-inverse", String(1 / compositionAspect));
  }, [poppedOut, compositionAspect]);

  useEffect(() => {
    if (!state.playing) return;
    setHoveredClipId(null);
    setHoveredHandle(null);
    setHoveredCamera(false);
    setHoveredCameraHandle(null);
    hoveredCameraHandleRef.current = null;
  }, [state.playing]);

  useEffect(() => {
    if (!inspectorView) {
      setHoveredCamera(false);
      setHoveredCameraHandle(null);
      hoveredCameraHandleRef.current = null;
    }
  }, [inspectorView]);

  const previewObjects = useMemo(() => inspectorView ? [] : state.clips
    .filter((clip) => !state.activePreviewClipId || clip.id === state.activePreviewClipId)
    .filter((clip) => clip.kind !== "audio" && clip.kind !== "group" && (state.activePreviewClipId === clip.id || state.currentTime >= clip.start && state.currentTime < clip.start + clip.duration))
    .map((clip) => previewBounds(animatedClip(clip, state.activePreviewClipId === clip.id ? Math.max(clip.start, Math.min(state.currentTime, clip.start + clip.duration - 1 / state.fps)) : state.currentTime), state.assets.find((asset) => asset.id === clip.assetId), { width: previewWorldWidth, height: previewWorldHeight }))
    .sort((a, b) => (b.clip.positionZ ?? 0) - (a.clip.positionZ ?? 0) || a.clip.y - b.clip.y), [inspectorView, previewWorldHeight, previewWorldWidth, state.clips, state.assets, state.currentTime, state.activePreviewClipId, state.fps]);
  const hoveredObject = previewObjects.find((object) => object.clip.id === hoveredClipId);
  const selectedFilterObject = previewObjects.find((object) => object.clip.kind === "filter" && state.selectedClipIds.includes(object.clip.id));

  useEffect(() => {
    controller.setPreviewTransformHandles(!inspectorView && !state.playing && !poppedOut ? hoveredObject?.clip.id : undefined);
  }, [controller, hoveredObject?.clip.id, inspectorView, poppedOut, state.playing]);

  useEffect(() => {
    controller.setCameraHandles(inspectorView && (hoveredCamera || Boolean(draggingCameraHandle)) && !state.playing && !poppedOut);
  }, [controller, draggingCameraHandle, hoveredCamera, inspectorView, poppedOut, state.playing]);

  useEffect(() => () => {
    controller.setPreviewTransformHandles(undefined);
    controller.setCameraHandles(false);
  }, [controller]);

  const pickPoint = async (element: HTMLElement, clientX: number, clientY: number, coalesce = false) => {
    const rect = element.getBoundingClientRect();
    const ndcX = (clientX - rect.left) / rect.width * 2 - 1;
    const ndcY = 1 - (clientY - rect.top) / rect.height * 2;
    return controller.pickPreview(ndcX, ndcY, coalesce);
  };

  const pickTarget = async (element: HTMLElement, clientX: number, clientY: number, coalesce = false) => {
    const rect = element.getBoundingClientRect();
    const ndcX = (clientX - rect.left) / rect.width * 2 - 1;
    const ndcY = 1 - (clientY - rect.top) / rect.height * 2;
    return controller.pickPreviewTarget(ndcX, ndcY, coalesce);
  };

  const hoverObject = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (state.playing || draggingClipId || draggingCameraHandleRef.current) return;
    pendingPickRef.current = { x: event.clientX, y: event.clientY };
    if (pickFrameRef.current !== null) return;
    const element = event.currentTarget;
    pickFrameRef.current = requestAnimationFrame(async () => {
      pickFrameRef.current = null;
      const point = pendingPickRef.current;
      if (!point) return;
      const sequence = ++pickSequenceRef.current;
      const target = await pickTarget(element, point.x, point.y, true);
      if (sequence === pickSequenceRef.current) {
        setHoveredClipId(target.clipId ?? null);
        setHoveredHandle(target.handle ?? null);
        setHoveredCamera(Boolean(inspectorView && target.camera));
        const cameraHandle = inspectorView ? target.cameraHandle ?? null : null;
        hoveredCameraHandleRef.current = cameraHandle;
        setHoveredCameraHandle(cameraHandle);
      }
    });
  };

  const selectObjectAtPointer = async (event: ReactMouseEvent<HTMLDivElement>) => {
    if (inspectorNavigationClickRef.current) {
      inspectorNavigationClickRef.current = false;
      return;
    }
    const clipId = await pickPoint(event.currentTarget, event.clientX, event.clientY);
    if (clipId) controller.selectClip(clipId);
    else controller.selectBackground();
  };

  const beginResize = (event: PreviewPointerStart, object: PreviewObjectBounds, handle: string) => {
    if (event.button !== 0 || state.playing) return;
    controller.selectClip(object.clip.id);
    const stage = stageRef.current;
    if (!stage) return;
    const pointerId = event.pointerId;
    const startScaleX = Math.max(1, object.clip.scaleX ?? 100);
    const startScaleY = Math.max(1, object.clip.scaleY ?? 100);
    const startWidth = Math.max(0.04, object.width);
    const startHeight = Math.max(0.04, object.height);
    const startPositionX = object.clip.positionX ?? 0;
    const startPositionY = object.clip.positionY ?? 0;
    const directionX = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
    const directionY = handle.includes("n") ? 1 : handle.includes("s") ? -1 : 0;
    const radians = THREE_DEGREES * object.rotation;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const startPoint = previewWorldPoint(stage, event.clientX, event.clientY, previewWorldWidth, previewWorldHeight);
    const startDx = startPoint.x - object.x;
    const startDy = startPoint.y - object.y;
    const grabOffsetX = cosine * startDx - sine * startDy - directionX * startWidth / 2;
    const grabOffsetY = sine * startDx + cosine * startDy - directionY * startHeight / 2;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const point = previewWorldPoint(stage, pointer.clientX, pointer.clientY, previewWorldWidth, previewWorldHeight);
      const dx = point.x - object.x;
      const dy = point.y - object.y;
      const localX = cosine * dx - sine * dy - grabOffsetX;
      const localY = sine * dx + cosine * dy - grabOffsetY;
      const { scaleX, scaleY, centerOffsetX, centerOffsetY } = resolvePreviewResize({
        startWidth,
        startHeight,
        startScaleX,
        startScaleY,
        localX,
        localY,
        directionX,
        directionY,
        preserveAspect: pointer.shiftKey,
        fromCenter: pointer.ctrlKey || pointer.metaKey,
      });
      const worldOffsetX = cosine * centerOffsetX + sine * centerOffsetY;
      const worldOffsetY = -sine * centerOffsetX + cosine * centerOffsetY;
      controller.updateClip(object.clip.id, {
        scaleX,
        scaleY,
        positionX: startPositionX + worldOffsetX * 100,
        positionY: startPositionY - worldOffsetY * 100,
      });
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const beginMove = (event: PreviewPointerStart, object: PreviewObjectBounds) => {
    if (event.button !== 0 || state.playing) return;
    controller.selectClip(object.clip.id);
    const stage = stageRef.current;
    if (!stage) return;
    const pointerId = event.pointerId;
    let previous = previewWorldPoint(stage, event.clientX, event.clientY, previewWorldWidth, previewWorldHeight);
    let deltaX = 0;
    let deltaY = 0;
    let moveFrame = 0;
    setDraggingClipId(object.clip.id);
    const flushMove = () => {
      moveFrame = 0;
      if (!deltaX && !deltaY) return;
      controller.translatePreviewClip(object.clip.id, deltaX, deltaY, true);
      deltaX = 0;
      deltaY = 0;
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const point = previewWorldPoint(stage, pointer.clientX, pointer.clientY, previewWorldWidth, previewWorldHeight);
      deltaX += (point.x - previous.x) * 100;
      deltaY -= (point.y - previous.y) * 100;
      previous = point;
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (moveFrame) cancelAnimationFrame(moveFrame);
      flushMove();
      controller.finishPreviewInteraction();
      setDraggingClipId(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const beginRotate = (event: PreviewPointerStart, object: PreviewObjectBounds) => {
    if (event.button !== 0 || state.playing) return;
    controller.selectClip(object.clip.id);
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + (0.5 + object.x / previewWorldWidth) * rect.width;
    const centerY = rect.top + (0.5 - object.y / previewWorldHeight) * rect.height;
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const startRotation = object.rotation;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      const angle = Math.atan2(pointer.clientY - centerY, pointer.clientX - centerX);
      controller.updateClip(object.clip.id, { rotation: startRotation + (angle - startAngle) / THREE_DEGREES });
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const beginCameraHandleDrag = (event: ReactPointerEvent<HTMLDivElement>, handle: CameraHandleKind) => {
    if (!inspectorView || state.playing || poppedOut || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    inspectorNavigationClickRef.current = true;
    pickSequenceRef.current += 1;
    const stage = event.currentTarget;
    const pointerId = event.pointerId;
    stage.setPointerCapture(pointerId);
    draggingCameraHandleRef.current = handle;
    setDraggingCameraHandle(handle);
    const start = previewNdc(stage, event.clientX, event.clientY);
    controller.beginCameraHandleInteraction(handle, start.x, start.y);
    let latestX = event.clientX;
    let latestY = event.clientY;
    let moveFrame = 0;
    let moved = false;
    const flushMove = () => {
      moveFrame = 0;
      const point = previewNdc(stage, latestX, latestY);
      controller.moveCameraHandleInteraction(point.x, point.y);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (pointer.clientX === latestX && pointer.clientY === latestY) return;
      latestX = pointer.clientX;
      latestY = pointer.clientY;
      moved = true;
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (moveFrame) cancelAnimationFrame(moveFrame);
      const point = previewNdc(stage, pointer.clientX, pointer.clientY);
      controller.finishCameraHandleInteraction(point.x, point.y, moved);
      draggingCameraHandleRef.current = null;
      setDraggingCameraHandle(null);
      if (pointer.type === "pointercancel") inspectorNavigationClickRef.current = false;
      else window.setTimeout(() => { inspectorNavigationClickRef.current = false; }, 0);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const beginInspectorNavigation = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inspectorView || state.playing || poppedOut || event.button !== 0) return;
    const operation = event.ctrlKey || event.metaKey ? "pan" : event.shiftKey ? "walk" : "orbit";
    event.preventDefault();
    event.stopPropagation();
    inspectorNavigationClickRef.current = true;
    setInspectorNavigation(operation);
    const pointerId = event.pointerId;
    let previousX = event.clientX;
    let previousY = event.clientY;
    let deltaX = 0;
    let deltaY = 0;
    let moveFrame = 0;
    const flushMove = () => {
      moveFrame = 0;
      if (!deltaX && !deltaY) return;
      controller.moveInspectorCamera(operation, deltaX, deltaY);
      deltaX = 0;
      deltaY = 0;
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      deltaX += pointer.clientX - previousX;
      deltaY += pointer.clientY - previousY;
      previousX = pointer.clientX;
      previousY = pointer.clientY;
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (moveFrame) cancelAnimationFrame(moveFrame);
      flushMove();
      if (pointer.type === "pointercancel") inspectorNavigationClickRef.current = false;
      else window.setTimeout(() => { inspectorNavigationClickRef.current = false; }, 0);
      setInspectorNavigation(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const zoomInspectorCamera = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!inspectorView || state.playing || poppedOut) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    if (!delta) return;
    controller.moveCameraAtPlayhead("dolly", 0, delta, event.currentTarget.clientHeight);
    window.clearTimeout(cameraWheelTimerRef.current);
    cameraWheelTimerRef.current = window.setTimeout(controller.finishCameraInteraction, 160);
  };

  const beginStageInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (inspectorView) {
      const cameraHandle = hoveredCameraHandleRef.current;
      if (cameraHandle && !event.ctrlKey && !event.metaKey) beginCameraHandleDrag(event, cameraHandle);
      else beginInspectorNavigation(event);
      return;
    }
    if (state.playing || event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    const pointer: PreviewPointerStart = {
      button: event.button,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    element.setPointerCapture(event.pointerId);
    void pickTarget(element, event.clientX, event.clientY).then((target) => {
      if (!target.clipId) return;
      const objectAtPointer = previewObjects.find((object) => object.clip.id === target.clipId);
      if (!objectAtPointer) return;
      controller.selectClip(target.clipId);
      setHoveredClipId(target.clipId);
      setHoveredHandle(target.handle ?? null);
      // A fast click may finish before the worker answers. Selection still
      // applies, but starting a drag after pointerup would leave stale listeners.
      if (!element.hasPointerCapture(pointer.pointerId)) return;
      if (target.handle === "rotation") beginRotate(pointer, objectAtPointer);
      else if (target.handle) beginResize(pointer, objectAtPointer, target.handle);
      else beginMove(pointer, objectAtPointer);
    });
  };

  return (
    <section className="preview-panel panel" ref={panelRef}>
      <div className="preview-tabs" role="tablist" aria-label={t("プレビュータブ")}>
        <button className={`preview-tab preview-tab-composite ${inspectorView ? "active" : ""}`} role="tab" aria-selected={inspectorView} aria-label={t("インスペクター視点")} aria-keyshortcuts="Control+Meta+1" title={`${t("カメラを含むシーン全体を俯瞰")} (Ctrl+Meta+1)`} onClick={() => { setRecordingTabActive(false); setActiveGfxTextId(null); controller.setPreviewView("inspector"); }}><Inspector /><span>{t("Inspector")}</span></button>
        <button type="button" className={`preview-tab preview-tab-object preview-tab-camera ${!recordingTabActive && !activeGfxTextId && state.activePreviewClipId === null && state.activePreviewView === "camera" ? "active" : ""}`} role="tab" aria-selected={!recordingTabActive && !activeGfxTextId && state.activePreviewClipId === null && state.activePreviewView === "camera"} aria-keyshortcuts="Control+Meta+2" title={`${t("{name}の視点をプレビュー", { name: cameraName })} (Ctrl+Meta+2)`} onClick={() => { setRecordingTabActive(false); setActiveGfxTextId(null); controller.setPreviewView("camera"); }}><Camera /><span>{t("Camera")}</span></button>
        {recordingTabOpen && <div className={`preview-tab preview-tab-object preview-tab-recording ${recordingTabActive ? "active" : ""}`} role="tab" tabIndex={0} aria-selected={recordingTabActive} onClick={() => { setActiveGfxTextId(null); setRecordingTabActive(true); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveGfxTextId(null); setRecordingTabActive(true); } }}><MicRecord /><span>{t("収録")}</span><button type="button" disabled={audioRecording} title={audioRecording ? t("録音を停止してから閉じてください") : undefined} aria-label={t("収録タブを閉じる")} onClick={(event) => { event.stopPropagation(); if (!audioRecording) { setRecordingTabOpen(false); setRecordingTabActive(false); } }}><X /></button></div>}
        {gfxTextTabs.map((entry) => <div key={entry.id} className={`preview-tab preview-tab-object preview-tab-gfxtext ${activeGfxTextId === entry.id ? "active" : ""}`} role="tab" tabIndex={0} aria-selected={activeGfxTextId === entry.id} title={entry.path} onClick={() => { setRecordingTabActive(false); setActiveGfxTextId(entry.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setRecordingTabActive(false); setActiveGfxTextId(entry.id); } }}><TextFont /><span>{entry.name}</span><button type="button" aria-label={t("{name}の編集を閉じる", { name: entry.name })} onClick={(event) => { event.stopPropagation(); setGfxTextTabs((current) => current.filter((item) => item.id !== entry.id)); if (activeGfxTextId === entry.id) setActiveGfxTextId(null); }}><X /></button></div>)}
        {previewTabs.map((clip, index) => <div key={clip.id} className={`preview-tab preview-tab-object ${!recordingTabActive && !activeGfxTextId && state.activePreviewClipId === clip.id ? "active" : ""}`} role="tab" tabIndex={0} aria-selected={!recordingTabActive && !activeGfxTextId && state.activePreviewClipId === clip.id} aria-keyshortcuts={index < 7 ? `Control+Meta+${index + 3}` : undefined} title={`${t("{name}のみをプレビュー", { name: clip.name })}${index < 7 ? ` (Ctrl+Meta+${index + 3})` : ""}`} onClick={() => { setRecordingTabActive(false); setActiveGfxTextId(null); controller.setPreviewTab(clip.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setRecordingTabActive(false); setActiveGfxTextId(null); controller.setPreviewTab(clip.id); } }}><span>{clip.name}</span><button type="button" aria-label={t("{name}のプレビューを閉じる", { name: clip.name })} onClick={(event) => { event.stopPropagation(); controller.closePreviewTab(clip.id); }}><X /></button></div>)}
      </div>
      {activeAudioClip && !recordingTabActive && !activeGfxTextId && <AudioWaveformEditor clip={activeAudioClip} asset={state.assets.find((asset) => asset.id === activeAudioClip.assetId)} />}
      {recordingTabOpen && <AudioRecordingPanel active={recordingTabActive} onRecordingChange={setAudioRecording} />}
      {gfxTextTabs.map((entry) => <GfxTextEditor key={entry.id} entry={entry} active={activeGfxTextId === entry.id} />)}
      <div className={`preview-stage ${inspectorView ? "inspector-view" : ""} ${inspectorNavigation ? `inspector-${inspectorNavigation}` : ""} ${hoveredCameraHandle ? "camera-handle-hover" : ""} ${draggingCameraHandle ? "camera-handle-dragging" : ""} ${activeAudioClip || recordingTabActive || activeGfxTextId ? "preview-content-hidden" : ""} ${poppedOut ? "preview-popped-out" : ""} ${draggingClipId ? "object-dragging" : ""} ${previewCursorClass(hoveredHandle, hoveredObject)}`} ref={stageRef} style={previewStyle} title={inspectorView ? t("ギズモ: 軸操作 / ドラッグ: 周回 / Ctrl+ドラッグ: 上下左右 / Shift+ドラッグ: 前後左右 / ホイール: カメラズーム") : undefined} onPointerDown={beginStageInteraction} onWheel={zoomInspectorCamera} onMouseMove={hoverObject} onMouseLeave={() => { pickSequenceRef.current += 1; setHoveredCamera(false); hoveredCameraHandleRef.current = null; setHoveredCameraHandle(null); if (!draggingClipId) { setHoveredClipId(null); setHoveredHandle(null); } }} onClick={selectObjectAtPointer} onContextMenu={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        controller.openContextMenu({
          x: event.clientX, y: event.clientY, scope: "preview", time: controller.getSnapshot().currentTime, timelineY: 32,
          positionX: ((event.clientX - rect.left) / rect.width - 0.5) * previewWorldWidth * 100,
          positionY: ((event.clientY - rect.top) / rect.height - 0.5) * previewWorldHeight * 100,
        });
      }}>
        {!poppedOut ? <canvas key={surfaceKey} ref={canvasRef} data-preview-tab={state.activePreviewClipId ?? state.activePreviewView} data-camera-projection={state.cameraProjection} data-video-frames={state.videoFramesRendered} data-geometry-objects={state.geometryObjectsReady} data-active-scene-objects={state.activeSceneObjects} data-active-image-objects={state.activeImageObjects} data-playing-audio-objects={state.playingAudioObjects} data-preview-source={state.previewSource} data-cache-frames={state.cachedFramesDisplayed} data-preview-frames={state.previewFramesRendered} /> : <div className="preview-popout-placeholder"><ExternalLink /><span>{t("プレビューは別ウィンドウで表示中です")}</span><button type="button" onClick={(event) => { event.stopPropagation(); popoutRef.current?.close(); }}>{t("この画面に戻す")}</button></div>}
        {selectedFilterObject && !state.playing && !poppedOut && <div
          className="filter-transform-overlay"
          style={filterOverlayStyle(selectedFilterObject, previewWorldWidth, previewWorldHeight)}
          title={t("フィルター作用領域")}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            beginMove(event, selectedFilterObject);
          }}
        >
          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as TransformHandleKind[]).map((handle) => <i
            className={`filter-resize-handle filter-resize-${handle}`}
            data-handle={handle}
            key={handle}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              beginResize(event, selectedFilterObject, handle);
            }}
          />)}
          <i className="filter-rotation-handle" data-handle="rotation" onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            beginRotate(event, selectedFilterObject);
          }} />
          <span>{selectedFilterObject.clip.name}</span>
        </div>}
        {!inspectorView && <div className="safe-area" />}
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

interface PreviewPointerStart {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
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
      else if (left.interpolation === "bezier") alpha = previewBezierAt(left.easing, alpha);
      value = left.value + (right.value - left.value) * alpha;
    }
    (result as unknown as Record<string, unknown>)[property] = value;
  }
  return result;
}

function previewBezierAt(easing: import("../core/interface").ClipKeyframe["easing"], x: number) {
  const { x1, y1, x2, y2 } = easing ?? { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
  let t = x;
  for (let index = 0; index < 6; index++) {
    const inverse = 1 - t;
    const estimate = 3 * inverse * inverse * t * x1 + 3 * inverse * t * t * x2 + t * t * t;
    const derivative = 3 * inverse * inverse * x1 + 6 * inverse * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(derivative) < 0.000001) break;
    t = Math.max(0, Math.min(1, t - (estimate - x) / derivative));
  }
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * y1 + 3 * inverse * t * t * y2 + t * t * t;
}

function previewBounds(clip: TimelineClip, asset?: MediaAsset, filterSize = { width: 16, height: 9 }): PreviewObjectBounds {
  const scale = Math.max(0.001, (clip.scale ?? 100) / 100);
  let width = 2.5;
  let height = 2.5;
  if (clip.kind === "filter") {
    width = filterSize.width;
    height = filterSize.height;
  } else if (clip.kind === "title") {
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

function filterOverlayStyle(object: PreviewObjectBounds, worldWidth: number, worldHeight: number): CSSProperties {
  return {
    left: `${(0.5 + object.x / worldWidth) * 100}%`,
    top: `${(0.5 - object.y / worldHeight) * 100}%`,
    width: `${object.width / worldWidth * 100}%`,
    height: `${object.height / worldHeight * 100}%`,
    transform: `translate(-50%, -50%) rotate(${object.rotation}deg)`,
  };
}

const THREE_DEGREES = Math.PI / 180;

function previewWorldPoint(stage: HTMLElement, clientX: number, clientY: number, worldWidth: number, worldHeight: number) {
  const rect = stage.getBoundingClientRect();
  return { x: ((clientX - rect.left) / rect.width - 0.5) * worldWidth, y: (0.5 - (clientY - rect.top) / rect.height) * worldHeight };
}

function previewNdc(stage: HTMLElement, clientX: number, clientY: number) {
  const rect = stage.getBoundingClientRect();
  return { x: (clientX - rect.left) / rect.width * 2 - 1, y: 1 - (clientY - rect.top) / rect.height * 2 };
}

function previewCursorClass(handle: TransformHandleKind | null, object?: PreviewObjectBounds) {
  if (handle === "rotation") return "preview-cursor-rotation";
  if (!handle) return object ? "preview-cursor-move" : "";
  const direction = { n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 }[handle];
  const rotatedDirection = ((direction + Math.round((object?.rotation ?? 0) / 45)) % 8 + 8) % 8;
  return ["preview-cursor-ns", "preview-cursor-nesw", "preview-cursor-ew", "preview-cursor-nwse"][rotatedDirection % 4];
}
