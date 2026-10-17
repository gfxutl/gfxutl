import * as THREE from "three";

const OUTLINE_MITER_LIMIT = 6;

export function offsetTextShapes(shapes: THREE.Shape[], distance: number, curveSegments: number) {
  return shapes.map((shape) => {
    const extracted = shape.extractPoints(curveSegments);
    const outline = pathFromContour(offsetContour(extracted.shape, distance), true);
    outline.holes = extracted.holes.map((hole) => pathFromContour(offsetContour(hole, distance), false));
    return outline;
  });
}

function offsetContour(source: THREE.Vector2[], distance: number) {
  const points = cleanClosedContour(source);
  const result: THREE.Vector2[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const incoming = current.clone().sub(previous).normalize();
    const outgoing = next.clone().sub(current).normalize();
    const incomingNormal = new THREE.Vector2(-incoming.y, incoming.x);
    const outgoingNormal = new THREE.Vector2(-outgoing.y, outgoing.x);
    const incomingOffset = current.clone().addScaledVector(incomingNormal, distance);
    const outgoingOffset = current.clone().addScaledVector(outgoingNormal, distance);
    const denominator = cross2(incoming, outgoing);

    if (Math.abs(denominator) < 1e-8) {
      appendDistinctPoint(result, incomingOffset);
      continue;
    }

    const betweenOffsets = outgoingOffset.clone().sub(incomingOffset);
    const alongIncoming = cross2(betweenOffsets, outgoing) / denominator;
    const intersection = incomingOffset.clone().addScaledVector(incoming, alongIncoming);
    if (intersection.distanceTo(current) <= Math.abs(distance) * OUTLINE_MITER_LIMIT) {
      appendDistinctPoint(result, intersection);
    } else {
      // A bevel join avoids an unbounded spike while preserving both parallel
      // edge offsets (notably the horizontal terminals of lowercase x).
      appendDistinctPoint(result, incomingOffset);
      appendDistinctPoint(result, outgoingOffset);
    }
  }
  return result;
}

function cleanClosedContour(source: THREE.Vector2[]) {
  const points = source.map((point) => point.clone());
  if (points.length > 1 && points[0].distanceToSquared(points.at(-1)!) < 1e-16) points.pop();
  return points.filter((point, index) => index === 0 || point.distanceToSquared(points[index - 1]) >= 1e-16);
}

function pathFromContour(points: THREE.Vector2[], shape: true): THREE.Shape;
function pathFromContour(points: THREE.Vector2[], shape: false): THREE.Path;
function pathFromContour(points: THREE.Vector2[], shape: boolean) {
  const path = shape ? new THREE.Shape() : new THREE.Path();
  if (!points.length) return path;
  path.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) path.lineTo(points[index].x, points[index].y);
  path.closePath();
  return path;
}

function appendDistinctPoint(points: THREE.Vector2[], point: THREE.Vector2) {
  if (!points.length || points.at(-1)!.distanceToSquared(point) >= 1e-16) points.push(point);
}

function cross2(left: THREE.Vector2, right: THREE.Vector2) {
  return left.x * right.y - left.y * right.x;
}
