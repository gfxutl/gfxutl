import * as THREE from "three/webgpu";
import { distance, float, hue, length, max, mix, normalLocal, positionLocal, pow, saturation, sin, smoothstep, texture as textureNode, uv, vec2, vec3, vec4 } from "three/tsl";
import type { ClipEffect, SceneMaterialSpec, SceneObjectSpec } from "../protocol/engine-protocol";
import { createGeometry } from "./three-geometry-factory";
import { loadBuiltInObjectClass } from "./built-in-objects/object-loader";
import { createFilterRegionNodeCache } from "./filter-region-nodes";
import { isNeutralClipEffect } from "./effect-optimization";

interface SceneRecord {
  root: THREE.Object3D;
  fill: THREE.Mesh | THREE.LineSegments | THREE.Points | THREE.Sprite;
  outline?: THREE.Mesh;
  pickProxy?: THREE.Mesh;
  geometryKey: string;
  shapeSignature: string;
  materialKind: string;
  materialSignature: string;
  shadowSignature: string;
  instancesSignature: string;
  transformSignature: string;
}

interface CachedGeometry { geometry: THREE.BufferGeometry; refs: number }

export class ThreeSceneCore {
  private objects = new Map<string, SceneRecord>();
  private geometries = new Map<string, CachedGeometry>();

  constructor(readonly scene: THREE.Scene, private resolveTexture?: (assetId: string, usage: "color" | "data" | "normal") => THREE.Texture | undefined) {}

  get size() { return this.objects.size; }

  getObject(id: string) { return this.objects.get(id)?.root; }

  async upsert(spec: SceneObjectSpec) {
    const geometryKey = JSON.stringify(spec.geometry);
    const outlineWidth = Math.max(0, spec.material?.outlineWidth ?? 0);
    const shapeSignature = `${geometryKey}:${outlineWidth}:${spec.instances?.length ?? 0}`;
    const primitive = spec.geometry.kind === "edges" || spec.geometry.kind === "wireframe" ? "line" : spec.primitive ?? "mesh";
    const isLine = primitive === "line";
    const materialKind = isLine ? "line" : `${primitive}:${spec.material?.kind ?? "basic"}`;
    let record = this.objects.get(spec.id);

    if (!record || record.shapeSignature !== shapeSignature || record.materialKind !== materialKind) {
      if (record) this.remove(spec.id);
      const ObjectClass = await loadBuiltInObjectClass(spec.geometry.kind);
      const geometry = await this.acquireGeometry(geometryKey, spec);
      const material = isLine ? createLineMaterial(spec.material)
        : primitive === "points" ? createPointsMaterial(spec.material)
          : primitive === "sprite" ? createSpriteMaterial(spec.material)
            : createMeshMaterial(spec.material, this.resolveTexture);
      const fill = isLine ? new THREE.LineSegments(geometry, material as THREE.LineBasicMaterial)
        : primitive === "points" ? new THREE.Points(geometry, material as THREE.PointsMaterial)
          : primitive === "sprite" ? new THREE.Sprite(material as THREE.SpriteMaterial)
            : spec.instances?.length ? new THREE.InstancedMesh(geometry, material, spec.instances.length)
              : new ObjectClass(geometry, material);
      let root: THREE.Object3D = fill;
      let outline: THREE.Mesh | undefined;
      let pickProxy: THREE.Mesh | undefined;
      if (outlineWidth > 0 && fill instanceof THREE.Mesh) {
        outline = new THREE.Mesh(geometry, createNormalExtrudedOutlineMaterial(spec.material, outlineWidth));
        outline.name = `${spec.id}:outline`;
        // The displaced shell extends beyond the source geometry bounds.
        outline.frustumCulled = false;
        outline.userData.gfxOutlineMode = "normal-extrusion";
        outline.userData.gfxOutlineWidth = outlineWidth;
      }
      if (spec.geometry.kind === "text" && fill instanceof THREE.Mesh) pickProxy = createTextPickProxy(geometry);
      if (outline || pickProxy) {
        const group = new THREE.Group();
        if (outline) group.add(outline);
        if (pickProxy) group.add(pickProxy);
        group.add(fill);
        root = group;
      }
      record = { root, fill, outline, pickProxy, geometryKey, shapeSignature, materialKind, materialSignature: "", shadowSignature: "", instancesSignature: "", transformSignature: "" };
      this.objects.set(spec.id, record);
    }

    // THREE-OPT: retain materials and touch GPU-facing uniforms only when their spec changed.
    const materialSignature = optimizedMaterialSignature(spec.material);
    if (record.materialSignature !== materialSignature) {
      updateMaterial(record.fill.material, spec.material, this.resolveTexture);
      if (record.outline) updateOutlineMaterial(record.outline.material, spec.material);
      record.materialSignature = materialSignature;
    }
    record.fill.frustumCulled = !(spec.material?.effects ?? []).some((effect) => effect.enabled && !isNeutralClipEffect(effect) && effect.kind === "meshDeform");
    const instancesSignature = JSON.stringify(spec.instances ?? []);
    if (record.fill instanceof THREE.InstancedMesh && record.instancesSignature !== instancesSignature) {
      updateInstances(record.fill, spec.instances ?? []);
      record.instancesSignature = instancesSignature;
    }
    record.fill.renderOrder = spec.renderOrder ?? 0;
    if (record.outline) record.outline.renderOrder = spec.renderOrder ?? 0;
    if (record.pickProxy) record.pickProxy.renderOrder = spec.renderOrder ?? 0;
    const shadowSignature = `${Boolean(spec.castShadow)}:${Boolean(spec.receiveShadow)}`;
    if (record.shadowSignature !== shadowSignature) {
      record.fill.traverse((child) => {
        child.castShadow = Boolean(spec.castShadow);
        child.receiveShadow = Boolean(spec.receiveShadow);
      });
      record.shadowSignature = shadowSignature;
    }
    const transformSignature = JSON.stringify(spec.transform ?? {});
    if (record.transformSignature !== transformSignature) {
      // THREE-OPT: matrix/world propagation is skipped for material-only animation frames.
      applyTransform(record.root, spec);
      record.transformSignature = transformSignature;
    }
    record.root.name = spec.id;
    record.root.visible = spec.visible ?? true;
    record.root.renderOrder = spec.renderOrder ?? 0;
    record.root.layers.set(THREE.MathUtils.clamp(spec.layer ?? 0, 0, 31));
    // THREE-OPT: all managed roots are indexed; recursive scene name lookup is unnecessary.
    const parent = spec.parentId ? this.objects.get(spec.parentId)?.root : undefined;
    const destination = parent && canParent(record.root, parent) ? parent : this.scene;
    // THREE-OPT: Object3D.add reparents and dispatches events; do it only on an actual hierarchy change.
    if (record.root.parent !== destination) destination.add(record.root);
    return record.root;
  }

  private async acquireGeometry(key: string, spec: SceneObjectSpec) {
    const cached = this.geometries.get(key);
    if (cached) { cached.refs++; return cached.geometry; }
    const geometry = await createGeometry(spec.geometry);
    this.geometries.set(key, { geometry, refs: 1 });
    return geometry;
  }

  private releaseGeometry(key: string) {
    const cached = this.geometries.get(key);
    if (!cached) return;
    cached.refs--;
    if (cached.refs <= 0) {
      cached.geometry.dispose();
      this.geometries.delete(key);
    }
  }

  remove(id: string) {
    const record = this.objects.get(id);
    if (!record) return;
    record.root.removeFromParent();
    const materials = new Set<THREE.Material>();
    record.root.traverse((child) => {
      const renderable = child as THREE.Mesh | THREE.LineSegments;
      const childMaterials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      childMaterials.filter(Boolean).forEach((material) => materials.add(material));
    });
    materials.forEach((material) => material.dispose());
    record.pickProxy?.geometry.dispose();
    this.releaseGeometry(record.geometryKey);
    this.objects.delete(id);
  }

  dispose() {
    [...this.objects.keys()].forEach((id) => this.remove(id));
    for (const cached of this.geometries.values()) cached.geometry.dispose();
    this.geometries.clear();
  }
}

function createTextPickProxy(source: THREE.BufferGeometry) {
  if (!source.boundingBox) source.computeBoundingBox();
  const bounds = source.boundingBox;
  if (!bounds || bounds.isEmpty()) return undefined;
  const z = bounds.max.z + 0.0001;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    bounds.min.x, bounds.min.y, z,
    bounds.max.x, bounds.min.y, z,
    bounds.max.x, bounds.max.y, z,
    bounds.min.x, bounds.max.y, z,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  material.visible = false;
  const proxy = new THREE.Mesh(geometry, material);
  proxy.userData.gfxPickProxy = true;
  proxy.castShadow = false;
  proxy.receiveShadow = false;
  return proxy;
}

/**
 * Inverted-hull text outline. The source GfxTextGeometry is retained verbatim and
 * its render position is displaced along the normalized local vertex normal.
 */
export function createNormalExtrudedOutlineMaterial(spec: SceneMaterialSpec = {}, distance = 0) {
  const opacity = spec.opacity ?? 1;
  const material = new THREE.MeshBasicNodeMaterial({
    color: spec.outlineColor ?? 0x000000,
    side: THREE.BackSide,
    transparent: spec.transparent ?? opacity < 1,
    opacity,
    depthTest: spec.depthTest ?? true,
    depthWrite: spec.depthWrite ?? opacity >= 1,
  });
  material.positionNode = positionLocal.add(normalLocal.normalize().mul(Math.max(0, distance)));
  material.userData.gfxOutlineMode = "normal-extrusion";
  material.userData.gfxOutlineWidth = Math.max(0, distance);
  return material;
}

function canParent(object: THREE.Object3D, parent: THREE.Object3D) {
  for (let current: THREE.Object3D | null = parent; current; current = current.parent) if (current === object) return false;
  return object !== parent;
}

// THREE-OPT: worker execution is serialized, so one scratch set safely serves all instance updates.
const instanceMatrix = new THREE.Matrix4();
const instancePosition = new THREE.Vector3();
const instanceRotation = new THREE.Euler();
const instanceQuaternion = new THREE.Quaternion();
const instanceScale = new THREE.Vector3();

function updateInstances(mesh: THREE.InstancedMesh, instances: NonNullable<SceneObjectSpec["instances"]>) {
  instances.forEach((instance, index) => {
    instancePosition.set(...instance.position);
    instanceRotation.set(...(instance.rotation ?? [0, 0, 0]));
    instanceQuaternion.setFromEuler(instanceRotation);
    instanceScale.set(...(instance.scale ?? [1, 1, 1]));
    mesh.setMatrixAt(index, instanceMatrix.compose(instancePosition, instanceQuaternion, instanceScale));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
}

function applyTransform(object: THREE.Object3D, spec: SceneObjectSpec) {
  const transform = spec.transform;
  object.position.set(...(transform?.position ?? [0, 0, 0]));
  if (transform?.quaternion) object.quaternion.set(...transform.quaternion);
  else object.rotation.set(...(transform?.rotation ?? [0, 0, 0]));
  object.scale.set(...(transform?.scale ?? [1, 1, 1]));
  object.updateMatrix();
  object.updateMatrixWorld(true);
}

function materialSide(side: SceneMaterialSpec["side"]) {
  return side === "back" ? THREE.BackSide : side === "double" ? THREE.DoubleSide : THREE.FrontSide;
}

function materialBlending(blending: SceneMaterialSpec["blending"]) {
  return ({ normal: THREE.NormalBlending, add: THREE.AdditiveBlending, multiply: THREE.MultiplyBlending, subtract: THREE.SubtractiveBlending, none: THREE.NoBlending })[blending ?? "normal"];
}

function optimizedMaterialSignature(spec: SceneMaterialSpec = {}) {
  return JSON.stringify({
    ...spec,
    effects: spec.effects?.filter((effect) => effect.enabled && !isNeutralClipEffect(effect)),
  });
}

function hasEffectAlpha(spec: SceneMaterialSpec) {
  return (spec.effects ?? []).some((effect) => effect.enabled && !isNeutralClipEffect(effect) && (effect.kind === "chromaKey" || (effect.kind === "opacity" && Boolean(effect.filterRegion))));
}

function commonMaterialOptions(spec: SceneMaterialSpec = {}) {
  const opacity = spec.opacity ?? 1;
  const effectAlpha = hasEffectAlpha(spec);
  return {
    color: spec.color ?? 0xffffff,
    wireframe: spec.wireframe ?? false,
    side: materialSide(spec.side),
    transparent: (spec.transparent ?? opacity < 1) || effectAlpha,
    opacity,
    depthTest: spec.depthTest ?? true,
    depthWrite: spec.depthWrite ?? (opacity >= 1 && !effectAlpha),
    blending: materialBlending(spec.blending),
    alphaTest: spec.alphaTest ?? 0,
    flatShading: spec.flatShading ?? false,
  };
}

function createMeshMaterial(spec: SceneMaterialSpec = {}, resolveTexture?: (assetId: string, usage: "color" | "data" | "normal") => THREE.Texture | undefined): THREE.Material {
  const options = commonMaterialOptions(spec);
  let material: THREE.Material;
  if (spec.kind === "normal") material = new THREE.MeshNormalNodeMaterial(options);
  else if (spec.kind === "lambert") material = new THREE.MeshLambertNodeMaterial({ ...options, emissive: spec.emissive ?? 0x000000 });
  else if (spec.kind === "phong") material = new THREE.MeshPhongNodeMaterial({ ...options, emissive: spec.emissive ?? 0x000000, shininess: spec.shininess ?? 30 });
  else if (spec.kind === "toon") material = new THREE.MeshToonNodeMaterial(options);
  else if (spec.kind === "standard") material = new THREE.MeshStandardNodeMaterial({ ...options, emissive: spec.emissive ?? 0x000000, emissiveIntensity: spec.emissiveIntensity ?? 1, roughness: spec.roughness ?? 0.5, metalness: spec.metalness ?? 0 });
  else if (spec.kind === "physical") material = new THREE.MeshPhysicalNodeMaterial({
    ...options,
    emissive: spec.emissive ?? 0x000000,
    emissiveIntensity: spec.emissiveIntensity ?? 1,
    roughness: spec.roughness ?? 0.5,
    metalness: spec.metalness ?? 0,
    clearcoat: spec.clearcoat ?? 0,
    clearcoatRoughness: spec.clearcoatRoughness ?? 0,
    transmission: spec.transmission ?? 0,
    thickness: spec.thickness ?? 0,
    ior: spec.ior ?? 1.5,
    sheen: spec.sheen ?? 0,
  });
  else material = new THREE.MeshBasicNodeMaterial(options);
  applyMaterialTextures(material, spec, resolveTexture);
  applyMaterialEffects(material, spec);
  return material;
}

function createLineMaterial(spec: SceneMaterialSpec = {}) {
  return new THREE.LineBasicNodeMaterial({ color: spec.color ?? 0xffffff, transparent: spec.transparent ?? (spec.opacity ?? 1) < 1, opacity: spec.opacity ?? 1, depthTest: spec.depthTest ?? true, depthWrite: spec.depthWrite ?? true, blending: materialBlending(spec.blending) });
}

function createPointsMaterial(spec: SceneMaterialSpec = {}) {
  const material = new THREE.PointsNodeMaterial({ color: spec.color ?? 0xffffff, size: spec.pointSize ?? 0.08, sizeAttenuation: spec.sizeAttenuation ?? true, transparent: spec.transparent ?? (spec.opacity ?? 1) < 1, opacity: spec.opacity ?? 1, depthTest: spec.depthTest ?? true, depthWrite: spec.depthWrite ?? true, blending: materialBlending(spec.blending) });
  applyMaterialEffects(material, spec);
  return material;
}

function createSpriteMaterial(spec: SceneMaterialSpec = {}) {
  const material = new THREE.SpriteNodeMaterial({ color: spec.color ?? 0xffffff, transparent: spec.transparent ?? (spec.opacity ?? 1) < 1, opacity: spec.opacity ?? 1, depthTest: spec.depthTest ?? true, depthWrite: spec.depthWrite ?? true, blending: materialBlending(spec.blending) });
  applyMaterialEffects(material, spec);
  return material;
}

function updateMaterial(material: THREE.Material | THREE.Material[], spec: SceneMaterialSpec = {}, resolveTexture?: (assetId: string, usage: "color" | "data" | "normal") => THREE.Texture | undefined) {
  for (const item of Array.isArray(material) ? material : [material]) {
    const mutable = item as THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number; transmission?: number; thickness?: number; ior?: number; sheen?: number; shininess?: number; wireframe?: boolean; flatShading?: boolean; size?: number; sizeAttenuation?: boolean };
    mutable.color?.setHex(spec.color ?? 0xffffff);
    mutable.emissive?.setHex(spec.emissive ?? 0x000000);
    if (mutable.emissiveIntensity !== undefined) mutable.emissiveIntensity = spec.emissiveIntensity ?? 1;
    if (mutable.roughness !== undefined) mutable.roughness = spec.roughness ?? 0.5;
    if (mutable.metalness !== undefined) mutable.metalness = spec.metalness ?? 0;
    if (mutable.clearcoat !== undefined) mutable.clearcoat = spec.clearcoat ?? 0;
    if (mutable.clearcoatRoughness !== undefined) mutable.clearcoatRoughness = spec.clearcoatRoughness ?? 0;
    if (mutable.transmission !== undefined) mutable.transmission = spec.transmission ?? 0;
    if (mutable.thickness !== undefined) mutable.thickness = spec.thickness ?? 0;
    if (mutable.ior !== undefined) mutable.ior = spec.ior ?? 1.5;
    if (mutable.sheen !== undefined) mutable.sheen = spec.sheen ?? 0;
    if (mutable.shininess !== undefined) mutable.shininess = spec.shininess ?? 30;
    if (mutable.wireframe !== undefined) mutable.wireframe = spec.wireframe ?? false;
    if (mutable.size !== undefined) mutable.size = Math.max(0.001, spec.pointSize ?? 0.08);
    if (mutable.sizeAttenuation !== undefined) mutable.sizeAttenuation = spec.sizeAttenuation ?? true;
    if (mutable.flatShading !== undefined && mutable.flatShading !== (spec.flatShading ?? false)) { mutable.flatShading = spec.flatShading ?? false; mutable.needsUpdate = true; }
    const opacity = spec.opacity ?? 1;
    mutable.opacity = opacity;
    const effectAlpha = hasEffectAlpha(spec);
    mutable.transparent = (spec.transparent ?? opacity < 1) || effectAlpha;
    mutable.depthTest = spec.depthTest ?? true;
    mutable.depthWrite = spec.depthWrite ?? (opacity >= 1 && !effectAlpha);
    mutable.side = materialSide(spec.side);
    mutable.blending = materialBlending(spec.blending);
    mutable.alphaTest = spec.alphaTest ?? 0;
    applyMaterialTextures(mutable, spec, resolveTexture);
    applyMaterialEffects(mutable, spec);
  }
}

function applyMaterialTextures(material: THREE.Material, spec: SceneMaterialSpec, resolveTexture?: (assetId: string, usage: "color" | "data" | "normal") => THREE.Texture | undefined) {
  const mutable = material as THREE.Material & Record<string, unknown>;
  const assignments: Array<[string, string | undefined, "color" | "data" | "normal"]> = [
    ["map", spec.mapAssetId, "color"], ["normalMap", spec.normalMapAssetId, "normal"],
    ["roughnessMap", spec.roughnessMapAssetId, "data"], ["metalnessMap", spec.metalnessMapAssetId, "data"],
    ["emissiveMap", spec.emissiveMapAssetId, "color"], ["alphaMap", spec.alphaMapAssetId, "data"], ["aoMap", spec.aoMapAssetId, "data"],
  ];
  let changed = false;
  for (const [property, assetId, usage] of assignments) {
    if (!(property in mutable)) continue;
    const objectMap = property === "map" ? material.userData.gfxObjectMap as THREE.Texture | undefined : undefined;
    const next = assetId ? resolveTexture?.(assetId, usage) ?? null : objectMap ?? null;
    if (mutable[property] !== next) { mutable[property] = next; changed = true; }
  }
  if (changed) material.needsUpdate = true;
}

function applyMaterialEffects(material: THREE.Material, spec: SceneMaterialSpec) {
  const nodeMaterial = material as THREE.Material & { colorNode?: unknown; positionNode?: unknown; map?: THREE.Texture | null };
  if (!("colorNode" in nodeMaterial)) return;
  const enabledEffects = (spec.effects ?? []).filter((effect) => effect.enabled && !isNeutralClipEffect(effect));
  const filterMasks = createFilterRegionNodeCache();
  nodeMaterial.positionNode = meshDeformedPosition(enabledEffects, filterMasks);
  const effects = enabledEffects.filter((effect) => effect.kind !== "transform" && effect.kind !== "meshDeform");
  if (!effects.length) {
    if (nodeMaterial.colorNode !== null) { nodeMaterial.colorNode = null; material.needsUpdate = true; }
    else material.needsUpdate = true;
    return;
  }
  const color = new THREE.Color(spec.color ?? 0xffffff);
  let rgba: any = nodeMaterial.map ? textureNode(nodeMaterial.map, uv()).mul(vec4(color.r, color.g, color.b, 1)) : vec4(color.r, color.g, color.b, 1);
  if (nodeMaterial.map) for (const effect of effects) {
    if (effect.kind !== "pixelate") continue;
    const cells = Math.max(1, effect.params.size ?? 8);
    const pixelated = textureNode(nodeMaterial.map, uv().mul(cells).floor().add(0.5).div(cells)).mul(vec4(color.r, color.g, color.b, 1));
    rgba = effect.filterRegion ? mix(rgba, pixelated, filterMasks.fragment(effect.filterRegion)) : pixelated;
  }
  let rgb: any = rgba.rgb;
  let alpha: any = rgba.a;
  for (const effect of effects) {
    if (effect.kind === "pixelate") continue;
    const previousRgb = rgb;
    const previousAlpha = alpha;
    let nextRgb = rgb;
    let nextAlpha = alpha;
    if (effect.kind === "brightness") nextRgb = rgb.mul(Math.max(0, 1 + (effect.params.amount ?? 0) / 100));
    else if (effect.kind === "tint") nextRgb = rgb.mul(vec3((effect.params.red ?? 100) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 100) / 100));
    else if (effect.kind === "opacity" && effect.filterRegion) nextAlpha = alpha.mul(THREE.MathUtils.clamp((effect.params.amount ?? 100) / 100, 0, 1));
    else if (effect.kind === "contrast") nextRgb = rgb.sub(0.5).mul(Math.max(0, 1 + (effect.params.amount ?? 0) / 100)).add(0.5);
    else if (effect.kind === "saturation") nextRgb = saturation(rgb, Math.max(0, (effect.params.amount ?? 100) / 100));
    else if (effect.kind === "gamma") nextRgb = pow(max(rgb, vec3(0)), vec3(1 / Math.max(0.01, (effect.params.amount ?? 100) / 100)));
    else if (effect.kind === "hue") nextRgb = hue(rgb, THREE.MathUtils.degToRad(effect.params.angle ?? 0));
    else if (effect.kind === "chromaKey") {
      const key = vec3((effect.params.red ?? 0) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 0) / 100);
      const threshold = (effect.params.threshold ?? 20) / 100;
      nextAlpha = alpha.mul(smoothstep(float(threshold), float(threshold + Math.max(0.001, (effect.params.softness ?? 10) / 100)), distance(rgb, key)));
    } else if (effect.kind === "vignette") {
      const radius = Math.max(0.01, (effect.params.size ?? 65) / 100);
      const amount = Math.max(0, (effect.params.amount ?? 35) / 100);
      const edge = smoothstep(float(radius), float(Math.max(radius + 0.001, 1)), length(uv().sub(vec2(0.5)).mul(1.4142)));
      nextRgb = rgb.mul(float(1).sub(edge.mul(amount)));
    }
    if (effect.filterRegion) {
      const regionMask = filterMasks.fragment(effect.filterRegion);
      rgb = mix(previousRgb, nextRgb, regionMask);
      alpha = mix(previousAlpha, nextAlpha, regionMask);
    } else {
      rgb = nextRgb;
      alpha = nextAlpha;
    }
  }
  nodeMaterial.colorNode = vec4(rgb, alpha);
  material.needsUpdate = true;
}

function meshDeformedPosition(effects: readonly ClipEffect[], filterMasks = createFilterRegionNodeCache()) {
  let displaced: any = positionLocal;
  let active = false;
  for (const effect of effects) {
    if (effect.kind !== "meshDeform") continue;
    active = true;
    const angle = THREE.MathUtils.degToRad(effect.params.angle ?? 0);
    const coordinate = displaced.x.mul(Math.cos(angle)).add(displaced.y.mul(Math.sin(angle)));
    const wave = sin(coordinate.mul(Math.max(0, effect.params.frequency ?? 2)).add(THREE.MathUtils.degToRad(effect.params.phase ?? 0)))
      .mul((effect.params.amount ?? 25) / 100);
    const regionMask = effect.filterRegion ? filterMasks.vertex(effect.filterRegion) : float(1);
    displaced = displaced.add(vec3(-Math.sin(angle), Math.cos(angle), 0).mul(wave).mul(regionMask));
  }
  return active ? displaced : null;
}

function updateOutlineMaterial(material: THREE.Material | THREE.Material[], spec: SceneMaterialSpec = {}) {
  for (const item of Array.isArray(material) ? material : [material]) {
    const mutable = item as THREE.Material & { color?: THREE.Color };
    mutable.color?.setHex(spec.outlineColor ?? 0x000000);
    const opacity = spec.opacity ?? 1;
    mutable.opacity = opacity;
    mutable.transparent = spec.transparent ?? opacity < 1;
    mutable.depthTest = spec.depthTest ?? true;
    mutable.depthWrite = spec.depthWrite ?? opacity >= 1;
  }
}
