/**
 * Travel-time ordering for toolpaths: greedy nearest-neighbor sequencing of
 * independently-cuttable "units" (a closed ring, an open fragment, a bundle
 * of several rings that must stay together) so the machine jumps as little
 * as possible between them, instead of following whatever incidental order
 * the geometry pipeline (Clipper ring order, primitive iteration order)
 * happened to produce.
 *
 * This operates purely on already-built `Stroke[]` — it never touches
 * geometry, so it can't introduce a correctness regression; it only changes
 * which order strokes are emitted in and where a closed loop starts.
 */
import { distance, pointsClose } from './geom2d';
import type { KPoint, Stroke } from './types';

export interface TravelUnit {
  /** Strokes in this unit's fixed internal order. */
  strokes: Stroke[];
  /**
   * 'closed': a closed loop — entry can be any of its existing piece
   *   boundaries (rotate the stroke sequence; never slice a stroke
   *   mid-arc/mid-polyline).
   * 'open': an open path — entry is either end, reversing internal stroke
   *   (and per-stroke) order/direction if entered from the far end.
   * 'fixed': always entered at strokes[0]'s own start, never reversed or
   *   rotated — for sequences with a real physical ordering constraint (a
   *   drill plunge must always precede its own bore passes; reversing would
   *   have the tool orbit before it's plunged).
   */
  entry: 'closed' | 'open' | 'fixed';
}

/** Cap on rotation candidates considered per closed unit — keeps the O(units² × candidates)
 *  greedy search bounded even for a ring with hundreds of arc-fit pieces. */
const MAX_ROTATION_CANDIDATES = 24;

export function strokeStart(s: Stroke): KPoint {
  return s.type === 'polyline' ? s.points[0] : s.start;
}

export function strokeEnd(s: Stroke): KPoint {
  return s.type === 'polyline' ? s.points[s.points.length - 1] : s.end;
}

function reverseStroke(s: Stroke): Stroke {
  if (s.type === 'polyline') return { type: 'polyline', points: [...s.points].reverse() };
  if (s.type === 'line') return { type: 'line', start: s.end, end: s.start };
  return { type: 'arc', start: s.end, end: s.start, center: s.center, ccw: !s.ccw };
}

function reverseUnitStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.slice().reverse().map(reverseStroke);
}

/**
 * Build a travel unit from a fixed-order stroke sequence, auto-detecting
 * 'closed' vs 'open' from whether the sequence's own start and end coincide.
 * Never produces 'fixed' — that's a stronger constraint only the caller
 * knows about (see `fixedEntryUnit`).
 */
export function unitFromStrokes(strokes: Stroke[]): TravelUnit {
  if (strokes.length === 0) return { strokes, entry: 'open' };
  const closed = pointsClose(strokeStart(strokes[0]), strokeEnd(strokes[strokes.length - 1]), 1e-6);
  return { strokes, entry: closed ? 'closed' : 'open' };
}

/**
 * A unit that must always be entered at its own natural start, never
 * reversed or rotated — e.g. a drill hole's plunge-then-bore sequence.
 */
export function fixedEntryUnit(strokes: Stroke[]): TravelUnit {
  return { strokes, entry: 'fixed' };
}

interface Candidate {
  point: KPoint;
  apply: () => Stroke[];
}

function candidatesFor(unit: TravelUnit): Candidate[] {
  const { strokes, entry } = unit;
  if (strokes.length === 0) return [];
  if (entry === 'fixed') {
    return [{ point: strokeStart(strokes[0]), apply: () => strokes }];
  }
  if (entry === 'open') {
    return [
      { point: strokeStart(strokes[0]), apply: () => strokes },
      { point: strokeEnd(strokes[strokes.length - 1]), apply: () => reverseUnitStrokes(strokes) },
    ];
  }
  // 'closed': sample at most MAX_ROTATION_CANDIDATES evenly-spaced piece
  // boundaries — full precision isn't needed to pick a decent entry point,
  // and this keeps the greedy search's cost bounded regardless of how
  // finely a ring was tessellated/arc-fit.
  const n = strokes.length;
  const step = Math.max(1, Math.ceil(n / MAX_ROTATION_CANDIDATES));
  const out: Candidate[] = [];
  for (let i = 0; i < n; i += step) {
    out.push({ point: strokeStart(strokes[i]), apply: () => [...strokes.slice(i), ...strokes.slice(0, i)] });
  }
  return out;
}

/**
 * Greedy nearest-neighbor sequencing: from `startPos`, repeatedly visit
 * whichever unvisited unit's best entry point is closest, entering there
 * (rotating a closed loop / picking a direction for an open path), and
 * continue from its exit point. O(units² × candidates) — trivially fast at
 * realistic per-operation stroke counts; a full TSP solve is unnecessary
 * for CAM travel ordering.
 */
export function reorderForTravel(units: TravelUnit[], startPos: KPoint = { x: 0, y: 0 }): Stroke[] {
  const remaining = units
    .filter((u) => u.strokes.length > 0)
    .map((u) => ({ unit: u, candidates: candidatesFor(u) }))
    .filter((u) => u.candidates.length > 0);

  const out: Stroke[] = [];
  let cur = startPos;
  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestCandidate: Candidate | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      for (const c of remaining[i].candidates) {
        const d = distance(cur, c.point);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
          bestCandidate = c;
        }
      }
    }
    remaining.splice(bestIdx, 1);
    const oriented = bestCandidate!.apply();
    out.push(...oriented);
    cur = strokeEnd(oriented[oriented.length - 1]);
  }
  return out;
}

/**
 * Chain a FIXED-ORDER sequence of smaller units into one compound unit,
 * optimizing only each unit's OWN entry point/direction relative to where
 * the previous one in the sequence ends — the sequence order itself is
 * never changed. Used for pad-contour groups: outermost→innermost pass
 * order is a deliberate machining choice, not something to reorder, but
 * each individual ring can still start wherever is closest to the tool.
 */
export function chainInFixedOrder(units: TravelUnit[], startPos: KPoint): TravelUnit {
  const strokes: Stroke[] = [];
  let cur = startPos;
  for (const unit of units) {
    const candidates = candidatesFor(unit);
    if (candidates.length === 0) continue;
    let best = candidates[0];
    let bestDist = distance(cur, best.point);
    for (let i = 1; i < candidates.length; i++) {
      const d = distance(cur, candidates[i].point);
      if (d < bestDist) {
        bestDist = d;
        best = candidates[i];
      }
    }
    const oriented = best.apply();
    strokes.push(...oriented);
    cur = strokeEnd(oriented[oriented.length - 1]);
  }
  // 'fixed': the caller's sequence order (e.g. outermost→innermost pad
  // passes) must never be reversed by a later top-level reorder.
  return { strokes, entry: 'fixed' };
}

/** Centroid (simple point average) of a ring — used to correlate a batched
 *  offset's output rings back to the original input they grew from. */
export function centroidOfRing(ring: KPoint[]): KPoint {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/** Index of the centroid nearest a point set's own centroid. */
export function nearestCentroidIndex(points: KPoint[], centroids: KPoint[]): number {
  const c = centroidOfRing(points);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = distance(c, centroids[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
