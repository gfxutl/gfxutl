import * as THREE from "three/webgpu";
import type { GeometryKind, GeometrySpec } from "../../protocol/engine-protocol";

export type GeometryResolver = (spec: GeometrySpec) => Promise<THREE.BufferGeometry>;

/**
 * Runtime contract shared by the independently loaded built-in object ESMs.
 *
 * A loaded class is a real Three.js Object3D. Geometry creation remains a
 * static operation so the scene core can retain its cross-object geometry
 * cache and can also use the same module for points, lines and instancing.
 */
export abstract class BuiltInObject extends THREE.Mesh {
  static readonly objectKind: GeometryKind;

  static createGeometry(_spec: GeometrySpec, _resolveGeometry: GeometryResolver): Promise<THREE.BufferGeometry> | THREE.BufferGeometry {
    throw new Error("Built-in object did not implement createGeometry()");
  }

  constructor(geometry: THREE.BufferGeometry, material?: THREE.Material | THREE.Material[]) {
    super(geometry, material);
    const ObjectClass = new.target as typeof BuiltInObject;
    this.userData.gfxBuiltInObject = ObjectClass.objectKind;
  }
}

export interface BuiltInObjectClass {
  readonly objectKind: GeometryKind;
  createGeometry(spec: GeometrySpec, resolveGeometry: GeometryResolver): Promise<THREE.BufferGeometry> | THREE.BufferGeometry;
  new (geometry: THREE.BufferGeometry, material?: THREE.Material | THREE.Material[]): BuiltInObject;
}

export interface BuiltInObjectModule {
  default: BuiltInObjectClass;
}
