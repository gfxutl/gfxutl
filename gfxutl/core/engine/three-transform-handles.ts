import * as THREE from "three/webgpu";
import { TRANSFORM_HANDLES_LAYER } from "./editor-layers";

const HANDLE_POINTS = [
  [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0],
] as const;
const HANDLE_POSITIONS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const HANDLE_SIZE_PX = 10;
const ROTATION_OFFSET_PX = 28;

/** Three.js-resident transform outline used only by the interactive preview. */
export class ThreeTransformHandles {
  private readonly group = new THREE.Group();
  private readonly outline: THREE.LineSegments;
  private readonly stem: THREE.Line;
  private readonly handles: THREE.Mesh[];
  private readonly rotationHandle: THREE.Mesh;
  private readonly rotationHitArea: THREE.Mesh;
  private readonly bounds = new THREE.Box3();
  private readonly inverseRootMatrix = new THREE.Matrix4();
  private readonly point = new THREE.Vector3();
  private readonly worldCenter = new THREE.Vector3();
  private readonly worldScale = new THREE.Vector3();
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldQuaternion = new THREE.Quaternion();
  private geometrySignature = "";
  private boundsRoot: THREE.Object3D | null = null;
  private boundsVersion = "";

  constructor(scene: THREE.Scene) {
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, toneMapped: false });
    const handleMaterial = new THREE.MeshBasicMaterial({ color: 0xf5f5f3, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.outline = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial);
    this.stem = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
    this.handles = HANDLE_POINTS.map((_, index) => {
      const handle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), handleMaterial);
      handle.name = `editor:transform-handle:${HANDLE_POSITIONS[index]}`;
      handle.userData.gfxTransformHandleKind = HANDLE_POSITIONS[index];
      return handle;
    });
    this.rotationHandle = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), handleMaterial);
    this.rotationHandle.name = "editor:transform-handle:rotation";
    this.rotationHandle.userData.gfxTransformHandleKind = "rotation";
    const hitAreaMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    hitAreaMaterial.colorWrite = false;
    this.rotationHitArea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hitAreaMaterial);
    this.rotationHitArea.name = "editor:transform-handle:rotation-hit-area";
    this.rotationHitArea.userData.gfxTransformHandleKind = "rotation";
    this.group.name = "editor:transform-handles";
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.renderOrder = 2_000_000_000;
    this.group.add(this.outline, this.stem, this.rotationHitArea, ...this.handles, this.rotationHandle);
    this.group.traverse((object) => {
      object.layers.set(TRANSFORM_HANDLES_LAYER);
      object.renderOrder = 2_000_000_000;
      object.frustumCulled = false;
      object.userData.gfxTransformHandle = true;
    });
    scene.add(this.group);
  }

  sync(root?: THREE.Object3D, camera?: THREE.Camera, viewportHeight = 1, boundsVersion = "") {
    if (!root || !camera || !root.visible) {
      this.group.visible = false;
      return;
    }
    if (this.boundsRoot !== root || this.boundsVersion !== boundsVersion) {
      if (!this.computeLocalBounds(root)) {
        this.group.visible = false;
        return;
      }
      this.boundsRoot = root;
      this.boundsVersion = boundsVersion;
    }
    root.updateWorldMatrix(true, true);
    this.group.matrix.copy(root.matrixWorld);
    this.group.matrixWorldNeedsUpdate = true;

    const min = this.bounds.min;
    const max = this.bounds.max;
    const width = Math.max(0.001, max.x - min.x);
    const height = Math.max(0.001, max.y - min.y);
    const centerX = (min.x + max.x) / 2;
    const centerY = (min.y + max.y) / 2;
    root.matrixWorld.decompose(this.worldPosition, this.worldQuaternion, this.worldScale);
    const scaleX = Math.max(0.000001, Math.abs(this.worldScale.x));
    const scaleY = Math.max(0.000001, Math.abs(this.worldScale.y));
    const scaleZ = Math.max(0.000001, Math.abs(this.worldScale.z));
    this.worldCenter.set(centerX, centerY, max.z).applyMatrix4(root.matrixWorld);
    const worldUnitsPerPixel = projectedWorldUnitsPerPixel(camera, this.worldCenter, viewportHeight);
    const handleScaleX = HANDLE_SIZE_PX * worldUnitsPerPixel / scaleX;
    const handleScaleY = HANDLE_SIZE_PX * worldUnitsPerPixel / scaleY;
    const rotationOffset = ROTATION_OFFSET_PX * worldUnitsPerPixel / scaleY;
    const z = max.z + worldUnitsPerPixel * 0.5 / scaleZ;

    const geometrySignature = [min.x, min.y, min.z, max.x, max.y, max.z, handleScaleX, handleScaleY, rotationOffset, z].join(":");
    if (geometrySignature !== this.geometrySignature) {
      this.geometrySignature = geometrySignature;
      setLineSegments(this.outline.geometry, [
        min.x, min.y, z, max.x, min.y, z,
        max.x, min.y, z, max.x, max.y, z,
        max.x, max.y, z, min.x, max.y, z,
        min.x, max.y, z, min.x, min.y, z,
      ]);
      setLineSegments(this.stem.geometry, [centerX, max.y, z, centerX, max.y + rotationOffset, z]);
      for (let index = 0; index < this.handles.length; index++) {
        const [x, y] = HANDLE_POINTS[index];
        this.handles[index].position.set(centerX + x * width / 2, centerY + y * height / 2, z);
        this.handles[index].scale.set(handleScaleX, handleScaleY, 1);
      }
      this.rotationHitArea.position.set(centerX, max.y + rotationOffset / 2, z);
      this.rotationHitArea.scale.set(handleScaleX * 1.5, Math.max(0.000001, rotationOffset - handleScaleY), 1);
      this.rotationHandle.position.set(centerX, max.y + rotationOffset, z);
      this.rotationHandle.scale.set(handleScaleX, handleScaleY, 1);
    }
    this.group.visible = true;
  }

  get pickRoot() { return this.group; }

  private computeLocalBounds(root: THREE.Object3D) {
    root.updateWorldMatrix(true, true);
    this.inverseRootMatrix.copy(root.matrixWorld).invert();
    this.bounds.makeEmpty();
    root.traverse((object) => {
      if (!object.visible || object.userData.gfxTransformHandle) return;
      const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!geometry) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        this.point.set(x, y, z).applyMatrix4(object.matrixWorld).applyMatrix4(this.inverseRootMatrix);
        this.bounds.expandByPoint(this.point);
      }
    });
    return !this.bounds.isEmpty();
  }

  dispose() {
    this.group.removeFromParent();
    this.outline.geometry.dispose();
    this.stem.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    (this.stem.material as THREE.Material).dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const handle of [...this.handles, this.rotationHandle, this.rotationHitArea]) {
      geometries.add(handle.geometry);
      materials.add(handle.material as THREE.Material);
    }
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }
}

export function projectedWorldUnitsPerPixel(camera: THREE.Camera, worldPoint: THREE.Vector3, viewportHeight: number) {
  const pixels = Math.max(1, viewportHeight);
  if (camera instanceof THREE.OrthographicCamera) return Math.abs(camera.top - camera.bottom) / Math.max(0.000001, camera.zoom) / pixels;
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.updateWorldMatrix(true, false);
    const depth = Math.max(camera.near, Math.abs(worldPoint.clone().applyMatrix4(camera.matrixWorldInverse).z));
    const visibleHeight = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV() / 2));
    return visibleHeight / pixels;
  }
  return 1 / pixels;
}

function setLineSegments(geometry: THREE.BufferGeometry, positions: number[]) {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}
