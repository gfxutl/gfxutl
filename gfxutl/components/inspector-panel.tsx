import {
  Add16Regular as Plus,
  ArrowDown16Regular as ArrowDown,
  ArrowHookDownRight16Regular,
  ArrowUp16Regular as ArrowUp,
  ChevronDown16Regular as ChevronDown,
  ChevronRight12Regular,
  ChevronRight16Regular as ChevronRight,
  Delete16Regular as Trash2,
  Eye16Regular as Eye,
  EyeOff16Regular as EyeOff,
  Options16Regular as SlidersHorizontal,
} from "@fluentui/react-icons";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, StreamLanguage } from "@codemirror/language";
import { shader } from "@codemirror/legacy-modes/mode/clike";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "../core/interface";
import type { ClipEffect, ClipEffectKind, ClipMask, ClipPropertyAction, ClipPropertyActionKind, GeometryKind, GeometrySpec, KeyframeProperty, MaterialKind, MediaAsset, SceneSettings, TimelineClip } from "../core/interface";
import { applicableClipActionKinds, CLIP_ACTION_LABELS, DEFAULT_POST_PROCESS_GLSL, resolveClipPropertyActions } from "../core/interface/clip-actions";
import { COMPOSITION_SIZE_PRESETS } from "../core/interface/composition-size";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";
import { FontPicker } from "./font-picker";
import { PluginPanel } from "./plugin-panel";

const GEOMETRY_OPTIONS: GeometryKind[] = ["box", "capsule", "circle", "cone", "cylinder", "dodecahedron", "icosahedron", "octahedron", "plane", "ring", "sphere", "tetrahedron", "torus", "torusKnot", "lathe", "shape", "extrude", "tube", "polyhedron", "edges", "wireframe", "buffer"];
const THREE_RAD_TO_DEG = 180 / Math.PI;
const BASE_KEYFRAME_PROPERTIES: Array<[KeyframeProperty, string]> = [["positionX", "位置 X"], ["positionY", "位置 Y"], ["positionZ", "位置 Z"], ["scale", "スケール"], ["scaleX", "横幅"], ["scaleY", "高さ"], ["rotation", "回転 Z"], ["rotationX", "回転 X"], ["rotationY", "回転 Y"], ["opacity", "不透明度"]];

function keyframeProperties(clip: TimelineClip): Array<[KeyframeProperty, string]> {
  const properties = [...BASE_KEYFRAME_PROPERTIES];
  if (clip.kind === "video") properties.push(["cropLeft", "クロップ 左"], ["cropRight", "クロップ 右"], ["cropTop", "クロップ 上"], ["cropBottom", "クロップ 下"]);
  if (clip.kind === "video" || clip.kind === "audio") properties.push(["volume", "音量"], ["pan", "パン"], ["speed", "速度"]);
  if (clip.kind === "title") {
    properties.push(["fontSize", "文字サイズ"], ["textOutlineWidth", "輪郭の太さ"]);
    if (clip.textMode !== "2d") properties.push(["textDepth", "文字の奥行き"]);
  }
  if (clip.kind === "object") {
    properties.push(["instanceCount", "インスタンス数"], ["instanceSpacing", "インスタンス間隔"]);
    for (const [key, label] of [["color", "材質 色"], ["emissive", "材質 発光色"], ["emissiveIntensity", "材質 発光強度"], ["roughness", "材質 粗さ"], ["metalness", "材質 金属度"], ["clearcoat", "材質 クリアコート"], ["transmission", "材質 透過"], ["ior", "材質 IOR"]] as const) properties.push([`material.${key}`, label]);
  }
  if (clip.particleSystem) for (const [key, label] of [["count", "粒子数"], ["size", "粒子サイズ"], ["spread", "粒子の広がり"], ["speed", "粒子速度"], ["color", "粒子色"]] as const) properties.push([`particleSystem.${key}`, label]);
  for (const mask of clip.masks ?? []) for (const [key, label] of [["x", "X"], ["y", "Y"], ["width", "幅"], ["height", "高さ"], ["feather", "ぼかし"], ["opacity", "不透明度"]] as const) properties.push([`mask.${mask.id}.${key}`, `${mask.name} · ${label}`]);
  for (const effect of clip.effects ?? []) for (const key of Object.keys(effect.params)) properties.push([`effect.${effect.id}.${key}`, `${effect.name} · ${key}`]);
  return properties;
}

function keyframeValue(clip: TimelineClip, property: KeyframeProperty) {
  if (property.startsWith("material.")) return Number((clip.material as unknown as Record<string, unknown> | undefined)?.[property.slice(9)] ?? 0);
  if (property.startsWith("particleSystem.")) return Number((clip.particleSystem as unknown as Record<string, unknown> | undefined)?.[property.slice(15)] ?? 0);
  if (property.startsWith("effect.")) {
    const [, id, key] = property.split(".");
    return Number(clip.effects?.find((effect) => effect.id === id)?.params[key] ?? 0);
  }
  if (property.startsWith("mask.")) {
    const [, id, key] = property.split(".");
    return Number(clip.masks?.find((mask) => mask.id === id)?.[key as keyof ClipMask] ?? 0);
  }
  const defaults: Record<string, number> = { positionX: 0, positionY: 0, positionZ: 0, scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100, volume: 0, pan: 0, speed: 100, fontSize: 1.2, textDepth: 0.12, textOutlineWidth: 0.02, instanceCount: 1, instanceSpacing: 2.5 };
  return Number((clip as unknown as Record<string, unknown>)[property] ?? defaults[property] ?? 0);
}

function defaultGeometry(id: string, kind: GeometryKind): GeometrySpec {
  if (kind === "shape") return { id, kind, points2D: [[-1.5, -1], [1.5, -1], [1.5, 1], [-1.5, 1]] };
  if (kind === "buffer") return { id, kind, vertices: [-1, -1, 0, 1, -1, 0, 0, 1, 0], indices: [0, 1, 2] };
  if (kind === "polyhedron") return { id, kind, vertices: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], indices: [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1] };
  if (kind === "edges" || kind === "wireframe") return { id, kind, source: { kind: "box" as const } };
  return { id, kind };
}

function ShapePathEditor({ points, onChange }: { points: Array<[number, number]>; onChange: (points: Array<[number, number]>) => void }) {
  const serialize = (value: Array<[number, number]>) => value.map(([x, y]) => `${x}, ${y}`).join("\n");
  const [draft, setDraft] = useState(() => serialize(points));
  useEffect(() => setDraft(serialize(points)), [points]);
  const commit = (value: string) => {
    setDraft(value);
    const parsed = value.split(/\n|;/).map((line) => line.split(",").map(Number)).filter((pair) => pair.length === 2 && pair.every(Number.isFinite)) as Array<[number, number]>;
    if (parsed.length >= 3) onChange(parsed);
  };
  const preset = (kind: "rectangle" | "ellipse" | "star") => {
    const next: Array<[number, number]> = kind === "rectangle"
      ? [[-1.5, -1], [1.5, -1], [1.5, 1], [-1.5, 1]]
      : kind === "ellipse"
        ? Array.from({ length: 32 }, (_, index) => { const angle = index / 32 * Math.PI * 2; return [Math.cos(angle) * 1.5, Math.sin(angle)] as [number, number]; })
        : Array.from({ length: 10 }, (_, index) => { const angle = index / 10 * Math.PI * 2 - Math.PI / 2; const radius = index % 2 ? 0.65 : 1.5; return [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number]; });
    setDraft(serialize(next));
    onChange(next);
  };
  return <div className="shape-path-editor">
    <div className="text-decoration-title">パス <small>{points.length} points</small></div>
    <div className="shape-presets"><button onClick={() => preset("rectangle")}>矩形</button><button onClick={() => preset("ellipse")}>楕円</button><button onClick={() => preset("star")}>星</button></div>
    <textarea aria-label="シェイプパス" value={draft} onChange={(event) => commit(event.target.value)} spellCheck={false} />
    <small>1行に X, Y。3点以上で閉じたパスになります。</small>
  </div>;
}

function NumberField({ label, value, suffix = "", onChange }: { label: string; value: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="number-field"><span>{label}</span><div><input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <small>{suffix}</small>}</div></label>;
}

function TextureField({ label, assets, value, onChange }: { label: string; assets: MediaAsset[]; value?: string; onChange: (value?: string) => void }) {
  return <label className="select-field"><span>{label}</span><select value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">なし</option>{assets.filter((asset) => asset.kind === "image").map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>;
}

function sceneKeyframeProperties(scene: SceneSettings) {
  const properties: Array<{ property: string; label: string; value: number }> = [
    ...([0, 1, 2] as const).map((axis) => ({ property: `camera.position.${axis}`, label: `カメラ位置 ${["X", "Y", "Z"][axis]}`, value: scene.camera.position[axis] })),
    ...([0, 1, 2] as const).map((axis) => ({ property: `camera.target.${axis}`, label: `注視点 ${["X", "Y", "Z"][axis]}`, value: scene.camera.target[axis] })),
    { property: "camera.fov", label: "カメラ画角", value: scene.camera.fov },
    { property: "camera.zoom", label: "カメラズーム", value: scene.camera.zoom },
    { property: "camera.orthographicHeight", label: "平行投影の高さ", value: scene.camera.orthographicHeight },
    { property: "renderer.exposure", label: "露出", value: scene.renderer.exposure },
    { property: "renderer.bloomStrength", label: "Bloom 強度", value: scene.renderer.bloomStrength },
    { property: "renderer.bloomRadius", label: "Bloom 半径", value: scene.renderer.bloomRadius },
    { property: "renderer.bloomThreshold", label: "Bloom しきい値", value: scene.renderer.bloomThreshold },
    { property: "background.environmentIntensity", label: "環境強度", value: scene.background.environmentIntensity },
    { property: "background.environmentRotation", label: "環境回転", value: scene.background.environmentRotation },
    { property: "background.backgroundBlurriness", label: "背景ぼかし", value: scene.background.backgroundBlurriness },
    { property: "background.fogNear", label: "Fog Near", value: scene.background.fogNear },
    { property: "background.fogFar", label: "Fog Far", value: scene.background.fogFar },
  ];
  for (const light of scene.lights) {
    const prefix = `${light.kind} ${light.id.slice(0, 6)}`;
    properties.push({ property: `light:${light.id}:intensity`, label: `${prefix} · 強度`, value: light.intensity });
    for (const axis of [0, 1, 2] as const) properties.push({ property: `light:${light.id}:position:${axis}`, label: `${prefix} · 位置 ${["X", "Y", "Z"][axis]}`, value: light.position[axis] });
    if (light.target) for (const axis of [0, 1, 2] as const) properties.push({ property: `light:${light.id}:target:${axis}`, label: `${prefix} · 注視点 ${["X", "Y", "Z"][axis]}`, value: light.target[axis] });
    for (const [field, label, fallback] of [["distance", "距離", 0], ["decay", "減衰", 2], ["angle", "角度", Math.PI / 3], ["penumbra", "半影", 0], ["width", "幅", 4], ["height", "高さ", 4]] as const) {
      if (light[field] !== undefined) properties.push({ property: `light:${light.id}:${field}`, label: `${prefix} · ${label}`, value: light[field] ?? fallback });
    }
  }
  return properties;
}

function SceneKeyframeEditor({ scene, currentTime, fps }: { scene: SceneSettings; currentTime: number; fps: number }) {
  const { controller } = useEditor();
  const properties = sceneKeyframeProperties(scene);
  const [property, setProperty] = useState("camera.position.0");
  const selected = properties.find((item) => item.property === property) ?? properties[0];
  const labels = new Map(properties.map((item) => [item.property, item.label]));
  const keys = scene.keyframes ?? [];
  return <details className="scene-keyframes">
    <summary><ChevronRight12Regular /><span>シーンアニメーション</span><small>{keys.length} KEYS</small></summary>
    <div className="scene-keyframe-body">
      <div className="keyframe-add-row"><select aria-label="シーンキーフレームのプロパティ" value={selected.property} onChange={(event) => setProperty(event.target.value)}>{properties.map((item) => <option key={item.property} value={item.property}>{item.label}</option>)}</select><Button size="sm" onClick={() => controller.addSceneKeyframe(selected.property, selected.value)}><Plus /> 現在値</Button></div>
      <small>{currentTime.toFixed(3)}s（{Math.round(currentTime * fps)}f）に記録</small>
      {keys.length === 0 && <div className="effect-empty">カメラ・ライト・環境を時間変化させます</div>}
      <div className="scene-keyframe-list">{keys.map((keyframe) => <div className="scene-keyframe-row" key={keyframe.id}>
        <strong title={keyframe.property}>{labels.get(keyframe.property) ?? keyframe.property}</strong>
        <NumberField label="時刻" value={keyframe.time} suffix="s" onChange={(time) => controller.updateSceneKeyframe(keyframe.id, { time: Math.max(0, time) })} />
        <NumberField label="値" value={keyframe.value} onChange={(value) => controller.updateSceneKeyframe(keyframe.id, { value })} />
        <label className="select-field"><span>補間</span><select value={keyframe.interpolation} onChange={(event) => controller.updateSceneKeyframe(keyframe.id, { interpolation: event.target.value as typeof keyframe.interpolation })}><option value="step">Step</option><option value="linear">Linear</option><option value="smooth">Smooth</option><option value="bezier">Bezier</option></select></label>
        {keyframe.interpolation === "bezier" && <BezierEditor easing={keyframe.easing} onChange={(easing) => controller.updateSceneKeyframe(keyframe.id, { easing })} />}
        <Button variant="ghost" size="icon" aria-label="シーンキーフレームを削除" onClick={() => controller.removeSceneKeyframe(keyframe.id)}><Trash2 /></Button>
      </div>)}</div>
    </div>
  </details>;
}

export function InspectorPanel() {
  const { state, controller } = useEditor();
  const [tab, setTab] = useState<"properties" | "inspector" | "metadata" | "plugins">("properties");
  const selected = state.clips.find((clip) => clip.id === state.selectedClipId);
  const background = state.backgroundSelected ? state.background : null;
  const asset = state.assets.find((item) => item.id === selected?.assetId) ?? state.assets.find((item) => item.id === state.selectedAssetId);
  return (
    <section className="inspector-panel panel" onContextMenu={(event) => {
      event.preventDefault();
      event.stopPropagation();
      controller.openContextMenu({ x: event.clientX, y: event.clientY, scope: "inspector", time: state.currentTime, timelineY: selected?.y ?? 32, positionX: selected?.positionX ?? 0, positionY: selected?.positionY ?? 0 });
    }}>
      <div className="inspector-tabs">
        <button className={tab === "properties" ? "active" : ""} onClick={() => setTab("properties")}>プロパティ</button>
        <button className={tab === "inspector" ? "active" : ""} onClick={() => setTab("inspector")}>インスペクター</button>
        <button className={tab === "metadata" ? "active" : ""} onClick={() => setTab("metadata")}>メタデータ</button>
        <button className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>プラグイン</button>
      </div>
      {tab !== "inspector" && tab !== "plugins" && <div className="selected-clip">
        <div><strong>{selected?.name ?? background?.name ?? asset?.name ?? "項目未選択"}</strong></div>
      </div>}
      {tab === "plugins" ? <PluginPanel /> : tab === "inspector" ? <RealtimeLayerInspector clips={state.clips} currentTime={state.currentTime} fps={state.fps} selectedClipId={state.selectedClipId} onSelect={controller.selectClip} /> : tab === "metadata" ? background ? <div className="metadata-view"><div className="metadata-row"><span>名前</span><strong>背景オブジェクト</strong></div><div className="metadata-row"><span>種類</span><strong>SCENE BACKGROUND</strong></div><div className="metadata-row"><span>表示範囲</span><strong>プロジェクト全体</strong></div></div> : <MetadataView clip={selected} asset={asset} fps={state.fps} /> : background ? <div className="inspector-section background-inspector">
        <div className="section-title"><span>背景</span><small>THREE.SCENE</small></div>
        <div className="section-body">
          <label className="select-field"><span>サイズ</span><select aria-label="サイズプリセット" value={COMPOSITION_SIZE_PRESETS.some(({ width, height }) => width === background.width && height === background.height) ? `${background.width}x${background.height}` : "custom"} onChange={(event) => {
            const [width, height] = event.target.value.split("x").map(Number);
            if (Number.isFinite(width) && Number.isFinite(height)) controller.updateBackgroundSize(width, height);
          }}>
            {COMPOSITION_SIZE_PRESETS.map(({ width, height }) => <option key={`${width}x${height}`} value={`${width}x${height}`}>{width} × {height}</option>)}
            {!COMPOSITION_SIZE_PRESETS.some(({ width, height }) => width === background.width && height === background.height) && <option value="custom">カスタム</option>}
          </select></label>
          <div className="field-grid composition-size-fields"><NumberField label="幅" value={background.width} suffix="px" onChange={(width) => controller.updateBackgroundSize(width, background.height)} /><NumberField label="高さ" value={background.height} suffix="px" onChange={(height) => controller.updateBackgroundSize(background.width, height)} /></div>
          <label className="color-field"><span>背景色</span><input aria-label="背景色" type="color" value={`#${background.color.toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateBackground({ color: Number.parseInt(event.target.value.slice(1), 16) })} /></label>
          <TextureField label="背景テクスチャ" assets={state.assets} value={background.scene.background.backgroundAssetId} onChange={(backgroundAssetId) => controller.updateSceneSettings({ background: { ...background.scene.background, backgroundAssetId } })} />
          <TextureField label="環境マップ" assets={state.assets} value={background.scene.background.environmentAssetId} onChange={(environmentAssetId) => controller.updateSceneSettings({ background: { ...background.scene.background, environmentAssetId } })} />
          <div className="field-grid"><NumberField label="環境強度" value={background.scene.background.environmentIntensity} onChange={(environmentIntensity) => controller.updateSceneSettings({ background: { ...background.scene.background, environmentIntensity } })} /><NumberField label="環境回転" value={background.scene.background.environmentRotation} suffix="°" onChange={(environmentRotation) => controller.updateSceneSettings({ background: { ...background.scene.background, environmentRotation } })} /></div>
          <NumberField label="背景ぼかし" value={background.scene.background.backgroundBlurriness} onChange={(backgroundBlurriness) => controller.updateSceneSettings({ background: { ...background.scene.background, backgroundBlurriness } })} />
          <label className="select-field"><span>カメラ</span><select aria-label="カメラ投影" value={background.scene.camera.projection} onChange={(event) => controller.updateSceneSettings({ camera: { ...background.scene.camera, projection: event.target.value as "orthographic" | "perspective" } })}><option value="orthographic">Orthographic</option><option value="perspective">Perspective</option></select></label>
          <div className="field-grid"><NumberField label="画角" value={background.scene.camera.fov} suffix="°" onChange={(fov) => controller.updateSceneSettings({ camera: { ...background.scene.camera, fov } })} /><NumberField label="ズーム" value={background.scene.camera.zoom} onChange={(zoom) => controller.updateSceneSettings({ camera: { ...background.scene.camera, zoom } })} /></div>
          <NumberField label="平行投影の高さ" value={background.scene.camera.orthographicHeight} onChange={(orthographicHeight) => controller.updateSceneSettings({ camera: { ...background.scene.camera, orthographicHeight } })} />
          <div className="field-grid"><NumberField label="Near" value={background.scene.camera.near} onChange={(near) => controller.updateSceneSettings({ camera: { ...background.scene.camera, near } })} /><NumberField label="Far" value={background.scene.camera.far} onChange={(far) => controller.updateSceneSettings({ camera: { ...background.scene.camera, far } })} /></div>
          <div className="text-decoration-title">カメラ位置</div>
          <div className="field-grid transform-position-grid">{([0, 1, 2] as const).map((axis) => <NumberField key={axis} label={["X", "Y", "Z"][axis]} value={background.scene.camera.position[axis]} onChange={(value) => { const position = [...background.scene.camera.position] as [number, number, number]; position[axis] = value; controller.updateSceneSettings({ camera: { ...background.scene.camera, position } }); }} />)}</div>
          <div className="text-decoration-title">注視点</div>
          <div className="field-grid transform-position-grid">{([0, 1, 2] as const).map((axis) => <NumberField key={axis} label={["X", "Y", "Z"][axis]} value={background.scene.camera.target[axis]} onChange={(value) => { const target = [...background.scene.camera.target] as [number, number, number]; target[axis] = value; controller.updateSceneSettings({ camera: { ...background.scene.camera, target } }); }} />)}</div>
          <label className="select-field"><span>トーンマップ</span><select aria-label="トーンマッピング" value={background.scene.renderer.toneMapping} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, toneMapping: event.target.value as typeof background.scene.renderer.toneMapping } })}><option value="none">なし</option><option value="linear">Linear</option><option value="reinhard">Reinhard</option><option value="cineon">Cineon</option><option value="aces">ACES</option><option value="agx">AgX</option><option value="neutral">Neutral</option></select></label>
          <NumberField label="露出" value={background.scene.renderer.exposure} onChange={(exposure) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, exposure } })} />
          <label className="select-field"><span>プレビュー解像度</span><select aria-label="プレビュー解像度" value={background.scene.renderer.previewScale ?? 1} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, previewScale: Number(event.target.value) } })}><option value={0.5}>50%（高速）</option><option value={0.75}>75%（推奨）</option><option value={1}>100%</option></select></label>
          <label className="select-field"><span>出力バッファ</span><select value={background.scene.renderer.outputBuffer} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, outputBuffer: event.target.value as "uint8" | "float16" } })}><option value="uint8">8-bit</option><option value="float16">16-bit float (HDR)</option></select></label>
          <label className="checkbox-field"><input type="checkbox" checked={background.scene.renderer.antialias} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, antialias: event.target.checked } })} /> MSAA</label>
          <NumberField label="MSAAサンプル" value={background.scene.renderer.samples} onChange={(samples) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, samples: Math.max(0, Math.floor(samples)) } })} />
          <label className="checkbox-field"><input type="checkbox" checked={background.scene.renderer.shadows} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, shadows: event.target.checked } })} /> シャドウ</label>
          <label className="select-field"><span>影フィルタ</span><select value={background.scene.renderer.shadowType} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, shadowType: event.target.value as typeof background.scene.renderer.shadowType } })}><option value="basic">Basic</option><option value="pcf">PCF</option><option value="pcfSoft">PCF Soft互換</option><option value="vsm">VSM</option></select></label>
          <label className="checkbox-field"><input type="checkbox" checked={background.scene.renderer.transparentBackground} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, transparentBackground: event.target.checked } })} /> 透明背景</label>
          {background.scene.renderer.transparentBackground && <NumberField label="背景アルファ" value={background.scene.background.alpha} onChange={(alpha) => controller.updateSceneSettings({ background: { ...background.scene.background, alpha: Math.max(0, Math.min(1, alpha)) } })} />}
          <div className="text-decoration-title">ポストプロセス</div>
          <label className="checkbox-field"><input type="checkbox" checked={background.scene.renderer.postProcessing} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, postProcessing: event.target.checked } })} /> RenderPipeline</label>
          <label className="checkbox-field"><input type="checkbox" checked={background.scene.renderer.fxaa} onChange={(event) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, fxaa: event.target.checked } })} /> FXAA</label>
          <div className="field-grid"><NumberField label="Bloom" value={background.scene.renderer.bloomStrength} onChange={(bloomStrength) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, bloomStrength: Math.max(0, bloomStrength) } })} /><NumberField label="半径" value={background.scene.renderer.bloomRadius} onChange={(bloomRadius) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, bloomRadius } })} /></div>
          <NumberField label="Bloomしきい値" value={background.scene.renderer.bloomThreshold} onChange={(bloomThreshold) => controller.updateSceneSettings({ renderer: { ...background.scene.renderer, bloomThreshold } })} />
          <label className="checkbox-field"><input type="checkbox" checked={background.scene.background.fogEnabled} onChange={(event) => controller.updateSceneSettings({ background: { ...background.scene.background, fogEnabled: event.target.checked } })} /> Fog</label>
          <label className="color-field"><span>Fog色</span><input type="color" value={`#${background.scene.background.fogColor.toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateSceneSettings({ background: { ...background.scene.background, fogColor: Number.parseInt(event.target.value.slice(1), 16) } })} /></label>
          <div className="field-grid"><NumberField label="Fog Near" value={background.scene.background.fogNear} onChange={(fogNear) => controller.updateSceneSettings({ background: { ...background.scene.background, fogNear } })} /><NumberField label="Fog Far" value={background.scene.background.fogFar} onChange={(fogFar) => controller.updateSceneSettings({ background: { ...background.scene.background, fogFar } })} /></div>
          <div className="text-decoration-title">ライト <Button variant="ghost" size="icon" aria-label="ライトを追加" onClick={() => controller.updateSceneSettings({ lights: [...background.scene.lights, { id: crypto.randomUUID(), kind: "point", color: 0xffffff, intensity: 2, position: [2, 3, 4], distance: 0, decay: 2, castShadow: true }] })}><Plus /></Button></div>
          {background.scene.lights.map((light) => <div className="light-editor" key={light.id}>
            <div className="field-grid"><label className="select-field"><span>種類</span><select value={light.kind} onChange={(event) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, kind: event.target.value as typeof light.kind } : item) })}>{["ambient", "hemisphere", "directional", "point", "spot", "rectArea"].map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label><Button variant="ghost" size="icon" aria-label={`${light.kind}ライトを削除`} onClick={() => controller.updateSceneSettings({ lights: background.scene.lights.filter((item) => item.id !== light.id) })}><Trash2 /></Button></div>
            <div className="field-grid"><NumberField label="強度" value={light.intensity} onChange={(intensity) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, intensity } : item) })} /><label className="compact-color-field"><span>色</span><input type="color" value={`#${light.color.toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, color: Number.parseInt(event.target.value.slice(1), 16) } : item) })} /></label></div>
            {light.kind === "hemisphere" && <label className="color-field"><span>地面色</span><input type="color" value={`#${(light.groundColor ?? 0x303040).toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, groundColor: Number.parseInt(event.target.value.slice(1), 16) } : item) })} /></label>}
            <div className="field-grid transform-position-grid">{([0, 1, 2] as const).map((axis) => <NumberField key={axis} label={["X", "Y", "Z"][axis]} value={light.position[axis]} onChange={(value) => { const position = [...light.position] as [number, number, number]; position[axis] = value; controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, position } : item) }); }} />)}</div>
            {(light.kind === "directional" || light.kind === "spot" || light.kind === "rectArea") && <><small>ターゲット</small><div className="field-grid transform-position-grid">{([0, 1, 2] as const).map((axis) => <NumberField key={axis} label={["X", "Y", "Z"][axis]} value={(light.target ?? [0, 0, 0])[axis]} onChange={(value) => { const target = [...(light.target ?? [0, 0, 0])] as [number, number, number]; target[axis] = value; controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, target } : item) }); }} />)}</div></>}
            {(light.kind === "point" || light.kind === "spot") && <div className="field-grid"><NumberField label="距離" value={light.distance ?? 0} onChange={(distance) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, distance } : item) })} /><NumberField label="減衰" value={light.decay ?? 2} onChange={(decay) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, decay } : item) })} /></div>}
            {light.kind === "spot" && <div className="field-grid"><NumberField label="角度" value={THREE_RAD_TO_DEG * (light.angle ?? Math.PI / 3)} suffix="°" onChange={(angle) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, angle: angle / THREE_RAD_TO_DEG } : item) })} /><NumberField label="半影" value={light.penumbra ?? 0} onChange={(penumbra) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, penumbra } : item) })} /></div>}
            {light.kind === "rectArea" && <div className="field-grid"><NumberField label="幅" value={light.width ?? 4} onChange={(width) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, width } : item) })} /><NumberField label="高さ" value={light.height ?? 4} onChange={(height) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, height } : item) })} /></div>}
            {(light.kind === "directional" || light.kind === "point" || light.kind === "spot") && <label className="checkbox-field"><input type="checkbox" checked={light.castShadow ?? false} onChange={(event) => controller.updateSceneSettings({ lights: background.scene.lights.map((item) => item.id === light.id ? { ...item, castShadow: event.target.checked } : item) })} /> 影を落とす</label>}
          </div>)}
          <SceneKeyframeEditor scene={background.scene} currentTime={state.currentTime} fps={state.fps} />
        </div>
      </div> : !selected ? <div className="metadata-empty">編集するタイムラインクリップを選択してください</div> : selected.kind === "group" ? <div className="inspector-section group-inspector">
        <div className="section-title"><span>タイムライングループ</span><small>{state.clips.filter((clip) => clip.groupId === selected.id).length} ITEMS</small></div>
        <div className="section-body">
          <label className="text-editor-field"><span>名前</span><input aria-label="グループ名" value={selected.name} onChange={(event) => controller.updateClip(selected.id, { name: event.target.value || "グループ" })} /></label>
          <div className="field-grid"><NumberField label="開始" value={selected.start} suffix="s" onChange={(start) => controller.resizeTimelineGroup(selected.id, start, selected.y, selected.duration, selected.groupHeight ?? 156)} /><NumberField label="長さ" value={selected.duration} suffix="s" onChange={(duration) => controller.resizeTimelineGroup(selected.id, selected.start, selected.y, duration, selected.groupHeight ?? 156)} /></div>
          <div className="field-grid"><NumberField label="上端" value={selected.y} suffix="px" onChange={(y) => controller.resizeTimelineGroup(selected.id, selected.start, y, selected.duration, selected.groupHeight ?? 156)} /><NumberField label="高さ" value={selected.groupHeight ?? 156} suffix="px" onChange={(height) => controller.resizeTimelineGroup(selected.id, selected.start, selected.y, selected.duration, height)} /></div>
          <small>境界をまたぐ配置は禁止されます。オブジェクトは完全に内側へ入ると自動的にこのグループへ所属し、外側へ出ると所属が解除されます。</small>
        </div>
      </div> : <>
      <div className="property-base-heading"><span>素体</span><small>{selected.kind.toUpperCase()} OBJECT</small></div>
      {selected.kind === "title" && <div className="inspector-section text-inspector">
        <div className="section-title"><span>{selected.textMode === "2d" ? "2D Text" : "3D Text"}</span><small>{selected.textMode === "2d" ? "CANVAS 2D" : "THREE.TEXT"}</small></div>
        <div className="section-body">
          <label className="text-editor-field"><span>内容</span><textarea aria-label="テキスト内容" value={selected.text ?? selected.name} onChange={(event) => controller.updateClip(selected.id, { text: event.target.value, name: event.target.value.split("\n")[0].slice(0, 36) || (selected.textMode === "2d" ? "2D Text" : "3D Text") })} /></label>
          <FontPicker fonts={state.fonts} value={selected.fontId} loadPreview={controller.loadFontPreview} onChange={(fontId) => void controller.setTextFont(selected.id, fontId)} />
          <div className="font-access-row"><small>{selected.fontFamily ?? (selected.textMode === "2d" ? "sans-serif" : "Helvetiker")}</small><Button size="sm" variant="ghost" onClick={controller.loadFonts}>{state.fonts.length ? "フォントを再読込" : "ローカルフォントを読込"}</Button></div>
          <div className="field-grid"><NumberField label="サイズ" value={selected.fontSize ?? 1.2} onChange={(value) => controller.updateClip(selected.id, { fontSize: Math.max(0.01, value) })} />{selected.textMode !== "2d" && <NumberField label="奥行き" value={selected.textDepth ?? 0.12} onChange={(value) => controller.updateClip(selected.id, { textDepth: Math.max(0, value) })} />}</div>
          <label className="color-field"><span>色</span><input aria-label="テキスト色" type="color" value={`#${(selected.textColor ?? 0x202020).toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateClip(selected.id, { textColor: Number.parseInt(event.target.value.slice(1), 16) })} /></label>
          <div className="text-decoration-title">枠線</div>
          <div className="field-grid"><NumberField label="太さ" value={selected.textOutlineWidth ?? 0.02} onChange={(value) => controller.updateClip(selected.id, { textOutlineWidth: Math.max(0, value) })} /><label className="compact-color-field"><span>色</span><input aria-label="枠線色" type="color" value={`#${(selected.textOutlineColor ?? 0xffffff).toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateClip(selected.id, { textOutlineColor: Number.parseInt(event.target.value.slice(1), 16) })} /></label></div>
        </div>
      </div>}
      {selected.kind === "object" && asset?.kind === "model" && <div className="inspector-section object-inspector">
        <div className="section-title"><span>glTFモデル</span><small>THREE.GLTF</small></div>
        <div className="section-body"><div className="metadata-row"><span>アセット</span><strong>{asset.name}</strong></div><div className="metadata-row"><span>アニメーション</span><strong>タイムライン同期</strong></div><small>埋め込みPBR材質・スキン・モーフ・アニメーションを保持して描画します。</small></div>
      </div>}
      {selected.particleSystem && <div className="inspector-section object-inspector">
        <div className="section-title"><span>GPUパーティクル</span><small>TSL COMPUTE</small></div>
        <div className="section-body">
          <div className="field-grid"><NumberField label="粒子数" value={selected.particleSystem.count} onChange={(count) => controller.updateClip(selected.id, { particleSystem: { ...selected.particleSystem!, count: Math.max(1, Math.min(100_000, Math.floor(count))) } })} /><NumberField label="点サイズ" value={selected.particleSystem.size} onChange={(size) => controller.updateClip(selected.id, { particleSystem: { ...selected.particleSystem!, size: Math.max(0.001, size) } })} /></div>
          <div className="field-grid"><NumberField label="広がり" value={selected.particleSystem.spread} onChange={(spread) => controller.updateClip(selected.id, { particleSystem: { ...selected.particleSystem!, spread } })} /><NumberField label="速度" value={selected.particleSystem.speed} onChange={(speed) => controller.updateClip(selected.id, { particleSystem: { ...selected.particleSystem!, speed } })} /></div>
          <label className="color-field"><span>色</span><input type="color" value={`#${selected.particleSystem.color.toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateClip(selected.id, { particleSystem: { ...selected.particleSystem!, color: Number.parseInt(event.target.value.slice(1), 16) } })} /></label>
          <small>WebGPU: StorageBuffer compute / WebGL2: CPU fallback</small>
        </div>
      </div>}
      {selected.kind === "object" && asset?.kind !== "model" && !selected.particleSystem && <div className="inspector-section object-inspector">
        <div className="section-title"><span>3Dオブジェクト</span><small>THREE.PBR</small></div>
        <div className="section-body">
          <label className="select-field"><span>形状</span><select aria-label="ジオメトリ種類" value={selected.geometry?.kind ?? "box"} onChange={(event) => controller.updateClip(selected.id, { geometry: defaultGeometry(selected.geometry?.id ?? `${selected.id}:geometry`, event.target.value as GeometryKind) })}>{GEOMETRY_OPTIONS.map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label>
          {selected.geometry?.kind === "shape" && <ShapePathEditor points={selected.geometry.points2D ?? []} onChange={(points2D) => controller.updateClip(selected.id, { geometry: { ...selected.geometry!, points2D } })} />}
          <label className="select-field"><span>描画方式</span><select value={selected.primitive ?? "mesh"} onChange={(event) => controller.updateClip(selected.id, { primitive: event.target.value as NonNullable<typeof selected.primitive> })}><option value="mesh">Mesh</option><option value="points">Points</option><option value="line">LineSegments</option><option value="sprite">Sprite</option></select></label>
          <label className="select-field"><span>材質</span><select aria-label="マテリアル種類" value={selected.material?.kind ?? "standard"} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, kind: event.target.value as MaterialKind } })}>{["basic", "lambert", "phong", "standard", "physical", "toon", "normal"].map((kind) => <option value={kind} key={kind}>{kind}</option>)}</select></label>
          <label className="color-field"><span>色</span><input aria-label="オブジェクト色" type="color" value={`#${(selected.material?.color ?? selected.textColor ?? 0x3d73a0).toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, color: Number.parseInt(event.target.value.slice(1), 16) } })} /></label>
          <div className="field-grid"><label className="compact-color-field"><span>発光</span><input type="color" value={`#${(selected.material?.emissive ?? 0).toString(16).padStart(6, "0")}`} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, emissive: Number.parseInt(event.target.value.slice(1), 16) } })} /></label><NumberField label="発光強度" value={selected.material?.emissiveIntensity ?? 1} onChange={(emissiveIntensity) => controller.updateClip(selected.id, { material: { ...selected.material, emissiveIntensity } })} /></div>
          <div className="text-decoration-title">PBRテクスチャ</div>
          <TextureField label="Base Color" assets={state.assets} value={selected.material?.mapAssetId} onChange={(mapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, mapAssetId } })} />
          <TextureField label="Normal" assets={state.assets} value={selected.material?.normalMapAssetId} onChange={(normalMapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, normalMapAssetId } })} />
          <TextureField label="Roughness" assets={state.assets} value={selected.material?.roughnessMapAssetId} onChange={(roughnessMapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, roughnessMapAssetId } })} />
          <TextureField label="Metalness" assets={state.assets} value={selected.material?.metalnessMapAssetId} onChange={(metalnessMapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, metalnessMapAssetId } })} />
          <TextureField label="Emissive" assets={state.assets} value={selected.material?.emissiveMapAssetId} onChange={(emissiveMapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, emissiveMapAssetId } })} />
          <TextureField label="Alpha" assets={state.assets} value={selected.material?.alphaMapAssetId} onChange={(alphaMapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, alphaMapAssetId } })} />
          <TextureField label="AO" assets={state.assets} value={selected.material?.aoMapAssetId} onChange={(aoMapAssetId) => controller.updateClip(selected.id, { material: { ...selected.material, aoMapAssetId } })} />
          <div className="field-grid"><NumberField label="粗さ" value={selected.material?.roughness ?? 0.55} onChange={(roughness) => controller.updateClip(selected.id, { material: { ...selected.material, roughness } })} /><NumberField label="金属度" value={selected.material?.metalness ?? 0.08} onChange={(metalness) => controller.updateClip(selected.id, { material: { ...selected.material, metalness } })} /></div>
          {selected.primitive === "points" && <div className="field-grid"><NumberField label="点サイズ" value={selected.material?.pointSize ?? 0.08} onChange={(pointSize) => controller.updateClip(selected.id, { material: { ...selected.material, pointSize } })} /><label className="checkbox-field"><input type="checkbox" checked={selected.material?.sizeAttenuation ?? true} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, sizeAttenuation: event.target.checked } })} /> 距離減衰</label></div>}
          {selected.material?.kind === "phong" && <NumberField label="光沢" value={selected.material.shininess ?? 30} onChange={(shininess) => controller.updateClip(selected.id, { material: { ...selected.material, shininess } })} />}
          {selected.material?.kind === "physical" && <><div className="field-grid"><NumberField label="クリアコート" value={selected.material.clearcoat ?? 0} onChange={(clearcoat) => controller.updateClip(selected.id, { material: { ...selected.material, clearcoat } })} /><NumberField label="透過" value={selected.material.transmission ?? 0} onChange={(transmission) => controller.updateClip(selected.id, { material: { ...selected.material, transmission } })} /></div><div className="field-grid"><NumberField label="IOR" value={selected.material.ior ?? 1.5} onChange={(ior) => controller.updateClip(selected.id, { material: { ...selected.material, ior } })} /><NumberField label="厚み" value={selected.material.thickness ?? 0} onChange={(thickness) => controller.updateClip(selected.id, { material: { ...selected.material, thickness } })} /></div></>}
          <label className="checkbox-field"><input type="checkbox" checked={selected.castShadow ?? true} onChange={(event) => controller.updateClip(selected.id, { castShadow: event.target.checked })} /> 影を落とす</label>
          <label className="checkbox-field"><input type="checkbox" checked={selected.receiveShadow ?? true} onChange={(event) => controller.updateClip(selected.id, { receiveShadow: event.target.checked })} /> 影を受ける</label>
          <label className="select-field"><span>面</span><select value={selected.material?.side ?? "front"} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, side: event.target.value as "front" | "back" | "double" } })}><option value="front">Front</option><option value="back">Back</option><option value="double">Double</option></select></label>
          <label className="select-field"><span>ブレンド</span><select value={selected.material?.blending ?? "normal"} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, blending: event.target.value as NonNullable<typeof selected.material>["blending"] } })}><option value="normal">Normal</option><option value="add">Add</option><option value="multiply">Multiply</option><option value="subtract">Subtract</option><option value="none">None</option></select></label>
          <div className="field-grid"><label className="checkbox-field"><input type="checkbox" checked={selected.material?.wireframe ?? false} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, wireframe: event.target.checked } })} /> Wireframe</label><label className="checkbox-field"><input type="checkbox" checked={selected.material?.flatShading ?? false} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, flatShading: event.target.checked } })} /> Flat</label></div>
          <div className="field-grid"><label className="checkbox-field"><input type="checkbox" checked={selected.material?.depthTest ?? true} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, depthTest: event.target.checked } })} /> Depth test</label><label className="checkbox-field"><input type="checkbox" checked={selected.material?.depthWrite ?? true} onChange={(event) => controller.updateClip(selected.id, { material: { ...selected.material, depthWrite: event.target.checked } })} /> Depth write</label></div>
          <NumberField label="Alpha test" value={selected.material?.alphaTest ?? 0} onChange={(alphaTest) => controller.updateClip(selected.id, { material: { ...selected.material, alphaTest } })} />
          <div className="text-decoration-title">インスタンス</div>
          <div className="field-grid"><NumberField label="個数" value={selected.instanceCount ?? 1} onChange={(instanceCount) => controller.updateClip(selected.id, { instanceCount: Math.max(1, Math.min(1_000, Math.floor(instanceCount))) })} /><NumberField label="間隔" value={selected.instanceSpacing ?? 2.5} onChange={(instanceSpacing) => controller.updateClip(selected.id, { instanceSpacing })} /></div>
        </div>
      </div>}
      <ClipPropertyActionStack clip={selected} allClips={state.clips} />
      </>}
    </section>
  );
}

function ClipPropertyActionStack({ clip, allClips }: { clip: TimelineClip; allClips: TimelineClip[] }) {
  const { controller } = useEditor();
  const actions = resolveClipPropertyActions(clip);
  const activeKinds = new Set(actions.map((action) => action.kind));
  const available = applicableClipActionKinds(clip).filter((kind) => !activeKinds.has(kind));
  const [requestedKind, setRequestedKind] = useState<ClipPropertyActionKind>(available[0] ?? "transform");
  const addKind = available.includes(requestedKind) ? requestedKind : available[0];
  return <div className="property-action-stack">
    <div className="property-action-stack-heading">
      <div><strong>作用スタック</strong></div>
      <span>{actions.length}</span>
    </div>
    <div className="property-action-list">
      {actions.length === 0 && <div className="property-action-empty">作用はありません。素のオブジェクトがそのまま表示されます。</div>}
      {actions.map((action, index) => <PropertyActionCard key={action.id} action={action} index={index} count={actions.length} onMove={(direction) => controller.moveClipPropertyAction(clip.id, action.id, direction)} onRemove={() => controller.removeClipPropertyAction(clip.id, action.id)}>
        <ClipPropertyActionBody action={action} clip={clip} allClips={allClips} />
      </PropertyActionCard>)}
    </div>
    <div className="property-action-add">
      <select aria-label="追加する作用" disabled={!addKind} value={addKind ?? ""} onChange={(event) => setRequestedKind(event.target.value as ClipPropertyActionKind)}>
        {available.length === 0 ? <option value="">追加できる作用はありません</option> : available.map((kind) => <option value={kind} key={kind}>{CLIP_ACTION_LABELS[kind]}</option>)}
      </select>
      <Button size="sm" disabled={!addKind} onClick={() => addKind && controller.addClipPropertyAction(clip.id, addKind)}><Plus />作用を追加</Button>
    </div>
  </div>;
}

function PropertyActionCard({ action, index, count, onMove, onRemove, children }: { action: ClipPropertyAction; index: number; count: number; onMove: (direction: -1 | 1) => void; onRemove: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const label = CLIP_ACTION_LABELS[action.kind];
  return <div className={`property-action-card ${open ? "" : "compact"}`} data-action-kind={action.kind}>
    <div className="property-action-card-header">
      <button className="property-action-toggle" aria-label={`${label}を${open ? "折りたたむ" : "展開する"}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown /> : <ChevronRight />}</button>
      <span className="property-action-order">{String(index + 1).padStart(2, "0")}</span><strong>{label}</strong>
      <button aria-label={`${label}を上へ`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></button>
      <button aria-label={`${label}を下へ`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown /></button>
      <button className="property-action-remove" aria-label={`${label}作用を削除`} onClick={onRemove}><Trash2 /></button>
    </div>
    {open && <div className="property-action-body">{children}</div>}
  </div>;
}

function ClipPropertyActionBody({ action, clip, allClips }: { action: ClipPropertyAction; clip: TimelineClip; allClips: TimelineClip[] }) {
  const { controller } = useEditor();
  const [keyframeProperty, setKeyframeProperty] = useState<KeyframeProperty>("positionX");
  const animatedProperties = keyframeProperties(clip);
  switch (action.kind) {
    case "transform": return <>
      <div className="field-grid transform-position-grid"><NumberField label="位置 X" value={clip.positionX ?? 0} onChange={(positionX) => controller.updateClip(clip.id, { positionX })} /><NumberField label="Y" value={clip.positionY ?? 0} onChange={(positionY) => controller.updateClip(clip.id, { positionY })} /><NumberField label="位置 Z" value={clip.positionZ ?? 0} onChange={(positionZ) => controller.updateClip(clip.id, { positionZ })} /></div>
      <div className="field-grid"><NumberField label="スケール" value={clip.scale ?? 100} suffix="%" onChange={(scale) => controller.updateClip(clip.id, { scale })} /><NumberField label="回転" value={clip.rotation ?? 0} suffix="°" onChange={(rotation) => controller.updateClip(clip.id, { rotation })} /></div>
      {clip.kind === "object" && <div className="field-grid"><NumberField label="回転 X" value={clip.rotationX ?? 0} suffix="°" onChange={(rotationX) => controller.updateClip(clip.id, { rotationX })} /><NumberField label="回転 Y" value={clip.rotationY ?? 0} suffix="°" onChange={(rotationY) => controller.updateClip(clip.id, { rotationY })} /></div>}
      <div className="field-grid"><NumberField label="横幅" value={clip.scaleX ?? 100} suffix="%" onChange={(scaleX) => controller.updateClip(clip.id, { scaleX: Math.max(1, scaleX) })} /><NumberField label="高さ" value={clip.scaleY ?? 100} suffix="%" onChange={(scaleY) => controller.updateClip(clip.id, { scaleY: Math.max(1, scaleY) })} /></div>
      <label className="range-field"><span>不透明度</span><Slider value={clip.opacity ?? 100} min={0} max={100} onChange={(event) => controller.updateClip(clip.id, { opacity: Number(event.target.value) })} /><output>{clip.opacity ?? 100}%</output></label>
    </>;
    case "sceneGraph": return <>
      <label className="select-field"><span>親オブジェクト</span><select value={clip.parentId ?? ""} onChange={(event) => controller.updateClip(clip.id, { parentId: event.target.value || undefined })}><option value="">Scene root</option>{allClips.filter((item) => item.id !== clip.id && (item.kind === "title" || item.kind === "object")).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label className="checkbox-field"><input type="checkbox" checked={clip.visible ?? true} onChange={(event) => controller.updateClip(clip.id, { visible: event.target.checked })} /> 表示</label>
      <NumberField label="レイヤー" value={clip.layer ?? 0} onChange={(layer) => controller.updateClip(clip.id, { layer: Math.max(0, Math.min(31, Math.floor(layer))) })} />
    </>;
    case "keyframes": return <>
      <label className="select-field"><span>プロパティ</span><select value={keyframeProperty} onChange={(event) => setKeyframeProperty(event.target.value as KeyframeProperty)}>{animatedProperties.map(([property, label]) => <option value={property} key={property}>{label}</option>)}</select></label>
      <Button size="sm" onClick={() => controller.addKeyframe(clip.id, keyframeProperty, keyframeValue(clip, keyframeProperty), "smooth")}>現在位置にキーを追加</Button>
      <div className="keyframe-list">{(clip.keyframes ?? []).map((keyframe) => <div className="effect-item" key={keyframe.id}>
        <div className="effect-header"><strong>{animatedProperties.find(([property]) => property === keyframe.property)?.[1] ?? keyframe.property}</strong><small>{keyframe.time.toFixed(2)}s</small><Button variant="ghost" size="icon" onClick={() => controller.removeKeyframe(clip.id, keyframe.id)}><Trash2 /></Button></div>
        <div className="field-grid"><NumberField label="時刻" value={keyframe.time} suffix="s" onChange={(time) => controller.updateKeyframe(clip.id, keyframe.id, { time: Math.max(0, Math.min(clip.duration, time)) })} /><NumberField label="値" value={keyframe.value} onChange={(value) => controller.updateKeyframe(clip.id, keyframe.id, { value })} /></div>
        <label className="select-field"><span>補間</span><select value={keyframe.interpolation} onChange={(event) => controller.updateKeyframe(clip.id, keyframe.id, { interpolation: event.target.value as typeof keyframe.interpolation, ...(event.target.value === "bezier" && !keyframe.easing ? { easing: { x1: 0.33, y1: 0, x2: 0.67, y2: 1 } } : {}) })}><option value="step">Step</option><option value="linear">Linear</option><option value="smooth">Smooth</option><option value="bezier">Bezier</option></select></label>
        {keyframe.interpolation === "bezier" && <BezierEditor easing={keyframe.easing} onChange={(easing) => controller.updateKeyframe(clip.id, keyframe.id, { easing })} />}
      </div>)}</div>
    </>;
    case "crop": return <div className="field-grid crop-grid"><NumberField label="左" value={clip.cropLeft ?? 0} onChange={(cropLeft) => controller.updateClip(clip.id, { cropLeft })} /><NumberField label="右" value={clip.cropRight ?? 0} onChange={(cropRight) => controller.updateClip(clip.id, { cropRight })} /><NumberField label="上" value={clip.cropTop ?? 0} onChange={(cropTop) => controller.updateClip(clip.id, { cropTop })} /><NumberField label="下" value={clip.cropBottom ?? 0} onChange={(cropBottom) => controller.updateClip(clip.id, { cropBottom })} /></div>;
    case "effects": return <EffectStack clipId={clip.id} effects={clip.effects ?? []} embedded />;
    case "postProcess": return <PostProcessEditor clip={clip} />;
    case "masks": return <MaskStack clipId={clip.id} masks={clip.masks ?? []} embedded />;
    case "audio": return <><label className="range-field"><span>音量</span><Slider value={clip.volume ?? 0} min={-60} max={12} onChange={(event) => controller.updateClip(clip.id, { volume: Number(event.target.value) })} /><output>{(clip.volume ?? 0).toFixed(1)} dB</output></label><label className="range-field"><span>パン</span><Slider value={clip.pan ?? 0} min={-100} max={100} onChange={(event) => controller.updateClip(clip.id, { pan: Number(event.target.value) })} /><output>{clip.pan ? `${clip.pan > 0 ? "R" : "L"} ${Math.abs(clip.pan)}` : "中央"}</output></label></>;
    case "speed": return <div className="speed-row"><div><input type="number" aria-label="速度" value={clip.speed ?? 100} min={1} max={1000} onChange={(event) => controller.updateClip(clip.id, { speed: Number(event.target.value) })} /><span>%</span></div><label><input type="checkbox" checked={clip.ripple ?? true} onChange={(event) => controller.updateClip(clip.id, { ripple: event.target.checked })} /> リップル</label></div>;
  }
}

const POST_PROCESS_PRESETS = {
  passthrough: DEFAULT_POST_PROCESS_GLSL,
  invert: `vec4 gfxPostProcess(vec4 color, vec2 uv, float time) {
  return vec4(vec3(1.0) - color.rgb, color.a);
}`,
  scanline: `vec4 gfxPostProcess(vec4 color, vec2 uv, float time) {
  float line = 0.88 + 0.12 * sin((uv.y + time * 0.08) * 900.0);
  return vec4(color.rgb * line, color.a);
}`,
  channelShift: `vec4 gfxPostProcess(vec4 color, vec2 uv, float time) {
  float pulse = 0.5 + 0.5 * sin(time * 2.0 + uv.y * 12.0);
  return vec4(color.r * (0.85 + pulse * 0.15), color.g, color.b * (1.0 - pulse * 0.12), color.a);
}`,
} as const;

function PostProcessEditor({ clip }: { clip: TimelineClip }) {
  const { controller } = useEditor();
  const shader = clip.postProcess;
  const [draft, setDraft] = useState(shader?.glsl ?? DEFAULT_POST_PROCESS_GLSL);
  useEffect(() => setDraft(shader?.glsl ?? DEFAULT_POST_PROCESS_GLSL), [shader?.id, shader?.glsl]);
  if (!shader) return <div className="shader-empty">ポストプロセスを初期化できませんでした。作用を追加し直してください。</div>;
  return <div className="post-process-editor" data-compile-status={shader.compileStatus}>
    <div className="shader-runtime-row">
      <label><input type="checkbox" checked={shader.enabled} onChange={(event) => controller.updateClipPostProcess(clip.id, { enabled: event.target.checked })} /> 有効</label>
    </div>
    <label className="shader-preset"><span>プリセット</span><select aria-label="GLSLプリセット" defaultValue="passthrough" onChange={(event) => setDraft(POST_PROCESS_PRESETS[event.target.value as keyof typeof POST_PROCESS_PRESETS])}><option value="passthrough">Pass through</option><option value="invert">Invert</option><option value="scanline">Scanline</option><option value="channelShift">Channel shift</option></select></label>
    <GlslCodeEditor value={draft} onChange={setDraft} onSubmit={(source) => void controller.compileClipPostProcess(clip.id, source)} />
    <div className="shader-compile-row"><Button size="sm" disabled={shader.compileStatus === "compiling" || !draft.trim()} onClick={() => void controller.compileClipPostProcess(clip.id, draft)}>コンパイルして適用</Button></div>
    {shader.compileError && <pre className="shader-diagnostic" role="alert">{shader.compileError}</pre>}
  </div>;
}

function GlslCodeEditor({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        oneDark,
        StreamLanguage.define(shader),
        EditorState.tabSize.of(2),
        indentUnit.of("  "),
        keymap.of([
          { key: "Mod-Enter", run: (editor) => { onSubmitRef.current(editor.state.doc.toString()); return true; } },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.contentAttributes.of({ "aria-label": "GLSLシェーダー", spellcheck: "false" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div className="glsl-code-editor" ref={hostRef} />;
}

function RealtimeLayerInspector({ clips, currentTime, fps, selectedClipId, onSelect }: {
  clips: TimelineClip[];
  currentTime: number;
  fps: number;
  selectedClipId: string | null;
  onSelect: (id: string) => void;
}) {
  const names = new Map(clips.map((clip) => [clip.id, clip.name]));
  const activeLayers = clips
    .filter((clip) => clip.kind !== "group" && currentTime >= clip.start && currentTime < clip.start + clip.duration)
    .sort((a, b) => (b.positionZ ?? 0) - (a.positionZ ?? 0) || a.y - b.y || a.start - b.start);
  const frame = Math.max(0, Math.floor(currentTime * fps));
  const kindLabel: Record<TimelineClip["kind"], string> = { video: "映像", audio: "音声", title: "テキスト", object: "3D", group: "グループ" };
  return <div className="realtime-layer-inspector" data-active-layers={activeLayers.length}>
    <div className="layer-inspector-head">
      <div><span className="layer-live"><i />LIVE</span><time dateTime={`PT${currentTime}S`}>{formatLayerTime(currentTime, fps)}</time></div>
      <small>{frame} FRAME</small>
    </div>
    <div className="layer-inspector-summary"><span>再生ヘッド上のレイヤー</span><strong>{activeLayers.length}</strong></div>
    {activeLayers.length === 0 ? <div className="layer-inspector-empty"><span>NO ACTIVE LAYERS</span><small>再生ヘッドをクリップの上へ移動してください</small></div> : <div className="layer-inspector-list">
      {activeLayers.map((clip, index) => {
        const elapsed = Math.max(0, currentTime - clip.start);
        const progress = Math.max(0, Math.min(100, elapsed / Math.max(0.001, clip.duration) * 100));
        const hidden = clip.visible === false;
        return <button
          type="button"
          className={`layer-inspector-item ${clip.id === selectedClipId ? "selected" : ""} ${hidden ? "hidden" : ""}`}
          aria-label={`${clip.name}レイヤーを選択`}
          aria-pressed={clip.id === selectedClipId}
          onClick={() => onSelect(clip.id)}
          key={clip.id}
        >
          <span className="layer-rank">{String(index + 1).padStart(2, "0")}</span>
          <span className="layer-color" style={{ background: clip.color }} />
          <span className="layer-main">
            <span className="layer-name"><strong>{clip.name}</strong><small>{kindLabel[clip.kind]}{hidden ? " · 非表示" : ""}</small></span>
            <span className="layer-progress"><i style={{ width: `${progress}%`, background: clip.color }} /></span>
            <span className="layer-metrics">
              <span>Y {Math.round(clip.y)}</span>
              <span>Z {(clip.positionZ ?? 0).toFixed(1)}</span>
              <span>3D L{clip.layer ?? 0}</span>
              <span>{elapsed.toFixed(2)} / {clip.duration.toFixed(2)}s</span>
            </span>
            {(clip.groupId || clip.parentId) && <span className="layer-parent"><ArrowHookDownRight16Regular />{names.get(clip.groupId ?? clip.parentId!) ?? "親レイヤー"}</span>}
          </span>
        </button>;
      })}
    </div>}
  </div>;
}

function formatLayerTime(seconds: number, fps: number) {
  const safeFps = Math.max(1, fps);
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  const frames = Math.floor(Math.max(0, seconds - wholeSeconds) * safeFps);
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function BezierEditor({ easing = { x1: 0.33, y1: 0, x2: 0.67, y2: 1 }, onChange }: { easing?: import("../core/interface").ClipKeyframe["easing"]; onChange: (value: { x1: number; y1: number; x2: number; y2: number }) => void }) {
  const update = (key: keyof typeof easing, value: number) => onChange({ ...easing, [key]: key === "x1" || key === "x2" ? Math.max(0, Math.min(1, value)) : Math.max(-3, Math.min(3, value)) });
  const beginHandleDrag = (index: 1 | 2, event: React.PointerEvent<SVGCircleElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const move = (pointer: PointerEvent) => {
      const svgX = (pointer.clientX - rect.left) / Math.max(1, rect.width) * 64;
      const svgY = (pointer.clientY - rect.top) / Math.max(1, rect.height) * 60;
      const x = Math.max(0, Math.min(1, (svgX - 4) / 56));
      const y = Math.max(-3, Math.min(3, (56 - svgY) / 52));
      onChange(index === 1 ? { ...easing, x1: x, y1: y } : { ...easing, x2: x, y2: y });
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
  const path = `M 4 56 C ${4 + easing.x1 * 56} ${56 - easing.y1 * 52}, ${4 + easing.x2 * 56} ${56 - easing.y2 * 52}, 60 4`;
  return <div className="bezier-editor">
    <svg viewBox="0 0 64 60" aria-label="Bezierカーブ"><path className="bezier-grid" d="M4 4V56H60M4 30H60M32 4V56" /><path className="bezier-handles" d={`M4 56L${4 + easing.x1 * 56} ${56 - easing.y1 * 52}M60 4L${4 + easing.x2 * 56} ${56 - easing.y2 * 52}`} /><path className="bezier-curve" d={path} /><circle aria-label="Bezier入力ハンドル" cx={4 + easing.x1 * 56} cy={56 - easing.y1 * 52} r="3" onPointerDown={(event) => beginHandleDrag(1, event)} /><circle aria-label="Bezier出力ハンドル" cx={4 + easing.x2 * 56} cy={56 - easing.y2 * 52} r="3" onPointerDown={(event) => beginHandleDrag(2, event)} /></svg>
    <div><NumberField label="In X" value={easing.x1} onChange={(value) => update("x1", value)} /><NumberField label="In Y" value={easing.y1} onChange={(value) => update("y1", value)} /><NumberField label="Out X" value={easing.x2} onChange={(value) => update("x2", value)} /><NumberField label="Out Y" value={easing.y2} onChange={(value) => update("y2", value)} /></div>
    <div className="bezier-presets"><button onClick={() => onChange({ x1: 0.42, y1: 0, x2: 1, y2: 1 })}>Ease In</button><button onClick={() => onChange({ x1: 0, y1: 0, x2: 0.58, y2: 1 })}>Ease Out</button><button onClick={() => onChange({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 })}>Ease</button></div>
  </div>;
}

function MaskStack({ clipId, masks, embedded = false }: { clipId: string; masks: ClipMask[]; embedded?: boolean }) {
  const { controller } = useEditor();
  return <div className={`${embedded ? "embedded-property-stack" : "inspector-section"} mask-stack`}>
    <div className={embedded ? "embedded-stack-heading" : "section-title"}><span>マスク要素</span><small>{masks.length}</small><Button size="sm" variant="ghost" onClick={() => controller.addMask(clipId, "rectangle")}><Plus />追加</Button></div>
    <div className="section-body">
      {masks.length === 0 && <div className="effect-empty">映像・画像の表示範囲を制限します</div>}
      {masks.map((mask) => <div className={`mask-card ${mask.enabled ? "" : "disabled"}`} key={mask.id}>
        <div className="mask-card-header"><button className="effect-enable" onClick={() => controller.updateMask(clipId, mask.id, { enabled: !mask.enabled })}>{mask.enabled ? <Eye /> : <EyeOff />}</button><input aria-label="マスク名" value={mask.name} onChange={(event) => controller.updateMask(clipId, mask.id, { name: event.target.value })} /><button aria-label="マスクを削除" onClick={() => controller.removeMask(clipId, mask.id)}><Trash2 /></button></div>
        {mask.enabled && <>
          <div className="field-grid"><label className="select-field"><span>形</span><select value={mask.shape} onChange={(event) => controller.updateMask(clipId, mask.id, { shape: event.target.value as ClipMask["shape"] })}><option value="rectangle">矩形</option><option value="ellipse">楕円</option></select></label><label className="select-field"><span>合成</span><select value={mask.mode} onChange={(event) => controller.updateMask(clipId, mask.id, { mode: event.target.value as ClipMask["mode"] })}><option value="add">加算</option><option value="subtract">減算</option><option value="intersect">交差</option></select></label></div>
          <div className="field-grid"><NumberField label="X" value={mask.x} suffix="%" onChange={(x) => controller.updateMask(clipId, mask.id, { x })} /><NumberField label="Y" value={mask.y} suffix="%" onChange={(y) => controller.updateMask(clipId, mask.id, { y })} /></div>
          <div className="field-grid"><NumberField label="幅" value={mask.width} suffix="%" onChange={(width) => controller.updateMask(clipId, mask.id, { width: Math.max(0.1, width) })} /><NumberField label="高さ" value={mask.height} suffix="%" onChange={(height) => controller.updateMask(clipId, mask.id, { height: Math.max(0.1, height) })} /></div>
          <div className="field-grid"><NumberField label="ぼかし" value={mask.feather} suffix="%" onChange={(feather) => controller.updateMask(clipId, mask.id, { feather: Math.max(0, feather) })} /><NumberField label="不透明度" value={mask.opacity} suffix="%" onChange={(opacity) => controller.updateMask(clipId, mask.id, { opacity: Math.max(0, Math.min(100, opacity)) })} /></div>
          <label className="checkbox-field"><input type="checkbox" checked={mask.inverted} onChange={(event) => controller.updateMask(clipId, mask.id, { inverted: event.target.checked })} /> 反転</label>
        </>}
      </div>)}
    </div>
  </div>;
}

function EffectStack({ clipId, effects, embedded = false }: { clipId: string; effects: ClipEffect[]; embedded?: boolean }) {
  const { controller } = useEditor();
  const [kind, setKind] = useState<ClipEffectKind>("brightness");
  const updateParam = (effect: ClipEffect, key: string, value: number) => controller.updateEffect(clipId, effect.id, { params: { ...effect.params, [key]: value } });
  return <div className={`${embedded ? "embedded-property-stack" : "inspector-section"} effect-stack`}>
    <div className={embedded ? "embedded-stack-heading" : "section-title"}><SlidersHorizontal /><span>効果要素</span><small>{effects.length}</small></div>
    <div className="effect-add-row">
      <select aria-label="追加する効果" value={kind} onChange={(event) => setKind(event.target.value as ClipEffectKind)}>
        <option value="transform">変形</option><option value="brightness">明るさ</option><option value="contrast">コントラスト</option><option value="saturation">彩度</option><option value="gamma">ガンマ</option><option value="hue">色相</option><option value="tint">色調</option><option value="opacity">透明度</option><option value="chromaKey">クロマキー</option><option value="vignette">ビネット</option><option value="pixelate">ピクセル化</option>
      </select>
      <Button size="sm" onClick={() => controller.addEffect(clipId, kind)}><Plus /> 効果を追加</Button>
    </div>
    <div className="effect-list">
      {effects.length === 0 && <div className="effect-empty">効果を追加すると上から順に合成されます</div>}
      {effects.map((effect, index) => <div className={`effect-card ${effect.enabled ? "" : "disabled"}`} key={effect.id} data-effect-kind={effect.kind}>
        <div className="effect-card-header">
          <button className="effect-enable" aria-label={`${effect.name}を${effect.enabled ? "無効" : "有効"}化`} onClick={() => controller.updateEffect(clipId, effect.id, { enabled: !effect.enabled })}>{effect.enabled ? <Eye /> : <EyeOff />}</button>
          <span className="effect-order">{String(index + 1).padStart(2, "0")}</span><strong>{effect.name}</strong>
          <button aria-label="上へ" disabled={index === 0} onClick={() => controller.moveEffect(clipId, effect.id, -1)}><ArrowUp /></button>
          <button aria-label="下へ" disabled={index === effects.length - 1} onClick={() => controller.moveEffect(clipId, effect.id, 1)}><ArrowDown /></button>
          <button aria-label="効果を削除" onClick={() => controller.removeEffect(clipId, effect.id)}><Trash2 /></button>
        </div>
        {effect.enabled && <div className="effect-params">
          {effect.kind === "transform" && <><div className="field-grid"><NumberField label="位置 X" value={effect.params.x ?? 0} onChange={(value) => updateParam(effect, "x", value)} /><NumberField label="Y" value={effect.params.y ?? 0} onChange={(value) => updateParam(effect, "y", value)} /></div><div className="field-grid"><NumberField label="拡大率" suffix="%" value={effect.params.scale ?? 100} onChange={(value) => updateParam(effect, "scale", value)} /><NumberField label="回転" suffix="°" value={effect.params.rotation ?? 0} onChange={(value) => updateParam(effect, "rotation", value)} /></div></>}
          {effect.kind === "brightness" && <label className="range-field"><span>明るさ</span><Slider value={effect.params.amount ?? 0} min={-100} max={100} onChange={(event) => updateParam(effect, "amount", Number(event.target.value))} /><output>{effect.params.amount ?? 0}</output></label>}
          {effect.kind === "contrast" && <label className="range-field"><span>コントラスト</span><Slider value={effect.params.amount ?? 0} min={-100} max={200} onChange={(event) => updateParam(effect, "amount", Number(event.target.value))} /><output>{effect.params.amount ?? 0}</output></label>}
          {effect.kind === "saturation" && <label className="range-field"><span>彩度</span><Slider value={effect.params.amount ?? 100} min={0} max={300} onChange={(event) => updateParam(effect, "amount", Number(event.target.value))} /><output>{effect.params.amount ?? 100}%</output></label>}
          {effect.kind === "gamma" && <label className="range-field"><span>ガンマ</span><Slider value={effect.params.amount ?? 100} min={10} max={300} onChange={(event) => updateParam(effect, "amount", Number(event.target.value))} /><output>{effect.params.amount ?? 100}%</output></label>}
          {effect.kind === "hue" && <label className="range-field"><span>色相</span><Slider value={effect.params.angle ?? 0} min={-180} max={180} onChange={(event) => updateParam(effect, "angle", Number(event.target.value))} /><output>{effect.params.angle ?? 0}°</output></label>}
          {effect.kind === "tint" && <div className="effect-color-grid"><NumberField label="R" suffix="%" value={effect.params.red ?? 100} onChange={(value) => updateParam(effect, "red", value)} /><NumberField label="G" suffix="%" value={effect.params.green ?? 100} onChange={(value) => updateParam(effect, "green", value)} /><NumberField label="B" suffix="%" value={effect.params.blue ?? 100} onChange={(value) => updateParam(effect, "blue", value)} /></div>}
          {effect.kind === "opacity" && <label className="range-field"><span>透明度</span><Slider value={effect.params.amount ?? 100} min={0} max={100} onChange={(event) => updateParam(effect, "amount", Number(event.target.value))} /><output>{effect.params.amount ?? 100}%</output></label>}
          {effect.kind === "chromaKey" && <><div className="effect-color-grid"><NumberField label="R" suffix="%" value={effect.params.red ?? 0} onChange={(value) => updateParam(effect, "red", value)} /><NumberField label="G" suffix="%" value={effect.params.green ?? 100} onChange={(value) => updateParam(effect, "green", value)} /><NumberField label="B" suffix="%" value={effect.params.blue ?? 0} onChange={(value) => updateParam(effect, "blue", value)} /></div><div className="field-grid"><NumberField label="しきい値" value={effect.params.threshold ?? 20} suffix="%" onChange={(value) => updateParam(effect, "threshold", value)} /><NumberField label="ぼかし" value={effect.params.softness ?? 10} suffix="%" onChange={(value) => updateParam(effect, "softness", value)} /></div></>}
          {effect.kind === "vignette" && <div className="field-grid"><NumberField label="量" value={effect.params.amount ?? 35} suffix="%" onChange={(value) => updateParam(effect, "amount", value)} /><NumberField label="サイズ" value={effect.params.size ?? 65} suffix="%" onChange={(value) => updateParam(effect, "size", value)} /></div>}
          {effect.kind === "pixelate" && <NumberField label="セル数" value={effect.params.size ?? 8} onChange={(value) => updateParam(effect, "size", Math.max(1, value))} />}
        </div>}
      </div>)}
    </div>
  </div>;
}

function MetadataView({ clip, asset, fps }: { clip?: import("../core/interface").TimelineClip; asset?: import("../core/interface").MediaAsset; fps: number }) {
  if (!clip && !asset) return <div className="metadata-empty">メディアまたはクリップを選択してください</div>;
  const rows: Array<[string, string]> = [
    ["名前", asset?.name ?? clip?.name ?? "—"],
    ["種類", asset?.kind.toUpperCase() ?? clip?.kind.toUpperCase() ?? "—"],
    ["コーデック", asset?.codec ?? "—"],
    ["解像度", asset?.width && asset.height ? `${asset.width} × ${asset.height}` : "—"],
    ["メディア長", asset?.duration ? formatMetadataTime(asset.duration, fps) : "静止画"],
    ["ファイルサイズ", asset ? formatBytes(asset.size) : "—"],
    ["ソースI/O", asset?.sourceProfile ? `Media Buffer · ${asset.sourceProfile.readOperations} chunks · ${formatBytes(asset.sourceProfile.bytesRead)}` : "—"],
    ["最大chunk", asset?.sourceProfile ? formatBytes(asset.sourceProfile.largestRead) : "—"],
    ["クリップ開始", clip ? formatMetadataTime(clip.start, fps) : "—"],
    ["クリップ長", clip ? formatMetadataTime(clip.duration, fps) : "—"],
    ["ソースオフセット", clip ? formatMetadataTime(clip.offset, fps) : "—"],
    ["更新日時", asset?.lastModified ? new Date(asset.lastModified).toLocaleString("ja-JP") : "—"],
    ["アセットID", asset?.id ?? "—"],
    ["クリップID", clip?.id ?? "—"],
  ];
  return <div className="metadata-view">{rows.map(([label, value]) => <div className="metadata-row" key={label}><span>{label}</span><strong title={value}>{value}</strong></div>)}</div>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMetadataTime(seconds: number, fps: number) {
  const frames = Math.round(seconds * fps);
  return `${seconds.toFixed(3)} 秒 (${frames} frames)`;
}
