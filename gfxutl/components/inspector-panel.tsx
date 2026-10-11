import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Plus, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useEditor } from "../core/interface";
import type { ClipEffect, ClipEffectKind, GeometryKind, GeometrySpec, KeyframeProperty, MaterialKind, MediaAsset } from "../core/interface";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";

const GEOMETRY_OPTIONS: GeometryKind[] = ["box", "capsule", "circle", "cone", "cylinder", "dodecahedron", "icosahedron", "octahedron", "plane", "ring", "sphere", "tetrahedron", "torus", "torusKnot", "lathe", "shape", "extrude", "tube", "polyhedron", "edges", "wireframe", "buffer"];
const THREE_RAD_TO_DEG = 180 / Math.PI;
const KEYFRAME_PROPERTIES: Array<[KeyframeProperty, string]> = [["positionX", "位置 X"], ["positionY", "位置 Y"], ["positionZ", "位置 Z"], ["scale", "スケール"], ["scaleX", "横幅"], ["scaleY", "高さ"], ["rotation", "回転 Z"], ["rotationX", "回転 X"], ["rotationY", "回転 Y"], ["opacity", "不透明度"]];
const KEYFRAME_DEFAULTS: Record<KeyframeProperty, number> = { positionX: 0, positionY: 0, positionZ: 0, scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100 };

function defaultGeometry(id: string, kind: GeometryKind): GeometrySpec {
  if (kind === "buffer") return { id, kind, vertices: [-1, -1, 0, 1, -1, 0, 0, 1, 0], indices: [0, 1, 2] };
  if (kind === "polyhedron") return { id, kind, vertices: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], indices: [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1] };
  if (kind === "edges" || kind === "wireframe") return { id, kind, source: { kind: "box" as const } };
  return { id, kind };
}

function NumberField({ label, value, suffix = "", onChange }: { label: string; value: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="number-field"><span>{label}</span><div><input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <small>{suffix}</small>}</div></label>;
}

function TextureField({ label, assets, value, onChange }: { label: string; assets: MediaAsset[]; value?: string; onChange: (value?: string) => void }) {
  return <label className="select-field"><span>{label}</span><select value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">なし</option>{assets.filter((asset) => asset.kind === "image").map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>;
}

export function InspectorPanel() {
  const { state, controller } = useEditor();
  const [audioOpen, setAudioOpen] = useState(true);
  const [tab, setTab] = useState<"inspector" | "metadata">("inspector");
  const [keyframeProperty, setKeyframeProperty] = useState<KeyframeProperty>("positionX");
  const selected = state.clips.find((clip) => clip.id === state.selectedClipId);
  const background = state.backgroundSelected ? state.background : null;
  const asset = state.assets.find((item) => item.id === selected?.assetId) ?? state.assets.find((item) => item.id === state.selectedAssetId);
  return (
    <section className="inspector-panel panel">
      <div className="inspector-tabs"><button className={tab === "inspector" ? "active" : ""} onClick={() => setTab("inspector")}><SlidersHorizontal /> インスペクタ</button><button className={tab === "metadata" ? "active" : ""} onClick={() => setTab("metadata")}>メタデータ</button></div>
      <div className="selected-clip">
        <div><strong>{selected?.name ?? background?.name ?? asset?.name ?? "項目未選択"}</strong><small>{selected ? `${selected.duration.toFixed(1)}秒 · ${selected.kind.toUpperCase()}` : background ? "SCENE · 常時表示" : asset ? `${asset.kind.toUpperCase()} · ${formatBytes(asset.size)}` : "メディアまたはタイムラインから選択"}</small></div>
      </div>
      {tab === "metadata" ? background ? <div className="metadata-view"><div className="metadata-row"><span>名前</span><strong>背景オブジェクト</strong></div><div className="metadata-row"><span>種類</span><strong>SCENE BACKGROUND</strong></div><div className="metadata-row"><span>表示範囲</span><strong>プロジェクト全体</strong></div></div> : <MetadataView clip={selected} asset={asset} fps={state.fps} /> : background ? <div className="inspector-section background-inspector">
        <div className="section-title"><span>背景</span><small>THREE.SCENE</small></div>
        <div className="section-body">
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
      {selected.kind === "title" && <div className="inspector-section text-inspector">
        <div className="section-title"><span>テキストメッシュ</span><small>THREE.TEXT</small></div>
        <div className="section-body">
          <label className="text-editor-field"><span>内容</span><textarea aria-label="テキスト内容" value={selected.text ?? selected.name} onChange={(event) => controller.updateClip(selected.id, { text: event.target.value, name: event.target.value.split("\n")[0].slice(0, 36) || "Text" })} /></label>
          <label className="select-field"><span>フォント</span><select aria-label="フォント" value={selected.fontId ?? ""} onChange={(event) => void controller.setTextFont(selected.id, event.target.value)}><option value="">Helvetiker（内蔵）</option>{state.fonts.map((font) => <option value={font.postscriptName} key={font.postscriptName}>{font.family} {font.style}</option>)}</select></label>
          <div className="font-access-row"><small>{selected.fontFamily ?? "Helvetiker"}</small><Button size="sm" variant="ghost" onClick={controller.loadFonts}>{state.fonts.length ? "フォントを再読込" : "ローカルフォントを読込"}</Button></div>
          <div className="field-grid"><NumberField label="サイズ" value={selected.fontSize ?? 1.2} onChange={(value) => controller.updateClip(selected.id, { fontSize: Math.max(0.01, value) })} /><NumberField label="奥行き" value={selected.textDepth ?? 0.12} onChange={(value) => controller.updateClip(selected.id, { textDepth: Math.max(0, value) })} /></div>
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
      <InspectorSection title="変形" onReset={() => controller.updateClip(selected.id, { positionX: 0, positionY: 0, positionZ: 0, scale: 100, scaleX: 100, scaleY: 100, rotation: 0, rotationX: 0, rotationY: 0, opacity: 100 })}>
        <div className="field-grid transform-position-grid"><NumberField label="位置 X" value={selected.positionX ?? 0} onChange={(value) => controller.updateClip(selected.id, { positionX: value })} /><NumberField label="Y" value={selected.positionY ?? 0} onChange={(value) => controller.updateClip(selected.id, { positionY: value })} /><NumberField label="位置 Z" value={selected.positionZ ?? 0} onChange={(value) => controller.updateClip(selected.id, { positionZ: value })} /></div>
        <div className="field-grid"><NumberField label="スケール" value={selected.scale ?? 100} suffix="%" onChange={(value) => controller.updateClip(selected.id, { scale: value })} /><NumberField label="回転" value={selected.rotation ?? 0} suffix="°" onChange={(value) => controller.updateClip(selected.id, { rotation: value })} /></div>
        {selected.kind === "object" && <div className="field-grid"><NumberField label="回転 X" value={selected.rotationX ?? 0} suffix="°" onChange={(rotationX) => controller.updateClip(selected.id, { rotationX })} /><NumberField label="回転 Y" value={selected.rotationY ?? 0} suffix="°" onChange={(rotationY) => controller.updateClip(selected.id, { rotationY })} /></div>}
        <div className="field-grid"><NumberField label="横幅" value={selected.scaleX ?? 100} suffix="%" onChange={(value) => controller.updateClip(selected.id, { scaleX: Math.max(1, value) })} /><NumberField label="高さ" value={selected.scaleY ?? 100} suffix="%" onChange={(value) => controller.updateClip(selected.id, { scaleY: Math.max(1, value) })} /></div>
        <label className="range-field"><span>不透明度</span><Slider value={selected.opacity ?? 100} min={0} max={100} onChange={(event) => controller.updateClip(selected.id, { opacity: Number(event.target.value) })} /><output>{selected.opacity ?? 100}%</output></label>
      </InspectorSection>
      {(selected.kind === "title" || selected.kind === "object") && <InspectorSection title="シーングラフ" onReset={() => controller.updateClip(selected.id, { parentId: undefined, visible: true, layer: 0 })}>
        <label className="select-field"><span>親オブジェクト</span><select value={selected.parentId ?? ""} onChange={(event) => controller.updateClip(selected.id, { parentId: event.target.value || undefined })}><option value="">Scene root</option>{state.clips.filter((clip) => clip.id !== selected.id && (clip.kind === "title" || clip.kind === "object")).map((clip) => <option value={clip.id} key={clip.id}>{clip.name}</option>)}</select></label>
        <label className="checkbox-field"><input type="checkbox" checked={selected.visible ?? true} onChange={(event) => controller.updateClip(selected.id, { visible: event.target.checked })} /> 表示</label>
        <NumberField label="レイヤー" value={selected.layer ?? 0} onChange={(layer) => controller.updateClip(selected.id, { layer: Math.max(0, Math.min(31, Math.floor(layer))) })} />
      </InspectorSection>}
      {selected.kind !== "audio" && <InspectorSection title="キーフレーム" onReset={() => controller.updateClip(selected.id, { keyframes: [] })}>
        <label className="select-field"><span>プロパティ</span><select value={keyframeProperty} onChange={(event) => setKeyframeProperty(event.target.value as KeyframeProperty)}>{KEYFRAME_PROPERTIES.map(([property, label]) => <option value={property} key={property}>{label}</option>)}</select></label>
        <Button size="sm" onClick={() => controller.addKeyframe(selected.id, keyframeProperty, Number((selected as unknown as Record<string, unknown>)[keyframeProperty] ?? KEYFRAME_DEFAULTS[keyframeProperty]), "smooth")}>現在位置にキーを追加</Button>
        <div className="keyframe-list">{(selected.keyframes ?? []).map((keyframe) => <div className="effect-item" key={keyframe.id}>
          <div className="effect-header"><strong>{KEYFRAME_PROPERTIES.find(([property]) => property === keyframe.property)?.[1] ?? keyframe.property}</strong><small>{keyframe.time.toFixed(2)}s</small><Button variant="ghost" size="icon" onClick={() => controller.removeKeyframe(selected.id, keyframe.id)}><Trash2 /></Button></div>
          <div className="field-grid"><NumberField label="時刻" value={keyframe.time} suffix="s" onChange={(time) => controller.updateKeyframe(selected.id, keyframe.id, { time: Math.max(0, Math.min(selected.duration, time)) })} /><NumberField label="値" value={keyframe.value} onChange={(value) => controller.updateKeyframe(selected.id, keyframe.id, { value })} /></div>
          <label className="select-field"><span>補間</span><select value={keyframe.interpolation} onChange={(event) => controller.updateKeyframe(selected.id, keyframe.id, { interpolation: event.target.value as typeof keyframe.interpolation })}><option value="step">Step</option><option value="linear">Linear</option><option value="smooth">Smooth</option></select></label>
        </div>)}</div>
      </InspectorSection>}
      {selected.kind !== "title" && selected.kind !== "object" && <InspectorSection title="クロップ" onReset={() => controller.updateClip(selected.id, { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 })}>
        <div className="field-grid crop-grid"><NumberField label="左" value={selected.cropLeft ?? 0} onChange={(value) => controller.updateClip(selected.id, { cropLeft: value })} /><NumberField label="右" value={selected.cropRight ?? 0} onChange={(value) => controller.updateClip(selected.id, { cropRight: value })} /><NumberField label="上" value={selected.cropTop ?? 0} onChange={(value) => controller.updateClip(selected.id, { cropTop: value })} /><NumberField label="下" value={selected.cropBottom ?? 0} onChange={(value) => controller.updateClip(selected.id, { cropBottom: value })} /></div>
      </InspectorSection>}
      {selected.kind !== "audio" && !selected.particleSystem && <EffectStack clipId={selected.id} effects={selected.effects ?? []} />}
      {selected.kind !== "title" && selected.kind !== "object" && <div className="inspector-section">
        <div className="section-title"><button className="section-toggle" onClick={() => setAudioOpen(!audioOpen)}>{audioOpen ? <ChevronDown /> : <ChevronRight />}<span>オーディオ</span></button><Button variant="ghost" size="icon" onClick={() => controller.updateClip(selected.id, { volume: 0, pan: 0 })}><RotateCcw /></Button></div>
        {audioOpen && <div className="section-body"><label className="range-field"><span>音量</span><Slider value={selected.volume ?? 0} min={-60} max={12} onChange={(event) => controller.updateClip(selected.id, { volume: Number(event.target.value) })} /><output>{(selected.volume ?? 0).toFixed(1)} dB</output></label><label className="range-field"><span>パン</span><Slider value={selected.pan ?? 0} min={-100} max={100} onChange={(event) => controller.updateClip(selected.id, { pan: Number(event.target.value) })} /><output>{selected.pan ? `${selected.pan > 0 ? "R" : "L"} ${Math.abs(selected.pan)}` : "中央"}</output></label></div>}
      </div>}
      {selected.kind !== "title" && selected.kind !== "object" && <InspectorSection title="速度" onReset={() => controller.updateClip(selected.id, { speed: 100, ripple: true })}>
        <div className="speed-row"><div><input type="number" value={selected.speed ?? 100} min={1} max={1000} onChange={(event) => controller.updateClip(selected.id, { speed: Number(event.target.value) })} /><span>%</span></div><label><input type="checkbox" checked={selected.ripple ?? true} onChange={(event) => controller.updateClip(selected.id, { ripple: event.target.checked })} /> リップル</label></div>
      </InspectorSection>}
      </>}
    </section>
  );
}

function EffectStack({ clipId, effects }: { clipId: string; effects: ClipEffect[] }) {
  const { controller } = useEditor();
  const [kind, setKind] = useState<ClipEffectKind>("brightness");
  const updateParam = (effect: ClipEffect, key: string, value: number) => controller.updateEffect(clipId, effect.id, { params: { ...effect.params, [key]: value } });
  return <div className="inspector-section effect-stack">
    <div className="section-title"><SlidersHorizontal /><span>効果スタック</span><small>{effects.length}</small></div>
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

function InspectorSection({ title, children, onReset }: { title: string; children: React.ReactNode; onReset: () => void }) {
  const [open, setOpen] = useState(true);
  const ToggleIcon = open ? ChevronDown : ChevronRight;
  return <div className={`inspector-section ${open ? "" : "compact"}`}>
    <div className="section-title">
      <ToggleIcon
        className="section-collapse-toggle"
        role="button"
        tabIndex={0}
        aria-label={`${title}を${open ? "折りたたむ" : "展開する"}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen((value) => !value); } }}
      />
      <span>{title}</span><Button variant="ghost" size="icon" onClick={onReset}><RotateCcw /></Button>
    </div>
    {open && <div className="section-body">{children}</div>}
  </div>;
}
