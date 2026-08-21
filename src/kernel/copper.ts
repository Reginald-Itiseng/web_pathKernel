/**
 * Copper polygon derivation — the foundation every CAM operation builds on.
 * Port of reference/PathKernel/app/core/isolation.py `_build_copper_geometry`,
 * `_primitive_to_shape` and `_minimum_copper_gap`.
 */
import { differencePolygons, sweptOpenPaths, unionPolygons } from './clip';
import {
  boundsDistanceLowerBound,
  circlePoints,
  dedupePoints,
  ensureCcw,
  flattenSegments,
  pointsClose,
  ringBounds,
  ringDistance,
  roundedRectPoints,
} from './geom2d';
import type { DrillFeature, KPoint, KPrimitive } from './types';

/**
 * Convert one primitive into closed polygon rings (mm).
 * Stroked paths are swept by half their width; zero-width paths yield nothing
 * (they are outline centerlines, not copper).
 */
export function primitiveToPolygons(primitive: KPrimitive): KPoint[][] {
  switch (primitive.type) {
    case 'circle':
      return primitive.r > 0 ? [circlePoints(primitive.cx, primitive.cy, primitive.r)] : [];
    case 'rect':
      if (primitive.w <= 0 || primitive.h <= 0) return [];
      return [roundedRectPoints(primitive.cx, primitive.cy, primitive.w, primitive.h, primitive.r)];
    case 'polygon': {
      const ring = dedupePoints(primitive.points);
      return ring.length >= 3 ? [ensureCcw(ring)] : [];
    }
    case 'outline': {
      // Zone fills arrive CW from the plotter — normalize so NonZero union
      // merges them with overlapping traces/pads instead of cancelling.
      const ring = dedupePoints(flattenSegments(primitive.segments));
      return ring.length >= 3 ? [ensureCcw(ring)] : [];
    }
    case 'path': {
      if (primitive.width <= 0) return [];
      // Sweep each contiguous run separately — chaining across gaps would
      // fabricate copper between unrelated traces.
      const runs: KPoint[][] = [];
      let run: KPoint[] = [];
      for (const seg of primitive.segments) {
        const pts = seg.type === 'line' ? [seg.start, seg.end] : flattenSegments([seg]);
        if (run.length > 0 && !pointsClose(run[run.length - 1], pts[0], 1e-6)) {
          if (run.length >= 2) runs.push(run);
          run = [];
        }
        for (const p of pts) {
          if (run.length === 0 || !pointsClose(run[run.length - 1], p, 1e-12)) run.push(p);
        }
      }
      if (run.length >= 2) runs.push(run);
      if (runs.length === 0) return [];
      return sweptOpenPaths(runs, primitive.width / 2);
    }
    case 'drill':
      return primitive.diameter > 0
        ? [circlePoints(primitive.cx, primitive.cy, primitive.diameter / 2)]
        : [];
  }
}

/**
 * True copper geometry: union(dark) − union(clear).
 * Returns [] when the layer has no dark copper.
 */
export function buildCopperGeometry(primitives: KPrimitive[]): KPoint[][] {
  const dark: KPoint[][] = [];
  const clear: KPoint[][] = [];
  for (const primitive of primitives) {
    if (primitive.type === 'drill') continue; // drills are not copper
    const rings = primitiveToPolygons(primitive);
    if (rings.length === 0) continue;
    if (primitive.polarity === 'clear') {
      clear.push(...rings);
    } else {
      dark.push(...rings);
    }
  }
  if (dark.length === 0) return [];
  const copper = unionPolygons(dark);
  if (clear.length === 0) return copper;
  return differencePolygons(copper, unionPolygons(clear));
}

const MAX_GAP_PARTS = 1200;
const MAX_GAP_CHECKS = 250_000;
/**
 * Rings closer than this are considered the same connected copper part.
 * Clipper unions can emit polygons touching at a pinch point as separate
 * rings, where shapely would have merged them — a 0 distance there is a
 * connectivity artifact, not a real clearance.
 */
const TOUCH_EPSILON_MM = 1e-6;

/**
 * Minimum gap between disjoint copper parts (outer rings only), with the same
 * runtime bounds as the Python kernel: null when the geometry is too
 * fragmented or the check budget is exhausted before finding any distance.
 */
export function minimumCopperGap(copperRings: KPoint[][]): number | null {
  // Only outer rings (positive area) count as separate copper parts; holes
  // belong to their outer and would report a bogus zero/apex distance.
  const parts = copperRings.filter((ring) => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum > 0;
  });
  if (parts.length < 2) return null;
  if (parts.length > MAX_GAP_PARTS) return null;

  const bounds = parts.map((p) => ringBounds(p));
  let minGap = Infinity;
  let checks = 0;

  for (let i = 0; i < parts.length - 1; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      checks++;
      if (checks > MAX_GAP_CHECKS) {
        return Number.isFinite(minGap) ? minGap : null;
      }
      const lower = boundsDistanceLowerBound(bounds[i], bounds[j]);
      if (lower >= minGap) continue;
      const d = ringDistance(parts[i], parts[j]);
      if (d > TOUCH_EPSILON_MM && d < minGap) {
        minGap = d;
      }
    }
  }

  return Number.isFinite(minGap) ? minGap : null;
}

/** Collect flashed pad rings (isolation extra-pad-contours + 3D uses). */
export function collectPadPolygons(primitives: KPrimitive[]): KPoint[][] {
  return collectPadPolygonGroups(primitives).flat();
}

/**
 * Same as `collectPadPolygons`, but keeps each pad primitive's ring(s) as
 * its own group instead of flattening them together — lets a batched offset
 * of ALL pads (one Clipper call, still efficient) have its output rings
 * correlated back to the pad they grew from, e.g. for pad-major toolpath
 * ordering (isolation.ts extra pad contours).
 */
export function collectPadPolygonGroups(primitives: KPrimitive[]): KPoint[][][] {
  const groups: KPoint[][][] = [];
  for (const primitive of primitives) {
    if (primitive.type === 'drill') continue;
    if (primitive.polarity === 'clear') continue;
    if (!('flashed' in primitive) || !primitive.flashed) continue;
    const rings = primitiveToPolygons(primitive);
    if (rings.length > 0) groups.push(rings);
  }
  return groups;
}

/**
 * Collect dark copper that is NOT a flashed pad (traces, regions/zones) —
 * used as a keepout so extra pad contours stay clear of other copper.
 * Port of Python `_collect_non_pad_shapes`.
 */
export function collectNonPadPolygons(primitives: KPrimitive[]): KPoint[][] {
  const rings: KPoint[][] = [];
  for (const primitive of primitives) {
    if (primitive.type === 'drill') continue;
    if (primitive.polarity === 'clear') continue;
    if ('flashed' in primitive && primitive.flashed) continue;
    rings.push(...primitiveToPolygons(primitive));
  }
  return rings;
}

/** Collect drill hole descriptors from a layer's primitives. */
export function collectDrillHoles(
  primitives: KPrimitive[],
): DrillFeature[] {
  const holes: DrillFeature[] = [];
  for (const primitive of primitives) {
    if (primitive.type === 'drill' && primitive.diameter > 0) {
      holes.push({ type: 'hole', x: primitive.cx, y: primitive.cy, diameter: primitive.diameter });
    } else if (primitive.type === 'circle' && primitive.flashed && primitive.r > 0) {
      // Excellon layers ingested via tracespace arrive as flashed circles.
      holes.push({ type: 'hole', x: primitive.cx, y: primitive.cy, diameter: primitive.r * 2 });
    } else if (primitive.type === 'path' && primitive.width > 0 && primitive.segments.length > 0) {
      // Routed Excellon slots are plotted as a tool-width centerline rather
      // than a flashed circle. Keep the original arc/line geometry so the
      // drill operation can machine the complete slot instead of dropping it.
      holes.push({ type: 'slot', width: primitive.width, segments: primitive.segments });
    }
  }
  return holes;
}
