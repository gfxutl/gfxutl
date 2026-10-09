import * as THREE from "three/webgpu";
import { distance, float, hue, length, max, pow, saturation, smoothstep, texture as textureNode, uv, vec2, vec3, vec4 } from "three/tsl";
import type { SceneMaterialSpec, SceneObjectSpec } from "../protocol/engine-protocol";
import { createGeometry } from "./three-geometry-factory";

interface SceneRecord {
  root: THREE.Object3D;
  fill: THREE.Mesh | THREE.LineSegments | THREE.Points | THREE.Sprite;
  outline?: THREE.Mesh;
  geometryKey: string;
  shapeSignature: string;
  materialKind: string;
  ownedGeometries: THREE.BufferGeometry[];
}

interface CachedGeometry { geometry: THREE.BufferGeometry; refs: number }

export class ThreeSceneCore {
  private objects = new Map<string, SceneRecord>();
  private geometries = new Map<string, CachedGeometry>();

  constructor(readonly scene: THREE.Scene, private resolveTexture?: (assetId: string, usage: "color" | "data" | "normal") => THREE.Texture | undefined) {}

  get size() { return this.objects.size; }

  getObject(id: string) { return this.objects.get(id)?.root; }

  upsert(spec: SceneObjectSpec) {
    const geometryKey = JSON.stringify(spec.geometry);
    const outlineWidth = Math.max(0, spec.material?.outlineWidth ?? 0);
    const shapeSignature = `${geometryKey}:${outlineWidth}:${spec.instances?.length ?? 0}`;
    const primitive = spec.geometry.kind === "edges" || spec.geometry.kind === "wireframe" ? "line" : spec.primitive ?? "mesh";
    const isLine = primitive === "line";
    const materialKind = isLine ? "line" : `${primitive}:${spec.material?.kind ?? "basic"}`;
    let record = this.objects.get(spec.id);

    if (!record || record.shapeSignature !== shapeSignature || record.materialKind !== materialKind) {
      if (record) this.remove(spec.id);
      const geometry = this.acquireGeometry(geometryKey, spec);
      const material = isLine ? createLineMaterial(spec.material)
        : primitive === "points" ? createPointsMaterial(spec.material)
          : primitive === "sprite" ? createSpriteMaterial(spec.material)
            : createMeshMaterial(spec.material, this.resolveTexture);
      const fill = isLine ? new THREE.LineSegments(geometry, material as THREE.LineBasicMaterial)
        : primitive === "points" ? new THREE.Points(geometry, material as THREE.PointsMaterial)
          : primitive === "sprite" ? new THREE.Sprite(material as THREE.SpriteMaterial)
            : spec.instances?.length ? new THREE.InstancedMesh(geometry, material, spec.instances.length)
              : new THREE.Mesh(geometry, material);
      const ownedGeometries: THREE.BufferGeometry[] = [];
      let root: THREE.Object3D = fill;
      let outline: THREE.Mesh | undefined;
      if (outlineWidth > 0 && fill instanceof THREE.Mesh) {
        const group = new THREE.Group();
        const outlineGeometry = expandGeometry(geometry, outlineWidth);
        ownedGeometries.push(outlineGeometry);
        outline = new THREE.Mesh(outlineGeometry, new THREE.MeshBasicMaterial({
          color: spec.material?.outlineColor ?? 0x000000,
          side: THREE.BackSide,
          transparent: (spec.material?.opacity ?? 1) < 1,
          opacity: spec.material?.opacity ?? 1,
          depthTest: spec.material?.depthTest ?? true,
          depthWrite: spec.material?.depthWrite ?? true,
        }));
        outline.name = `${spec.id}:outline`;
        group.add(outline, fill);
        root = group;
      }
      record = { root, fill, outline, geometryKey, shapeSignature, materialKind, ownedGeometries };
      this.objects.set(spec.id, record);
    }

    updateMaterial(record.fill.material, spec.material, this.resolveTexture);
    if (record.fill instanceof THREE.InstancedMesh) updateInstances(record.fill, spec.instances ?? []);
    if (record.outline) updateOutlineMaterial(record.outline.material, spec.material);
    record.fill.renderOrder = spec.renderOrder ?? 0;
    record.fill.castShadow = Boolean(spec.castShadow);
    record.fill.receiveShadow = Boolean(spec.receiveShadow);
    record.fill.traverse((child) => {
      child.castShadow = Boolean(spec.castShadow);
      child.receiveShadow = Boolean(spec.receiveShadow);
    });
    applyTransform(record.root, spec);
    record.root.name = spec.id;
    record.root.visible = spec.visible ?? true;
    record.root.renderOrder = spec.renderOrder ?? 0;
    record.root.layers.set(THREE.MathUtils.clamp(spec.layer ?? 0, 0, 31));
    const parent = spec.parentId ? this.objects.get(spec.parentId)?.root ?? this.scene.getObjectByName(spec.parentId) : undefined;
    const destination = parent && canParent(record.root, parent) ? parent : this.scene;
    destination.add(record.root);
    return record.root;
  }

  private acquireGeometry(key: string, spec: SceneObjectSpec) {
    const cached = this.geometries.get(key);
    if (cached) { cached.refs++; return cached.geometry; }
    const geometry = createGeometry(spec.geometry);
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
    record.ownedGeometries.forEach((geometry) => geometry.dispose());
    this.releaseGeometry(record.geometryKey);
    this.objects.delete(id);
  }

  dispose() {
    [...this.objects.keys()].forEach((id) => this.remove(id));
    for (const cached of this.geometries.values()) cached.geometry.dispose();
    this.geometries.clear();
  }
}

function canParent(object: THREE.Object3D, parent: THREE.Object3D) {
  for (let current: THREE.Object3D | null = parent; current; current = current.parent) if (current === object) return false;
  return object !== parent;
}

function updateInstances(mesh: THREE.InstancedMesh, instances: NonNullable<SceneObjectSpec["instances"]>) {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  instances.forEach((instance, index) => {
    position.set(...instance.position);
    rotation.set(...(instance.rotation ?? [0, 0, 0]));
    quaternion.setFromEuler(rotation);
    scale.set(...(instance.scale ?? [1, 1, 1]));
    mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
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

function commonMaterialOptions(spec: SceneMaterialSpec = {}) {
  const opacity = spec.opacity ?? 1;
  return {
    color: spec.color ?? 0xffffff,
    wireframe: spec.wireframe ?? false,
    side: materialSide(spec.side),
    transparent: spec.transparent ?? opacity < 1,
    opacity,
    depthTest: spec.depthTest ?? true,
    depthWrite: spec.depthWrite ?? opacity >= 1,
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
    mutable.transparent = spec.transparent ?? opacity < 1;
    mutable.depthTest = spec.depthTest ?? true;
    mutable.depthWrite = spec.depthWrite ?? opacity >= 1;
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
    const next = assetId ? resolveTexture?.(assetId, usage) ?? null : null;
    if (mutable[property] !== next) { mutable[property] = next; changed = true; }
  }
  if (changed) material.needsUpdate = true;
}

function applyMaterialEffects(material: THREE.Material, spec: SceneMaterialSpec) {
  const nodeMaterial = material as THREE.Material & { colorNode?: unknown; map?: THREE.Texture | null };
  if (!("colorNode" in nodeMaterial)) return;
  const effects = (spec.effects ?? []).filter((effect) => effect.enabled && effect.kind !== "transform" && effect.kind !== "opacity");
  if (!effects.length) {
    if (nodeMaterial.colorNode !== null) { nodeMaterial.colorNode = null; material.needsUpdate = true; }
    return;
  }
  let sampleUv: any = uv();
  for (const effect of effects) {
    if (effect.kind === "pixelate") {
      const cells = Math.max(1, effect.params.size ?? 8);
      sampleUv = sampleUv.mul(cells).floor().add(0.5).div(cells);
    }
  }
  const color = new THREE.Color(spec.color ?? 0xffffff);
  let rgba: any = nodeMaterial.map
    ? textureNode(nodeMaterial.map, sampleUv).mul(vec4(color.r, color.g, color.b, 1))
    : vec4(color.r, color.g, color.b, 1);
  let rgb: any = rgba.rgb;
  let alpha: any = rgba.a;
  for (const effect of effects) {
    if (effect.kind === "brightness") rgb = rgb.mul(Math.max(0, 1 + (effect.params.amount ?? 0) / 100));
    else if (effect.kind === "tint") rgb = rgb.mul(vec3((effect.params.red ?? 100) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 100) / 100));
    else if (effect.kind === "contrast") rgb = rgb.sub(0.5).mul(Math.max(0, 1 + (effect.params.amount ?? 0) / 100)).add(0.5);
    else if (effect.kind === "saturation") rgb = saturation(rgb, Math.max(0, (effect.params.amount ?? 100) / 100));
    else if (effect.kind === "gamma") rgb = pow(max(rgb, vec3(0)), vec3(1 / Math.max(0.01, (effect.params.amount ?? 100) / 100)));
    else if (effect.kind === "hue") rgb = hue(rgb, THREE.MathUtils.degToRad(effect.params.angle ?? 0));
    else if (effect.kind === "chromaKey") {
      const key = vec3((effect.params.red ?? 0) / 100, (effect.params.green ?? 100) / 100, (effect.params.blue ?? 0) / 100);
      const threshold = (effect.params.threshold ?? 20) / 100;
      alpha = alpha.mul(smoothstep(float(threshold), float(threshold + Math.max(0.001, (effect.params.softness ?? 10) / 100)), distance(rgb, key)));
    } else if (effect.kind === "vignette") {
      const radius = Math.max(0.01, (effect.params.size ?? 65) / 100);
      const amount = Math.max(0, (effect.params.amount ?? 35) / 100);
      const edge = smoothstep(float(radius), float(Math.max(radius + 0.001, 1)), length(uv().sub(vec2(0.5)).mul(1.4142)));
      rgb = rgb.mul(float(1).sub(edge.mul(amount)));
    }
  }
  nodeMaterial.colorNode = vec4(rgb, alpha);
  material.needsUpdate = true;
}

/** Builds an inverted hull by moving every vertex along its actual surface normal. */
export function expandGeometry(source: THREE.BufferGeometry, distance: number) {
  const geometry = source.clone();
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!positions || !normals) return geometry;
  for (let index = 0; index < positions.count; index++) {
    positions.setXYZ(
      index,
      positions.getX(index) + normals.getX(index) * distance,
      positions.getY(index) + normals.getY(index) * distance,
      positions.getZ(index) + normals.getZ(index) * distance,
    );
  }
  positions.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
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
