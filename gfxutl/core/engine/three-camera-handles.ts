import * as THREE from "three/webgpu";
import { INSPECTOR_HELPERS_LAYER } from "./editor-layers";
import { projectedWorldUnitsPerPixel } from "./three-transform-handles";

const AXES = [
  { name: "x", color: 0xf05b5b, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2)) },
  { name: "y", color: 0x65d16f, quaternion: new THREE.Quaternion() },
  { name: "z", color: 0x5794ed, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)) },
] as const;

/** Six-degree camera gizmo: three translation arrows plus three rotation rings. */
export class ThreeCameraHandles {
  private readonly group = new THREE.Group();
  private readonly hoverTarget: THREE.Mesh;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();

  constructor(scene: THREE.Scene) {
    this.group.name = "editor:camera-handles";
    this.group.renderOrder = 2_000_000_100;
    this.group.visible = false;

    for (const axis of AXES) {
      const material = new THREE.MeshBasicMaterial({ color: axis.color, depthTest: false, depthWrite: false, toneMapped: false });
      const ringMaterial = material.clone();
      ringMaterial.transparent = true;
      ringMaterial.opacity = 0.82;
      this.materials.add(material).add(ringMaterial);

      const shaftGeometry = new THREE.CylinderGeometry(1.15, 1.15, 42, 8);
      const headGeometry = new THREE.ConeGeometry(4.8, 12, 12);
      const ringGeometry = new THREE.TorusGeometry(34, 1.3, 8, 64);
      this.geometries.add(shaftGeometry).add(headGeometry).add(ringGeometry);

      const arrow = new THREE.Group();
      arrow.name = `editor:camera-translate-${axis.name}`;
      arrow.quaternion.copy(axis.quaternion);
      const shaft = new THREE.Mesh(shaftGeometry, material);
      shaft.position.y = 22;
      const head = new THREE.Mesh(headGeometry, material);
      head.position.y = 48;
      arrow.add(shaft, head);

      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.name = `editor:camera-rotate-${axis.name}`;
      if (axis.name === "x") ring.rotation.y = Math.PI / 2;
      else if (axis.name === "y") ring.rotation.x = Math.PI / 2;
      this.group.add(arrow, ring);
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

  dispose() {
    this.hoverTarget.removeFromParent();
    this.group.removeFromParent();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}
