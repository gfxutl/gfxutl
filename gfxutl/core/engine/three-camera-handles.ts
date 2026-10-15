import * as THREE from "three/webgpu";
import type { CameraHandleKind, CameraHandleTransform, CameraSettings } from "../protocol/engine-protocol";
import { INSPECTOR_HELPERS_LAYER } from "./editor-layers";
import { projectedWorldUnitsPerPixel } from "./three-transform-handles";

const AXES = [
  { name: "x", color: 0xf05b5b, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2)) },
  { name: "y", color: 0x65d16f, quaternion: new THREE.Quaternion() },
  { name: "z", color: 0x5794ed, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)) },
] as const;

type CameraHandleDrag = {
  axis: THREE.Vector3;
  origin: THREE.Vector3;
  position: THREE.Vector3;
  target: THREE.Vector3;
  plane: THREE.Plane;
} & (
  | { operation: "translate"; startParameter: number }
  | { operation: "rotate"; startVector: THREE.Vector3 }
);

/** Six-degree camera gizmo: three translation arrows plus three rotation rings. */
export class ThreeCameraHandles {
  private readonly group = new THREE.Group();
  private readonly hoverTarget: THREE.Mesh;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private drag: CameraHandleDrag | null = null;

  constructor(scene: THREE.Scene) {
    this.group.name = "editor:camera-handles";
    this.group.renderOrder = 2_000_000_100;
    this.group.visible = false;
    const pickerMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    pickerMaterial.colorWrite = false;
    this.materials.add(pickerMaterial);

    for (const axis of AXES) {
      const material = new THREE.MeshBasicMaterial({ color: axis.color, depthTest: false, depthWrite: false, toneMapped: false });
      const ringMaterial = material.clone();
      ringMaterial.transparent = true;
      ringMaterial.opacity = 0.82;
      this.materials.add(material).add(ringMaterial);

      const shaftGeometry = new THREE.CylinderGeometry(1.15, 1.15, 42, 8);
      const headGeometry = new THREE.ConeGeometry(4.8, 12, 12);
      const ringGeometry = new THREE.TorusGeometry(34, 1.3, 8, 64);
      const arrowPickerGeometry = new THREE.CylinderGeometry(5, 5, 54, 8);
      const ringPickerGeometry = new THREE.TorusGeometry(34, 5, 8, 64);
      this.geometries.add(shaftGeometry).add(headGeometry).add(ringGeometry).add(arrowPickerGeometry).add(ringPickerGeometry);

      const arrow = new THREE.Group();
      arrow.name = `editor:camera-translate-${axis.name}`;
      arrow.quaternion.copy(axis.quaternion);
      const shaft = new THREE.Mesh(shaftGeometry, material);
      shaft.position.y = 22;
      const head = new THREE.Mesh(headGeometry, material);
      head.position.y = 48;
      const arrowPicker = new THREE.Mesh(arrowPickerGeometry, pickerMaterial);
      arrowPicker.position.y = 27;
      arrow.add(shaft, head, arrowPicker);
      arrow.traverse((object) => { object.userData.gfxCameraHandleKind = `translate-${axis.name}` satisfies CameraHandleKind; });

      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.name = `editor:camera-rotate-${axis.name}`;
      const ringPicker = new THREE.Mesh(ringPickerGeometry, pickerMaterial);
      if (axis.name === "x") ring.rotation.y = Math.PI / 2;
      else if (axis.name === "y") ring.rotation.x = Math.PI / 2;
      ringPicker.rotation.copy(ring.rotation);
      ring.userData.gfxCameraHandleKind = `rotate-${axis.name}` satisfies CameraHandleKind;
      ringPicker.userData.gfxCameraHandleKind = `rotate-${axis.name}` satisfies CameraHandleKind;
      this.group.add(arrow, ring, ringPicker);
    }

    this.group.traverse((object) => {
      object.layers.set(INSPECTOR_HELPERS_LAYER);
      object.renderOrder = 2_000_000_100;
      object.frustumCulled = false;
      object.userData.gfxCameraHandle = true;
    });

    const hoverMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    hoverMaterial.colorWrite = false;
    const hoverGeometry = new THREE.SphereGeometry(1, 12, 8);
    this.materials.add(hoverMaterial);
    this.geometries.add(hoverGeometry);
    this.hoverTarget = new THREE.Mesh(hoverGeometry, hoverMaterial);
    this.hoverTarget.name = "editor:camera-hover-target";
    this.hoverTarget.layers.set(INSPECTOR_HELPERS_LAYER);
    this.hoverTarget.userData.gfxCameraHandle = true;
    this.hoverTarget.visible = false;
    scene.add(this.hoverTarget, this.group);
  }

  sync(camera?: THREE.Camera, inspectorCamera?: THREE.Camera, viewportHeight = 1, enabled = false, handlesVisible = false) {
    if (!camera || !inspectorCamera || !enabled) {
      this.hoverTarget.visible = false;
      this.group.visible = false;
      return;
    }
    camera.updateWorldMatrix(true, false);
    const position = camera.getWorldPosition(new THREE.Vector3());
    const worldUnitsPerPixel = projectedWorldUnitsPerPixel(inspectorCamera, position, viewportHeight);
    this.hoverTarget.position.copy(position);
    this.hoverTarget.scale.setScalar(Math.max(0.0001, worldUnitsPerPixel * 15));
    this.hoverTarget.visible = true;
    this.group.position.copy(position);
    this.group.scale.setScalar(Math.max(0.0001, worldUnitsPerPixel));
    this.group.visible = handlesVisible;
    this.group.updateMatrixWorld(true);
  }

  beginDrag(handle: CameraHandleKind, ndcX: number, ndcY: number, camera: CameraSettings, inspectorCamera: THREE.Camera) {
    const axis = handleAxis(handle);
    const origin = new THREE.Vector3(...camera.position);
    const position = origin.clone();
    const target = new THREE.Vector3(...camera.target);
    const ray = pointerRay(ndcX, ndcY, inspectorCamera);
    if (handle.startsWith("translate-")) {
      const viewDirection = inspectorCamera.getWorldDirection(new THREE.Vector3());
      const planeNormal = viewDirection.addScaledVector(axis, -viewDirection.dot(axis));
      if (planeNormal.lengthSq() < 0.000001) {
        inspectorCamera.getWorldQuaternion(_quaternion);
        planeNormal.set(0, 1, 0).applyQuaternion(_quaternion).addScaledVector(axis, -planeNormal.dot(axis));
      }
      if (planeNormal.lengthSq() < 0.000001) planeNormal.copy(Math.abs(axis.x) < 0.9 ? _xAxis : _yAxis).cross(axis);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.normalize(), origin);
      const point = ray.intersectPlane(plane, new THREE.Vector3());
      this.drag = point ? { operation: "translate", axis, origin, position, target, plane, startParameter: point.clone().sub(origin).dot(axis) } : null;
    } else {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, origin);
      const point = ray.intersectPlane(plane, new THREE.Vector3());
      const startVector = point?.sub(origin);
      this.drag = startVector && startVector.lengthSq() > 0.000001
        ? { operation: "rotate", axis, origin, position, target, plane, startVector: startVector.normalize() }
        : null;
    }
  }

  dragTo(ndcX: number, ndcY: number, inspectorCamera: THREE.Camera): CameraHandleTransform | undefined {
    if (!this.drag) return undefined;
    const point = pointerRay(ndcX, ndcY, inspectorCamera).intersectPlane(this.drag.plane, new THREE.Vector3());
    if (!point) return undefined;
    if (this.drag.operation === "translate") {
      const parameter = point.sub(this.drag.origin).dot(this.drag.axis);
      const translation = this.drag.axis.clone().multiplyScalar(parameter - this.drag.startParameter);
      return cameraTransform(this.drag.position.clone().add(translation), this.drag.target.clone().add(translation));
    }
    const currentVector = point.sub(this.drag.origin);
    if (currentVector.lengthSq() < 0.000001) return undefined;
    currentVector.normalize();
    const sine = this.drag.axis.dot(_cross.crossVectors(this.drag.startVector, currentVector));
    const cosine = THREE.MathUtils.clamp(this.drag.startVector.dot(currentVector), -1, 1);
    const rotation = _quaternion.setFromAxisAngle(this.drag.axis, Math.atan2(sine, cosine));
    const lookDirection = this.drag.target.clone().sub(this.drag.position).applyQuaternion(rotation);
    return cameraTransform(this.drag.position, this.drag.position.clone().add(lookDirection));
  }

  endDrag() {
    this.drag = null;
  }

  dispose() {
    this.drag = null;
    this.hoverTarget.removeFromParent();
    this.group.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}

const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _cross = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();

function handleAxis(handle: CameraHandleKind) {
  return handle.endsWith("-x") ? _xAxis.clone() : handle.endsWith("-y") ? _yAxis.clone() : _zAxis.clone();
}

function pointerRay(ndcX: number, ndcY: number, camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(THREE.MathUtils.clamp(ndcX, -1, 1), THREE.MathUtils.clamp(ndcY, -1, 1)), camera);
  return raycaster.ray;
}

function cameraTransform(position: THREE.Vector3, target: THREE.Vector3): CameraHandleTransform {
  return {
    position: position.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number],
  };
}
