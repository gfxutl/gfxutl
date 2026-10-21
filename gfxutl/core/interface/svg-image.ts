import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import type { SvgAssetSpec, SvgMeshSpec } from "../protocol/engine-protocol";
import { isSvgImageFile } from "./media-format";

export async function parseSvgImageFile(file: File): Promise<SvgAssetSpec | undefined> {
  if (!isSvgImageFile(file)) return undefined;
  const parsed = new SVGLoader().parse(await file.text());
  const geometries: Array<{ geometry: THREE.BufferGeometry; color: number; opacity: number; renderOrder: number }> = [];
  const bounds = new THREE.Box2();
  let renderOrder = 0;

  for (const path of parsed.paths) {
    const style = path.userData?.style as Record<string, string | number | undefined> | undefined;
    const fill = String(style?.fill ?? "");
    if (fill && fill !== "none") {
      for (const shape of SVGLoader.createShapes(path)) {
        const geometry = new THREE.ShapeGeometry(shape);
        includeGeometryBounds(bounds, geometry);
        geometries.push({ geometry, color: path.color.getHex(), opacity: svgOpacity(style?.opacity, style?.fillOpacity), renderOrder: renderOrder++ });
      }
    }

    const stroke = String(style?.stroke ?? "");
    if (stroke && stroke !== "none") {
      for (const subPath of path.subPaths) {
        const geometry = SVGLoader.pointsToStroke(subPath.getPoints(), style as unknown as Parameters<typeof SVGLoader.pointsToStroke>[1]);
        if (!geometry) continue;
        includeGeometryBounds(bounds, geometry);
        geometries.push({ geometry, color: new THREE.Color().setStyle(stroke).getHex(), opacity: svgOpacity(style?.opacity, style?.strokeOpacity), renderOrder: renderOrder++ });
      }
    }
  }

  if (!geometries.length || bounds.isEmpty()) {
    for (const { geometry } of geometries) geometry.dispose();
    throw new Error("SVGに描画可能なパスがありません");
  }
  const xml = parsed.xml as unknown as Element | XMLDocument;
  const viewport = svgViewport("documentElement" in xml ? xml.documentElement : xml, bounds);
  const fitted = fittedSvgSize(viewport.width, viewport.height);
  const centerX = viewport.minX + viewport.width / 2;
  const centerY = viewport.minY + viewport.height / 2;
  const scaleX = fitted.width / viewport.width;
  const scaleY = fitted.height / viewport.height;
  const meshes: SvgMeshSpec[] = geometries.map(({ geometry, color, opacity, renderOrder: order }) => {
    const attribute = geometry.getAttribute("position");
    const positions = new Array<number>(attribute.count * 3);
    for (let index = 0; index < attribute.count; index++) {
      const offset = index * 3;
      positions[offset] = (attribute.getX(index) - centerX) * scaleX;
      positions[offset + 1] = (centerY - attribute.getY(index)) * scaleY;
      positions[offset + 2] = 0;
    }
    const indices = geometry.index ? Array.from(geometry.index.array) : undefined;
    geometry.dispose();
    return { positions, indices, color, opacity, renderOrder: order };
  });
  return { width: viewport.width, height: viewport.height, meshes };
}

function svgOpacity(...values: Array<string | number | undefined>) {
  return values.reduce<number>((opacity, value) => {
    const numeric = Number.parseFloat(String(value ?? "1"));
    return opacity * (Number.isFinite(numeric) ? THREE.MathUtils.clamp(numeric, 0, 1) : 1);
  }, 1);
}

function includeGeometryBounds(bounds: THREE.Box2, geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;
  bounds.expandByPoint(new THREE.Vector2(box.min.x, box.min.y));
  bounds.expandByPoint(new THREE.Vector2(box.max.x, box.max.y));
}

function svgViewport(root: Element, bounds: THREE.Box2) {
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { minX: viewBox[0], minY: viewBox[1], width: viewBox[2], height: viewBox[3] };
  }
  const width = svgLength(root.getAttribute("width"));
  const height = svgLength(root.getAttribute("height"));
  if (width && height) return { minX: 0, minY: 0, width, height };
  const size = bounds.getSize(new THREE.Vector2());
  return { minX: bounds.min.x, minY: bounds.min.y, width: Math.max(1, size.x), height: Math.max(1, size.y) };
}

function svgLength(value: string | null) {
  if (!value || value.trim().endsWith("%")) return undefined;
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function fittedSvgSize(width: number, height: number) {
  const maxWidth = 15.4;
  const maxHeight = 8.6;
  const aspect = width / height;
  return aspect >= maxWidth / maxHeight
    ? { width: maxWidth, height: maxWidth / aspect }
    : { width: maxHeight * aspect, height: maxHeight };
}
