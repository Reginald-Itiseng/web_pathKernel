/**
 * Horizontal-scanline polygon fill — the raster/serpentine hatch pattern
 * underneath copper-clearing (hatching.ts). Pure geometry, no Clipper
 * dependency; operates on `PolyWithHoles[]` (Clipper's own outer+hole
 * grouping, e.g. from `polysWithHoles`).
 *
 * Classic "flatten all rings, sort crossings, pair as inside intervals"
 * scanline fill: collect every edge crossing (outer AND hole rings together
 * — no need to distinguish which ring an edge belongs to, that's what makes
 * this rule correct for holes) at each row, sort by x, and every other pair
 * is an inside interval. Port of the geometry reference/PathKernel/app/core
 * /hatching.py `_hatch_lines` computes via shapely; this is the from-scratch
 * TS equivalent (shapely has no direct analog in the Clipper/WASM stack).
 */
import type { KPoint, PolyWithHoles } from './types';

/** Minimum segment length kept (matches the Python reference's 1e-6 mm). */
const MIN_SEGMENT_LENGTH_MM = 1e-6;

function rotatePoint(p: KPoint, cosA: number, sinA: number): KPoint {
  return { x: p.x * cosA - p.y * sinA, y: p.x * sinA + p.y * cosA };
}

function rotateRing(ring: KPoint[], cosA: number, sinA: number): KPoint[] {
  return ring.map((p) => rotatePoint(p, cosA, sinA));
}

/**
 * Fill the interior of `polys` with horizontal-in-rotated-space hatch
 * segments, spaced `stepMm` apart, at `angleDeg` (0 = horizontal rows).
 * Returns 2-point segments in serpentine (alternating row direction) order
 * — a reasonable starting order, further optimized by the caller via
 * `pathOrder.ts`'s `reorderForTravel` once keepout-clipping may have
 * fragmented rows into disconnected pieces.
 */
export function hatchFillLines(polys: PolyWithHoles[], stepMm: number, angleDeg: number): KPoint[][] {
  const step = Math.max(0.001, stepMm);
  if (polys.length === 0) return [];

  const rad = (-angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  // Every ring (outer + hole, across all polys) in rotated space — the
  // scanline rule below doesn't care which ring an edge came from.
  const rings: KPoint[][] = [];
  for (const poly of polys) {
    if (poly.outer.length >= 3) rings.push(rotateRing(poly.outer, cosA, sinA));
    for (const hole of poly.holes) {
      if (hole.length >= 3) rings.push(rotateRing(hole, cosA, sinA));
    }
  }
  if (rings.length === 0) return [];

  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return [];

  const backCos = Math.cos(-rad);
  const backSin = Math.sin(-rad);

  // Known, accepted limitation: the crossing test below (`a.y > y !== b.y >
  // y`) is a half-open rule — a row landing EXACTLY on a ring's horizontal
  // edge (or exactly at the region's own maxY, or exactly on a HOLE's top
  // edge) misses that boundary at that one row: worst case for a hole, the
  // row is generated as if the hole weren't there, spanning straight across
  // it. In practice a Clipper-derived region's extents essentially never
  // land on an exact multiple of an arbitrary step spacing (confirmed: this
  // only bit a hand-written unit test using round-number fixtures, not
  // realistic geometry). Even so, this function's output MUST NOT be
  // trusted as copper-safe on its own — the caller (hatching.ts) always
  // re-clips the result against the forbidden zone with Clipper's own
  // `clipOpenPathsOutside`, which has no such edge case, before it becomes
  // an actual toolpath. That second, independent, Clipper-backed clip is
  // the real safety guarantee, not this scanline's own boundary handling.
  const out: KPoint[][] = [];
  let row = 0;
  const rowEps = step * 1e-6;
  for (let y = minY; y <= maxY + rowEps; y += step) {
    const xs: number[] = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        // Same edge test as geom2d.ts's pointInRing — correctly handles
        // vertex-touching rows without double-counting a shared vertex.
        if (a.y > y !== b.y > y) {
          const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
          xs.push(x);
        }
      }
    }
    if (xs.length >= 2) {
      xs.sort((p, q) => p - q);
      const rowSegments: KPoint[][] = [];
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = xs[i];
        const x1 = xs[i + 1];
        if (x1 - x0 <= MIN_SEGMENT_LENGTH_MM) continue;
        rowSegments.push([
          { x: x0, y },
          { x: x1, y },
        ]);
      }
      // Serpentine: reverse row order + reverse each segment on odd rows.
      const ordered =
        row % 2 === 1
          ? rowSegments.reverse().map((seg) => [seg[1], seg[0]])
          : rowSegments;
      for (const seg of ordered) {
        out.push(seg.map((p) => rotatePoint(p, backCos, backSin)));
      }
    }
    row++;
  }

  return out;
}
