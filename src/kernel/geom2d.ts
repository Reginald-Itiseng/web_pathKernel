/**
 * Pure 2D geometry helpers shared across kernel modules.
 * Ports the arc/segment math from reference/PathKernel/app/core.
 */
import type { KPoint, KSegment, Stroke } from './types';

/** Max chord deviation used when flattening arcs (mm). */
export const SEGMENT_CHORD_MM = 0.05;
export const MIN_ARC_SEGMENTS = 12;
export const MAX_ARC_SEGMENTS = 720;

const TWO_PI = 2 * Math.PI;

export function pointsClose(a: KPoint, b: KPoint, tol = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

export function distance(a: KPoint, b: KPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dedupePoints(points: KPoint[], tol = 1e-9): KPoint[] {
  const out: KPoint[] = [];
  for (const p of points) {
    if (out.length === 0 || !pointsClose(out[out.length - 1], p, tol)) {
      out.push(p);
    }
  }
  return out;
}

export function pathLength(points: KPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Flatten a circular arc into points, port of Python `_arc_xy_points`.
 * A zero start→end distance is treated as a full circle.
 */
export function flattenArc(
  start: KPoint,
  end: KPoint,
  center: KPoint,
  ccw: boolean,
  chordMm = SEGMENT_CHORD_MM,
): KPoint[] {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (radius <= 0) return [start, end];

  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);

  let sweep: number;
  const ccwSweep = ((a1 - a0) % TWO_PI + TWO_PI) % TWO_PI;
  const cwSweep = ccwSweep - TWO_PI;
  if (pointsClose(start, end)) {
    sweep = ccw ? TWO_PI : -TWO_PI;
  } else {
    sweep = ccw ? ccwSweep : cwSweep;
  }

  const arcLen = Math.abs(sweep) * radius;
  const steps = Math.max(
    MIN_ARC_SEGMENTS,
    Math.min(MAX_ARC_SEGMENTS, Math.floor(Math.max(1, arcLen / chordMm))),
  );
  const points: KPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + sweep * t;
    points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return points;
}

/** Flatten a segment list (lines + arcs) into a polyline. */
export function flattenSegments(segments: KSegment[], chordMm = SEGMENT_CHORD_MM): KPoint[] {
  const out: KPoint[] = [];
  const push = (p: KPoint) => {
    if (out.length === 0 || !pointsClose(out[out.length - 1], p)) out.push(p);
  };
  for (const seg of segments) {
    if (seg.type === 'line') {
      push(seg.start);
      push(seg.end);
    } else {
      for (const p of flattenArc(seg.start, seg.end, seg.center, seg.ccw, chordMm)) push(p);
    }
  }
  return out;
}

/** Flatten a stroke into a polyline for preview/statistics. */
export function flattenStroke(stroke: Stroke, chordMm = SEGMENT_CHORD_MM): KPoint[] {
  if (stroke.type === 'polyline') return stroke.points;
  if (stroke.type === 'line') return [stroke.start, stroke.end];
  return flattenArc(stroke.start, stroke.end, stroke.center, stroke.ccw, chordMm);
}

export function strokeLength(stroke: Stroke): number {
  if (stroke.type === 'polyline') return pathLength(stroke.points);
  if (stroke.type === 'line') return distance(stroke.start, stroke.end);
  const radius = Math.hypot(stroke.start.x - stroke.center.x, stroke.start.y - stroke.center.y);
  if (radius <= 0) return 0;
  const a0 = Math.atan2(stroke.start.y - stroke.center.y, stroke.start.x - stroke.center.x);
  const a1 = Math.atan2(stroke.end.y - stroke.center.y, stroke.end.x - stroke.center.x);
  const ccwSweep = ((a1 - a0) % TWO_PI + TWO_PI) % TWO_PI;
  let sweep: number;
  if (pointsClose(stroke.start, stroke.end)) {
    sweep = TWO_PI;
  } else {
    sweep = stroke.ccw ? ccwSweep : TWO_PI - ccwSweep;
  }
  return Math.abs(sweep) * radius;
}

/**
 * Normalize a standalone filled ring to CCW (positive) orientation.
 * Clipper's NonZero union is winding-sensitive: a CW zone overlapped by a CCW
 * trace cancels to zero (a hole) — unlike shapely's orientation-agnostic
 * unary_union. Only apply to rings that represent solid areas, never to hole
 * rings from a previous clip (those must stay CW).
 */
export function ensureCcw(ring: KPoint[]): KPoint[] {
  return ringArea(ring) < 0 ? [...ring].reverse() : ring;
}

/** Signed polygon ring area (positive = CCW in math coords). */
export function ringArea(ring: KPoint[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function ringBounds(ring: KPoint[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return [minX, minY, maxX, maxY];
}

export function mergeBounds(
  a: [number, number, number, number] | null,
  b: [number, number, number, number] | null,
): [number, number, number, number] | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Port of Python `_bounds_distance_lower_bound` — min distance between two bboxes. */
export function boundsDistanceLowerBound(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const dx = Math.max(0, b[0] - a[2], a[0] - b[2]);
  const dy = Math.max(0, b[1] - a[3], a[1] - b[3]);
  if (dx <= 0 && dy <= 0) return 0;
  return Math.hypot(dx, dy);
}

function segmentDistance(p1: KPoint, p2: KPoint, q1: KPoint, q2: KPoint): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegmentDistance(p1, q1, q2),
    pointSegmentDistance(p2, q1, q2),
    pointSegmentDistance(q1, p1, p2),
    pointSegmentDistance(q2, p1, p2),
  );
}

export function pointSegmentDistance(p: KPoint, a: KPoint, b: KPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 0) return distance(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

function cross(o: KPoint, a: KPoint, b: KPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsIntersect(p1: KPoint, p2: KPoint, q1: KPoint, q2: KPoint): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  const onSeg = (a: KPoint, b: KPoint, c: KPoint) =>
    Math.min(a.x, b.x) - 1e-12 <= c.x &&
    c.x <= Math.max(a.x, b.x) + 1e-12 &&
    Math.min(a.y, b.y) - 1e-12 <= c.y &&
    c.y <= Math.max(a.y, b.y) + 1e-12;
  if (d1 === 0 && onSeg(q1, q2, p1)) return true;
  if (d2 === 0 && onSeg(q1, q2, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, q1)) return true;
  if (d4 === 0 && onSeg(p1, p2, q2)) return true;
  return false;
}

/** Minimum distance between two polygon rings (shapely `a.distance(b)` analog). */
export function ringDistance(a: KPoint[], b: KPoint[]): number {
  let min = Infinity;
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i];
    const p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j];
      const q2 = b[(j + 1) % b.length];
      const d = segmentDistance(p1, p2, q1, q2);
      if (d < min) {
        min = d;
        if (min <= 0) return 0;
      }
    }
  }
  return min;
}

export function pointInRing(p: KPoint, ring: KPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Extract the substring of an open polyline between two arc-length positions.
 * Port of Python `_line_substring`.
 */
export function lineSubstring(points: KPoint[], startDist: number, endDist: number): KPoint[] | null {
  if (points.length < 2 || endDist <= startDist) return null;
  const out: KPoint[] = [];
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = distance(a, b);
    if (segLen <= 0) continue;
    const segStart = travelled;
    const segEnd = travelled + segLen;
    if (segEnd < startDist) {
      travelled = segEnd;
      continue;
    }
    if (segStart > endDist) break;
    const t0 = Math.max(0, (startDist - segStart) / segLen);
    const t1 = Math.min(1, (endDist - segStart) / segLen);
    const p0 = interpolate(a, b, t0);
    const p1 = interpolate(a, b, t1);
    if (out.length === 0) out.push(p0);
    if (!pointsClose(out[out.length - 1], p1, 1e-12)) out.push(p1);
    travelled = segEnd;
  }
  return out.length >= 2 ? out : null;
}

function interpolate(a: KPoint, b: KPoint, t: number): KPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Generate a regular polygon approximating a circle. */
export function circlePoints(cx: number, cy: number, r: number, chordMm = SEGMENT_CHORD_MM): KPoint[] {
  const circumference = TWO_PI * r;
  const segments = Math.max(
    MIN_ARC_SEGMENTS,
    Math.min(MAX_ARC_SEGMENTS, Math.floor(Math.max(1, circumference / chordMm))),
  );
  const points: KPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (TWO_PI * i) / segments;
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return points;
}

/** Rounded-rectangle ring, port of Python `_rounded_rect_shape` / `_rounded_rect_poly_path`. */
export function roundedRectPoints(
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
  chordMm = SEGMENT_CHORD_MM,
): KPoint[] {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));

  if (radius <= 1e-9) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }

  const corner = (ccx: number, ccy: number, a0: number, a1: number): KPoint[] => {
    const sweep = a1 - a0;
    const arcLen = Math.abs(sweep) * radius;
    const steps = Math.max(3, Math.min(MAX_ARC_SEGMENTS, Math.floor(Math.max(1, arcLen / chordMm))));
    const pts: KPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = a0 + sweep * t;
      pts.push({ x: ccx + radius * Math.cos(a), y: ccy + radius * Math.sin(a) });
    }
    return pts;
  };

  const points: KPoint[] = [
    ...corner(x1 - radius, y0 + radius, -Math.PI / 2, 0),
    ...corner(x1 - radius, y1 - radius, 0, Math.PI / 2),
    ...corner(x0 + radius, y1 - radius, Math.PI / 2, Math.PI),
    ...corner(x0 + radius, y0 + radius, Math.PI, (3 * Math.PI) / 2),
  ];
  return dedupePoints(points);
}
