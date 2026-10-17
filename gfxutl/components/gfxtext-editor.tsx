import { TextFont16Regular as TextFont } from "@fluentui/react-icons";
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader, type Font, type FontData } from "three/addons/loaders/FontLoader.js";
import helvetikerData from "three.regular.helvetiker";
import { facetypeCharacterSet } from "../core/fonts/facetype";
import { offsetTextShapes } from "../core/fonts/text-outline";
import { shallowEqual, useEditor } from "../core/interface";
import type {
  GfxTextDocument,
  GfxTextEditorEntry,
  GfxTextMaterialSettings,
  GfxTextTextureSettings,
} from "../core/interface/gfxtext-document";
import { serializeGfxTextDocument } from "../core/interface/gfxtext-document";
import { useI18n } from "../core/i18n";
import { FontPicker } from "./font-picker";

const previewFont = new FontLoader().parse(helvetikerData);
const AUTO_SAVE_DELAY = 450;
const OUTLINE_RENDER_ORDER = 0;
const TEXT_RENDER_ORDER = 1;

type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export function GfxTextEditor({ entry, active }: { entry: GfxTextEditorEntry; active: boolean }) {
  const { state, controller } = useEditor((value) => ({ fonts: value.fonts }), shallowEqual);
  const { t } = useI18n();
  const [document, setDocument] = useState(entry.document);
  const [savedDocument, setSavedDocument] = useState(entry.document);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const documentRef = useRef(document);
  const savedDocumentRef = useRef(savedDocument);
  const handleRef = useRef(entry.handle);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveTimeoutRef = useRef<number | undefined>(undefined);
  const pendingDocumentRef = useRef<GfxTextDocument | undefined>(undefined);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const dirty = serializeGfxTextDocument(document) !== serializeGfxTextDocument(savedDocument);

  documentRef.current = document;
  savedDocumentRef.current = savedDocument;
  handleRef.current = entry.handle;

  useEffect(() => {
    window.clearTimeout(saveTimeoutRef.current);
    setDocument(entry.document);
    setSavedDocument(entry.document);
    setStatus("idle");
    documentRef.current = entry.document;
    savedDocumentRef.current = entry.document;
    pendingDocumentRef.current = undefined;
    revisionRef.current += 1;
  }, [entry.document, entry.path]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(saveTimeoutRef.current);
      const handle = handleRef.current;
      const snapshot = pendingDocumentRef.current;
      if (handle && snapshot) {
        enqueueSave(handle, snapshot, ++revisionRef.current, false);
      }
    };
  }, []);

  const enqueueSave = (handle: FileSystemFileHandle, snapshot: GfxTextDocument, revision: number, updateState = true) => {
    const task = saveQueueRef.current.catch(() => undefined).then(async () => {
      const writable = await handle.createWritable();
      await writable.write(serializeGfxTextDocument(snapshot));
      await writable.close();
    });
    saveQueueRef.current = task;
    void task.then(() => {
      savedDocumentRef.current = snapshot;
      if (updateState && mountedRef.current && revision === revisionRef.current) {
        pendingDocumentRef.current = undefined;
        setSavedDocument(snapshot);
        setStatus("saved");
      }
    }, () => {
      if (updateState && mountedRef.current && revision === revisionRef.current) setStatus("error");
    });
  };

  const scheduleSave = (snapshot: GfxTextDocument) => {
    const handle = handleRef.current;
    if (!handle) return;
    const revision = ++revisionRef.current;
    pendingDocumentRef.current = snapshot;
    window.clearTimeout(saveTimeoutRef.current);
    setStatus("pending");
    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = undefined;
      if (mountedRef.current) setStatus("saving");
      enqueueSave(handle, snapshot, revision);
    }, AUTO_SAVE_DELAY);
  };

  const update = (patch: Partial<GfxTextDocument>) => {
    const next = { ...documentRef.current, ...patch };
    documentRef.current = next;
    setDocument(next);
    scheduleSave(next);
  };

  const updateMaterial = (patch: Partial<GfxTextMaterialSettings>) => {
    update({ material: { ...documentRef.current.material, ...patch } });
  };

  const updateTexture = (texture: GfxTextTextureSettings | undefined) => {
    update({ texture });
  };

  const saveLabel = status === "saving"
    ? t("保存中…")
    : status === "pending" || dirty
      ? t("自動保存待ち")
      : status === "saved"
        ? t("保存済み")
        : "";

  return <div className={`gfxtext-editor ${active ? "active" : ""}`} aria-hidden={!active}>
    <header className="gfxtext-editor-toolbar">
      <TextFont />
      <div><strong>{entry.name}</strong><small>{t("変更は自動保存されます")}</small></div>
      <span className={dirty ? "dirty" : ""}>{saveLabel}</span>
    </header>
    <div className="gfxtext-editor-body">
      <div className="gfxtext-form">
        <label><span>{t("名前")}</span><input value={document.name} onChange={(event) => update({ name: event.target.value })} /></label>
        <label><span>{t("内容")}</span><textarea value={document.text} onChange={(event) => update({ text: event.target.value })} /></label>
        <FontPicker
          fonts={state.fonts}
          value={document.fontId}
          onOpen={controller.loadFonts}
          loadPreview={controller.loadFontPreview}
          onChange={(fontId) => {
            const font = state.fonts.find((item) => item.postscriptName === fontId);
            update({ fontId: fontId || undefined, fontFamily: font?.family ?? "Helvetiker" });
          }}
        />
        <div className="gfxtext-field-grid">
          <NumberInput label={t("サイズ")} value={document.fontSize} minimum={0.01} onChange={(fontSize) => update({ fontSize })} />
          <NumberInput label={t("奥行き")} value={document.textDepth} minimum={0} onChange={(textDepth) => update({ textDepth })} />
        </div>
        <div className="gfxtext-field-grid">
          <ColorInput label={t("色")} value={document.textColor} onChange={(textColor) => update({ textColor })} />
          <ColorInput label={t("枠線色")} value={document.textOutlineColor} onChange={(textOutlineColor) => update({ textOutlineColor })} />
        </div>
        <NumberInput label={t("枠線の太さ")} value={document.textOutlineWidth} minimum={0} onChange={(textOutlineWidth) => update({ textOutlineWidth })} />
        <fieldset className="gfxtext-settings">
          <legend>{t("マテリアル")}</legend>
          <label><span>{t("種類")}</span><select value={document.material.type} onChange={(event) => updateMaterial({ type: event.target.value as GfxTextMaterialSettings["type"] })}>
            <option value="standard">Standard</option>
            <option value="physical">Physical</option>
            <option value="phong">Phong</option>
            <option value="basic">Basic</option>
          </select></label>
          {(document.material.type === "standard" || document.material.type === "physical") && <div className="gfxtext-field-grid">
            <NumberInput label={t("金属度")} value={document.material.metalness} minimum={0} maximum={1} onChange={(metalness) => updateMaterial({ metalness })} />
            <NumberInput label={t("粗さ")} value={document.material.roughness} minimum={0} maximum={1} onChange={(roughness) => updateMaterial({ roughness })} />
          </div>}
          {document.material.type === "phong" && <NumberInput label={t("光沢")} value={document.material.shininess} minimum={0} maximum={200} step={1} onChange={(shininess) => updateMaterial({ shininess })} />}
          {document.material.type === "physical" && <div className="gfxtext-field-grid">
            <NumberInput label={t("クリアコート")} value={document.material.clearcoat} minimum={0} maximum={1} onChange={(clearcoat) => updateMaterial({ clearcoat })} />
            <NumberInput label={t("クリアコートの粗さ")} value={document.material.clearcoatRoughness} minimum={0} maximum={1} onChange={(clearcoatRoughness) => updateMaterial({ clearcoatRoughness })} />
          </div>}
          {document.material.type !== "basic" && <div className="gfxtext-field-grid">
            <ColorInput label={t("発光")} value={document.material.emissive} onChange={(emissive) => updateMaterial({ emissive })} />
            <NumberInput label={t("発光強度")} value={document.material.emissiveIntensity} minimum={0} maximum={20} onChange={(emissiveIntensity) => updateMaterial({ emissiveIntensity })} />
          </div>}
          <NumberInput label={t("不透明度")} value={document.material.opacity} minimum={0} maximum={1} onChange={(opacity) => updateMaterial({ opacity })} />
          <div className="gfxtext-check-grid">
            <label><input type="checkbox" checked={document.material.wireframe} onChange={(event) => updateMaterial({ wireframe: event.target.checked })} />{t("ワイヤーフレーム")}</label>
            {document.material.type !== "basic" && <label><input type="checkbox" checked={document.material.flatShading} onChange={(event) => updateMaterial({ flatShading: event.target.checked })} />{t("フラットシェーディング")}</label>}
          </div>
        </fieldset>
        <TextureSettings texture={document.texture} onChange={updateTexture} loadDroppedImage={controller.loadTextureImageFile} />
        {!entry.handle && <div className="gfxtext-editor-error">{t("このファイルは読み取り専用です")}</div>}
        {status === "error" && entry.handle && <div className="gfxtext-editor-error">{t("3D Textファイルを保存できませんでした")}</div>}
      </div>
      <GfxTextThreePreview
        document={document}
        active={active}
        fontAvailable={!document.fontId || state.fonts.some((font) => font.postscriptName === document.fontId)}
        loadFacetypeFont={controller.loadFacetypeFont}
      />
    </div>
  </div>;
}

interface PreviewSceneState {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  group: THREE.Group;
  renderer: THREE.WebGLRenderer;
  render: () => void;
  resize: () => void;
}

function GfxTextThreePreview({ document, active, fontAvailable, loadFacetypeFont }: {
  document: GfxTextDocument;
  active: boolean;
  fontAvailable: boolean;
  loadFacetypeFont: (fontId: string, characters: string) => Promise<FontData | undefined>;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PreviewSceneState | undefined>(undefined);
  const [rendererError, setRendererError] = useState(false);
  const [geometryError, setGeometryError] = useState(false);
  const [fontStatus, setFontStatus] = useState<"idle" | "loading" | "error">("idle");
  const [textureStatus, setTextureStatus] = useState<"idle" | "loading" | "error">("idle");
  const [textureMap, setTextureMap] = useState<THREE.Texture | undefined>(undefined);
  const [loadedFont, setLoadedFont] = useState<{ key: string; font: Font } | undefined>(undefined);
  const fontKey = document.fontId ? `${document.fontId}\u0000${facetypeCharacterSet(document.text || "Text")}` : "";
  const geometryFont = document.fontId ? loadedFont?.key === fontKey ? loadedFont.font : undefined : previewFont;

  useEffect(() => {
    if (!document.fontId) {
      setLoadedFont(undefined);
      setFontStatus("idle");
      return;
    }
    let cancelled = false;
    setFontStatus("loading");
    const timeout = window.setTimeout(() => {
      void loadFacetypeFont(document.fontId!, document.text || "Text").then((data) => {
        if (cancelled) return;
        if (!data) {
          setLoadedFont(undefined);
          setFontStatus("error");
          return;
        }
        setLoadedFont({ key: fontKey, font: new FontLoader().parse(data) });
        setFontStatus("idle");
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [document.fontId, document.text, fontAvailable, fontKey, loadFacetypeFont]);

  useEffect(() => {
    const source = document.texture?.dataUrl;
    if (!source) {
      setTextureMap(undefined);
      setTextureStatus("idle");
      return;
    }
    let cancelled = false;
    setTextureStatus("loading");
    const texture = new THREE.TextureLoader().load(source, () => {
      if (cancelled) return;
      setTextureStatus("idle");
      sceneRef.current?.render();
    }, undefined, () => {
      if (cancelled) return;
      setTextureStatus("error");
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    setTextureMap(texture);
    return () => {
      cancelled = true;
      texture.dispose();
    };
  }, [document.texture?.dataUrl]);

  useEffect(() => {
    const settings = document.texture;
    if (!textureMap || !settings) return;
    const wrap = settings.wrap === "clamp"
      ? THREE.ClampToEdgeWrapping
      : settings.wrap === "mirror"
        ? THREE.MirroredRepeatWrapping
        : THREE.RepeatWrapping;
    textureMap.wrapS = wrap;
    textureMap.wrapT = wrap;
    textureMap.repeat.set(settings.repeatX, settings.repeatY);
    textureMap.offset.set(settings.offsetX, settings.offsetY);
    textureMap.center.set(0.5, 0.5);
    textureMap.rotation = THREE.MathUtils.degToRad(settings.rotation);
    textureMap.needsUpdate = true;
    sceneRef.current?.render();
  }, [document.texture?.offsetX, document.texture?.offsetY, document.texture?.repeatX, document.texture?.repeatY, document.texture?.rotation, document.texture?.wrap, textureMap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      setRendererError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15191c);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 1000);
    camera.position.set(0, 0.4, 5);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.minDistance = 0.1;
    controls.maxDistance = 500;

    const group = new THREE.Group();
    scene.add(group);
    scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x22252c, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3, 5, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x91bfff, 2.1);
    rim.position.set(-4, 1, -3);
    scene.add(rim);

    const render = () => renderer.render(scene, camera);
    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    sceneRef.current = { camera, controls, group, renderer, render, resize };
    controls.addEventListener("change", render);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    return () => {
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      renderer.dispose();
      sceneRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const preview = sceneRef.current;
    if (!preview || !geometryFont) return;
    const text = Array.from(document.text || "Text")
      .map((character) => character === "\n" || geometryFont.data.glyphs[character] ? character : "?")
      .join("");
    const size = Math.max(0.01, document.fontSize);
    const depth = Math.max(0.001, document.textDepth);
    const bevelThickness = Math.min(document.textDepth * 0.12, document.fontSize * 0.025);
    const bevelSize = Math.min(document.textDepth * 0.08, document.fontSize * 0.015);
    const geometryOptions = {
      font: geometryFont,
      size,
      depth,
      curveSegments: 10,
      bevelEnabled: document.textDepth > 0,
      bevelThickness,
      bevelSize,
      bevelSegments: 2,
    };
    let geometry: TextGeometry;
    try {
      geometry = new TextGeometry(text, geometryOptions);
      setGeometryError(false);
    } catch {
      setGeometryError(true);
      return;
    }
    geometry.computeBoundingBox();
    const textCenter = geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
    geometry.center();
    geometry.computeBoundingSphere();
    const material = createTextMaterial(document, textureMap);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = TEXT_RENDER_ORDER;
    mesh.userData.zIndex = TEXT_RENDER_ORDER;
    preview.group.add(mesh);

    let outlineMaterial: THREE.MeshBasicMaterial | undefined;
    const outlineMeshes: THREE.Mesh[] = [];
    const outlineGeometries = new Set<THREE.BufferGeometry>();
    if (document.textOutlineWidth > 0) {
      outlineMaterial = new THREE.MeshBasicMaterial({
        color: document.textOutlineColor,
        side: THREE.BackSide,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const fontScale = size / geometryFont.data.resolution;
      const lineHeight = (geometryFont.data.boundingBox.yMax - geometryFont.data.boundingBox.yMin + geometryFont.data.underlineThickness) * fontScale;
      const glyphGeometryCache = new Map<string, { geometry: THREE.BufferGeometry; center: THREE.Vector3 }>();
      let offsetX = 0;
      let offsetY = 0;
      for (const character of Array.from(text)) {
        if (character === "\n") {
          offsetX = 0;
          offsetY -= lineHeight;
          continue;
        }
        const glyph = geometryFont.data.glyphs[character] ?? geometryFont.data.glyphs["?"];
        if (glyph.o) {
          let cached = glyphGeometryCache.get(character);
          if (!cached) {
            const characterGeometry = new TextGeometry(character, geometryOptions);
            characterGeometry.computeBoundingBox();
            const center = characterGeometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
            characterGeometry.dispose();
            const outlineShapes = offsetTextShapes(
              geometryFont.generateShapes(character, size),
              bevelSize + document.textOutlineWidth,
              10,
            );
            const outlineGeometry = new THREE.ExtrudeGeometry(outlineShapes, {
              curveSegments: 1,
              steps: 1,
              depth: depth + bevelThickness * 2,
              bevelEnabled: false,
            });
            // Keep the original glyph coordinate system, then align the
            // expanded 2D shell with the centered TextGeometry character.
            outlineGeometry.translate(-center.x, -center.y, -bevelThickness - center.z);
            outlineGeometry.computeBoundingBox();
            outlineGeometry.computeBoundingSphere();
            cached = { geometry: outlineGeometry, center };
            glyphGeometryCache.set(character, cached);
            outlineGeometries.add(outlineGeometry);
          }
          const outlineMesh = new THREE.Mesh(cached.geometry, outlineMaterial);
          outlineMesh.renderOrder = OUTLINE_RENDER_ORDER;
          outlineMesh.userData.zIndex = OUTLINE_RENDER_ORDER;
          outlineMesh.position.set(
            offsetX + cached.center.x - textCenter.x,
            offsetY + cached.center.y - textCenter.y,
            cached.center.z - textCenter.z,
          );
          outlineMeshes.push(outlineMesh);
          preview.group.add(outlineMesh);
        }
        offsetX += glyph.ha * fontScale;
      }
    }

    const radius = Math.max(geometry.boundingSphere?.radius ?? 1, 0.1);
    preview.camera.near = Math.max(0.001, radius / 100);
    preview.camera.far = Math.max(100, radius * 100);
    preview.camera.position.set(radius * 0.2, radius * 0.15, radius * 2.75);
    preview.camera.updateProjectionMatrix();
    preview.controls.target.set(0, 0, 0);
    preview.controls.update();
    preview.render();

    return () => {
      preview.group.remove(mesh);
      outlineMeshes.forEach((outlineMesh) => preview.group.remove(outlineMesh));
      geometry.dispose();
      outlineGeometries.forEach((outlineGeometry) => outlineGeometry.dispose());
      material.dispose();
      outlineMaterial?.dispose();
    };
  }, [document.fontSize, document.material, document.text, document.textColor, document.textDepth, document.textOutlineColor, document.textOutlineWidth, geometryFont, textureMap]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => sceneRef.current?.resize());
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <div className="gfxtext-preview" ref={containerRef}>
    <canvas ref={canvasRef} aria-label={t("3Dプレビュー")} />
    <span className="gfxtext-preview-label">{t("3Dプレビュー")}</span>
    <small className="gfxtext-preview-meta">TextGeometry · {document.fontId ? `facetype.js · ${document.fontFamily}` : "Helvetiker"} · {document.fontSize.toFixed(2)} · depth {document.textDepth.toFixed(2)}</small>
    {fontStatus === "loading" && <div className="gfxtext-preview-status">{t("facetype.jsでローカルフォントを変換中…")}</div>}
    {textureStatus === "loading" && <div className="gfxtext-preview-status gfxtext-texture-status">{t("テクスチャを読み込み中…")}</div>}
    {textureStatus === "error" && <div className="gfxtext-preview-status gfxtext-texture-status error">{t("テクスチャを読み込めませんでした")}</div>}
    {fontStatus === "error" && <div className="gfxtext-preview-error">{t("ローカルフォントを変換できませんでした")}</div>}
    {(rendererError || geometryError) && <div className="gfxtext-preview-error">{t("3Dプレビューを表示できません")}</div>}
  </div>;
}

function createTextMaterial(document: GfxTextDocument, texture: THREE.Texture | undefined): THREE.Material {
  const common = {
    color: document.textColor,
    map: texture,
    opacity: document.material.opacity,
    transparent: document.material.opacity < 1,
    wireframe: document.material.wireframe,
    depthTest: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  };
  switch (document.material.type) {
    case "basic":
      return new THREE.MeshBasicMaterial(common);
    case "phong":
      return new THREE.MeshPhongMaterial({
        ...common,
        emissive: document.material.emissive,
        emissiveIntensity: document.material.emissiveIntensity,
        flatShading: document.material.flatShading,
        shininess: document.material.shininess,
      });
    case "physical":
      return new THREE.MeshPhysicalMaterial({
        ...common,
        clearcoat: document.material.clearcoat,
        clearcoatRoughness: document.material.clearcoatRoughness,
        emissive: document.material.emissive,
        emissiveIntensity: document.material.emissiveIntensity,
        flatShading: document.material.flatShading,
        metalness: document.material.metalness,
        roughness: document.material.roughness,
      });
    default:
      return new THREE.MeshStandardMaterial({
        ...common,
        emissive: document.material.emissive,
        emissiveIntensity: document.material.emissiveIntensity,
        flatShading: document.material.flatShading,
        metalness: document.material.metalness,
        roughness: document.material.roughness,
      });
  }
}

function TextureSettings({ texture, onChange, loadDroppedImage }: {
  texture: GfxTextTextureSettings | undefined;
  onChange: (texture: GfxTextTextureSettings | undefined) => void;
  loadDroppedImage: (assetId?: string, sourcePath?: string) => Promise<File | undefined>;
}) {
  const { t } = useI18n();
  const [dropStatus, setDropStatus] = useState<"idle" | "over" | "loading" | "error">("idle");
  const update = (patch: Partial<GfxTextTextureSettings>) => {
    if (texture) onChange({ ...texture, ...patch });
  };
  const dragOver = (event: ReactDragEvent<HTMLFieldSetElement>) => {
    if (!hasMediaDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (dropStatus !== "loading") setDropStatus("over");
  };
  const dragLeave = (event: ReactDragEvent<HTMLFieldSetElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null) || dropStatus === "loading") return;
    setDropStatus("idle");
  };
  const drop = async (event: ReactDragEvent<HTMLFieldSetElement>) => {
    if (!hasMediaDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const assetId = event.dataTransfer.getData("application/x-gfxutl-asset") || undefined;
    const sourcePath = event.dataTransfer.getData("application/x-gfxutl-path") || undefined;
    const legacyAssetId = !assetId && !sourcePath ? event.dataTransfer.getData("text/plain") || undefined : undefined;
    setDropStatus("loading");
    try {
      const file = await loadDroppedImage(assetId ?? legacyAssetId, sourcePath);
      if (!file) {
        setDropStatus("error");
        return;
      }
      const dataUrl = await readTextureDataUrl(file);
      onChange({
        name: file.name,
        dataUrl,
        repeatX: texture?.repeatX ?? 1,
        repeatY: texture?.repeatY ?? 1,
        offsetX: texture?.offsetX ?? 0,
        offsetY: texture?.offsetY ?? 0,
        rotation: texture?.rotation ?? 0,
        wrap: texture?.wrap ?? "repeat",
      });
      setDropStatus("idle");
    } catch {
      setDropStatus("error");
    }
  };

  return <fieldset
    className={`gfxtext-settings gfxtext-texture-settings ${dropStatus === "over" ? "drag-over" : ""}`}
    onDragEnter={dragOver}
    onDragOver={dragOver}
    onDragLeave={dragLeave}
    onDrop={(event) => void drop(event)}
  >
    <legend>{t("テクスチャ")}</legend>
    <div className="gfxtext-texture-picker">
      {texture ? <img src={texture.dataUrl} alt="" /> : <span>{t("テクスチャなし")}</span>}
      <div>
        <strong title={texture?.name}>{texture?.name ?? t("メディア欄から画像をドロップ")}</strong>
        <small>{t(texture ? "別の画像をドロップして置換" : "PNG、JPEG、WebPに対応")}</small>
        {texture && <button type="button" onClick={() => onChange(undefined)}>{t("削除")}</button>}
      </div>
    </div>
    {texture && <>
      <div className="gfxtext-field-grid">
        <NumberInput label={t("繰り返し X")} value={texture.repeatX} minimum={-100} maximum={100} onChange={(repeatX) => update({ repeatX })} />
        <NumberInput label={t("繰り返し Y")} value={texture.repeatY} minimum={-100} maximum={100} onChange={(repeatY) => update({ repeatY })} />
      </div>
      <div className="gfxtext-field-grid">
        <NumberInput label={t("オフセット X")} value={texture.offsetX} minimum={-100} maximum={100} onChange={(offsetX) => update({ offsetX })} />
        <NumberInput label={t("オフセット Y")} value={texture.offsetY} minimum={-100} maximum={100} onChange={(offsetY) => update({ offsetY })} />
      </div>
      <div className="gfxtext-field-grid">
        <NumberInput label={t("回転（度）")} value={texture.rotation} minimum={-360} maximum={360} step={1} onChange={(rotation) => update({ rotation })} />
        <label><span>{t("ラップ")}</span><select value={texture.wrap} onChange={(event) => update({ wrap: event.target.value as GfxTextTextureSettings["wrap"] })}>
          <option value="repeat">Repeat</option>
          <option value="clamp">Clamp</option>
          <option value="mirror">Mirror</option>
        </select></label>
      </div>
    </>}
    {dropStatus === "loading" && <div className="gfxtext-texture-message">{t("テクスチャを適用中…")}</div>}
    {dropStatus === "error" && <div className="gfxtext-editor-error">{t("画像メディアのみドロップできます")}</div>}
  </fieldset>;
}

function hasMediaDrag(dataTransfer: DataTransfer) {
  return dataTransfer.types.includes("application/x-gfxutl-asset")
    || dataTransfer.types.includes("application/x-gfxutl-path")
    || dataTransfer.types.includes("text/plain");
}

function readTextureDataUrl(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const mimeType = extension === "png"
    ? "image/png"
    : extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : "image/webp";
  const blob = file.type === mimeType ? file : file.slice(0, file.size, mimeType);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid texture data"));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read texture"));
    reader.readAsDataURL(blob);
  });
}

function NumberInput({ label, value, minimum, maximum, step = 0.01, onChange }: { label: string; value: number; minimum: number; maximum?: number; step?: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={minimum} max={maximum} step={step} value={value} onChange={(event) => {
    const numeric = Number(event.target.value) || 0;
    onChange(Math.max(minimum, maximum === undefined ? numeric : Math.min(maximum, numeric)));
  }} /></label>;
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="gfxtext-color"><span>{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /><code>{value}</code></label>;
}
