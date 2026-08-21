/**
 * Circular-arc detection for Clipper-tessellated polygon rings/paths.
 *
 * `offsetPolygons`/`clipOpenPathsOutside` (clip.ts) return plain vertex
 * lists — Clipper has no curve primitive, so every round join it inserts
 * (the default `joinStyle: 'round'`) is baked in as short straight facets at
 * Clipper's own `ARC_TOLERANCE`. Pushed straight into a `Stroke.polyline`,
 * those facets become individual `PD` moves in HPGL export instead of one
 * native `AA` arc — unlike drilling (drilling.ts `boreHole`), which builds a
 * true `Stroke.arc` directly and never touches Clipper.
 *
 * This module re-fits those facet runs back into real circular arcs after
 * the fact: it walks a tessellated ring/path, finds maximal runs of
 * vertices with consistent turning direction and curvature, fits a circle
 * through each candidate run, and accepts the fit only if every point in
 * the run sits within tolerance of that circle. Anything that doesn't fit
 * cleanly (straight edges, sharp miter/bevel corners, ambiguous runs) is
 * left as a straight line piece — the existing, safe behavior. Geometric
 * accuracy always wins over arc-detection: a rejected/ambiguous fit never
 * produces an arc.
 */
import { dedupePoints, flattenArc, pointsClose } from './geom2d';
import type { KPoint, Stroke } from './types';

export interface ArcFitOptions {
  /** Max allowed distance from any run point to the fitted circle (mm). */
  toleranceMm: number;
  /** Fewest points a candidate curved run must have to attempt a fit. */
  minRunPoints: number;
  /** Reject fits below this radius (guards against degenerate near-points). */
  minRadiusMm: number;
}

/**
 * Clipper's own round-join tessellation error floor is ~0.005mm
 * (clip.ts ARC_TOLERANCE) — the fit tolerance sits above that so genuine
 * round joins reliably pass, while still being tight enough to reject
 * runs that merely look curved.
 */
export const DEFAULT_ARC_FIT_OPTIONS: ArcFitOptions = {
  toleranceMm: 0.01,
  // 3 points always fit some circle exactly, by construction — 4 gives only
  // one extra constraint beyond that, which isn't enough evidence to reject
  // a large-radius circle passing near a handful of nearly-collinear points
  // (confirmed on a real board: a dead-straight ~100mm edge ending right at
  // a ring's wraparound seam, where only 4 points remained available, fit a
  // spurious r≈356mm "arc" that no turn-angle or radius-drift check caught
  // — there wasn't enough data yet for those checks to have anything to
  // compare against). 6 points meaningfully over-constrains the fit.
  minRunPoints: 6,
  minRadiusMm: 0.02,
};

export type RingPiece =
  | { kind: 'line'; points: KPoint[] }
  | { kind: 'arc'; start: KPoint; end: KPoint; center: KPoint; radius: number; ccw: boolean };

/** Vertex turn angles below this are treated as straight (float/facet noise). */
const MIN_CURVE_TURN_RAD = (0.05 * Math.PI) / 180;
/**
 * Reject any candidate run containing a single facet turning more than this.
 * Real round-join tessellation always advances in many small steps — with
 * clip.ts's delta-scaled arc tolerance, a genuine corner-join facet measures
 * roughly 8-15° across the whole practical offset range (verified directly:
 * a 90° pad corner tessellates to ~7 facets, ~13° each). A single large turn
 * is a genuine polygon corner, not a facet.
 *
 * This must stay well below common CAD corner angles, not just 90° — a
 * board outline chamfered at 45° (routine in PCB design) offset with a
 * TINY round-join radius can still collapse to one facet per corner, since
 * even one facet spanning 45° may satisfy tolerance at a small enough
 * radius. Without a tight cap here, a chain of such corners (chamfer →
 * straight → chamfer) gets greedily merged into one bogus large-radius arc
 * spanning several genuinely straight/differently-angled edges — confirmed
 * on a real board's chamfered outline corner. 20° sits with margin below
 * every common sharp-corner angle (45°, 90°, ...) while comfortably above
 * genuine facet sizes.
 */
const MAX_SINGLE_FACET_TURN_RAD = (20 * Math.PI) / 180;
/**
 * Max relative radius change allowed between one accepted fit and the next
 * as a run grows. A genuine single circle's fit is stable (near 0% change)
 * from its very first 3-point sample; a run drifting across a feature
 * boundary shows large, monotonic drift well before its absolute residual
 * would exceed tolerance — see `growArcRun`.
 */
const RADIUS_DRIFT_TOLERANCE = 0.1;
/** Determinant floor for the circle-fit normal equations — guards only true zero/duplicate-point cases. */
const FIT_DET_EPS = 1e-20;
/** Reject fitted radii above this as numerically degenerate, not a real CAM feature (matches clip.ts MAX_EXTENT_MM). */
const MAX_FIT_RADIUS_MM = 10_000;

/**
 * Fit arcs into a CLOSED ring (open vertex list — no duplicate closing
 * point; the ring is implicitly closed, matching `offsetPolygons` output).
 */
export function fitArcsToClosedRing(
  ringIn: KPoint[],
  opts: ArcFitOptions = DEFAULT_ARC_FIT_OPTIONS,
): RingPiece[] {
  const ring = dedupeClosed(ringIn);
  if (ring.length < 3) return [{ kind: 'line', points: [...ringIn, ringIn[0]] }];

  // Close the ring into a plain open path and run the same incremental scan
  // used for open paths. A ring that's genuinely one circle throughout (an
  // isolated round pad's boundary) is naturally consumed as one run growing
  // from index 0 all the way to the closing duplicate point, reproducing
  // the full-circle `start === end` convention with no special-casing.
  //
  // The seam this introduces at ring[0] can occasionally split one true arc
  // into two pieces if it happens to fall inside a curved run that also
  // contains straight edges elsewhere — harmless (still exact geometry,
  // just one extra AA command).
  return scanLinear([...ring, ring[0]], opts);
}

/** Fit arcs into an OPEN path (e.g. a post-clip pad-contour fragment). */
export function fitArcsToOpenPath(
  pathIn: KPoint[],
  opts: ArcFitOptions = DEFAULT_ARC_FIT_OPTIONS,
): RingPiece[] {
  const path = dedupePoints(pathIn);
  if (path.length < 3) return [{ kind: 'line', points: pathIn }];
  return scanLinear(path, opts);
}

/** Convert a fitted piece into the kernel's `Stroke` representation. */
export function ringPieceToStroke(piece: RingPiece): Stroke {
  if (piece.kind === 'arc') {
    return { type: 'arc', start: piece.start, end: piece.end, center: piece.center, ccw: piece.ccw };
  }
  return { type: 'polyline', points: piece.points };
}

/** Flatten a fitted piece into preview points (arcs via the shared chord tolerance). */
export function ringPiecePreviewPoints(piece: RingPiece, chordMm?: number): KPoint[] {
  if (piece.kind === 'arc') {
    return flattenArc(piece.start, piece.end, piece.center, piece.ccw, chordMm);
  }
  return piece.points;
}

// ── internals ────────────────────────────────────────────────────────────

function dedupeClosed(ring: KPoint[]): KPoint[] {
  const deduped = dedupePoints(ring);
  if (deduped.length > 1 && pointsClose(deduped[0], deduped[deduped.length - 1])) {
    deduped.pop();
  }
  return deduped;
}

function signedTurn(a: KPoint, b: KPoint, c: KPoint): number {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 <= 1e-12 || l2 <= 1e-12) return 0;
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  return Math.atan2(cross, dot);
}

/**
 * Linear scan over a plain (non-wrapping) point sequence, using a greedy
 * incremental fit: from each unconsumed index, grow a candidate run one
 * point at a time and RE-FIT a circle through the whole candidate range on
 * every extension, stopping the instant a point breaks tolerance.
 *
 * This is deliberately not "classify each vertex's local turn, then bulk-fit
 * whatever shares a sign" — a *tessellated* (chorded) arc's boundary vertex,
 * where it meets a straight edge, still shows a small nonzero turn (roughly
 * half a facet angle, from the chord lagging the true tangent), locally
 * indistinguishable from an ordinary interior facet. Only re-checking the
 * fit residual as the run grows reliably catches that transition — the
 * residual immediately blows up once a point from a genuinely different
 * curve (or a straight run) enters the candidate range.
 */
function scanLinear(points: KPoint[], opts: ArcFitOptions): RingPiece[] {
  const m = points.length;
  if (m < 3) return [{ kind: 'line', points }];
  const minRun = Math.max(3, opts.minRunPoints);

  const pieces: RingPiece[] = [];
  let segStart = 0;
  let i = 0;
  while (i <= m - minRun) {
    const grown = growArcRun(points, i, opts);
    if (grown && grown.end - i + 1 >= minRun) {
      if (i > segStart) {
        pieces.push({ kind: 'line', points: points.slice(segStart, i + 1) });
      }
      pieces.push({
        kind: 'arc',
        start: points[i],
        end: points[grown.end],
        center: grown.center,
        radius: grown.radius,
        ccw: grown.ccw,
      });
      segStart = grown.end;
      i = grown.end;
      continue;
    }
    i++;
  }
  if (segStart < m - 1) {
    pieces.push({ kind: 'line', points: points.slice(segStart) });
  }
  return pieces.length > 0 ? pieces : [{ kind: 'line', points }];
}

interface GrownArc {
  end: number;
  center: KPoint;
  radius: number;
  ccw: boolean;
}

/**
 * Greedily extend a candidate run starting at `points[startIdx]` as far as
 * possible. Each extension is gated by:
 *  - the local turn at the newly added vertex (consistent nonzero sign,
 *    capped magnitude — rejects a jump into a genuine sharp corner before
 *    even attempting a fit), and
 *  - a fresh circle fit over the whole candidate range so far, and
 *  - radius stability against the previous accepted fit.
 *
 * The radius-stability check earns its keep at a tangent transition: right
 * where one true curve (or a straight edge) meets another, the ABSOLUTE
 * per-point residual can stay inside tolerance for several points past the
 * boundary — a large "compromise" circle can track a straight edge blending
 * into the start of a different, smaller-radius arc closely enough to pass,
 * purely because near a tangent point every explanation looks similar over
 * a short span (this was measured directly: a real single-radius run's
 * fitted radius is stable from its very first 3-point fit, while a run
 * straddling two different features drifts monotonically, e.g.
 * 91→43→29→22mm, well before its residual ever exceeds tolerance). Once a
 * radius has been established, a fresh fit that needs to move far from it
 * to keep fitting is a sign of drifting onto a different feature, not
 * continuing to sample the same one.
 *
 * Returns the best (longest) accepted extent, or null if not even the
 * minimal 3-point range holds up.
 */
function growArcRun(points: KPoint[], startIdx: number, opts: ArcFitOptions): GrownArc | null {
  const n = points.length;
  let end = startIdx + 2;
  if (end >= n) return null;

  let sign: -1 | 0 | 1 = 0;
  let best: GrownArc | null = null;
  while (end < n) {
    if (end - startIdx >= 2) {
      const t = signedTurn(points[end - 2], points[end - 1], points[end]);
      const mag = Math.abs(t);
      if (mag < MIN_CURVE_TURN_RAD || mag > MAX_SINGLE_FACET_TURN_RAD) break;
      const s: -1 | 1 = t > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) break;
    }
    const fit = fitCircle(points.slice(startIdx, end + 1), opts);
    if (!fit) break;
    if (best && Math.abs(fit.radius - best.radius) / best.radius > RADIUS_DRIFT_TOLERANCE) break;
    best = { end, center: fit.center, radius: fit.radius, ccw: sign > 0 };
    end++;
  }
  return best;
}

/**
 * Closed-form Kåsa least-squares circle fit, recentered on the run's first
 * point for numerical stability (board coordinates are rarely near the
 * origin). Rejects degenerate/near-collinear runs and enforces the
 * per-point residual tolerance + minimum radius from `opts`.
 */
function fitCircle(points: KPoint[], opts: ArcFitOptions): { center: KPoint; radius: number } | null {
  const ox = points[0].x;
  const oy = points[0].y;

  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  let Sx = 0;
  let Sy = 0;
  let Sxz = 0;
  let Syz = 0;
  let Sz = 0;
  const n = points.length;
  for (const p of points) {
    const x = p.x - ox;
    const y = p.y - oy;
    const z = x * x + y * y;
    Sxx += x * x;
    Syy += y * y;
    Sxy += x * y;
    Sx += x;
    Sy += y;
    Sxz += x * z;
    Syz += y * z;
    Sz += z;
  }

  // Solve [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy n] · [A B C]ᵀ = [Sxz Syz Sz]ᵀ for
  // the circle x²+y² = Ax + By + C, i.e. center (A/2, B/2).
  //
  // The determinant's raw magnitude is NOT a scale-invariant degeneracy
  // signal here: recentering keeps coordinates small, so a short window of
  // a large-radius (hence locally shallow/near-collinear) arc naturally
  // produces a tiny determinant even though the fit itself is perfectly
  // well-resolved (3 points on a true circle recover it near-exactly
  // regardless of how "flat" the local window looks). Only true zero
  // (duplicate/degenerate points) needs guarding here — the *result* is
  // validated below instead (finite, plausible radius, then the per-point
  // residual tolerance).
  const det = det3(Sxx, Sxy, Sx, Sxy, Syy, Sy, Sx, Sy, n);
  if (Math.abs(det) < FIT_DET_EPS) return null;

  const A = det3(Sxz, Sxy, Sx, Syz, Syy, Sy, Sz, Sy, n) / det;
  const B = det3(Sxx, Sxz, Sx, Sxy, Syz, Sy, Sx, Sz, n) / det;
  const C = det3(Sxx, Sxy, Sxz, Sxy, Syy, Syz, Sx, Sy, Sz) / det;

  const cx = A / 2;
  const cy = B / 2;
  const r2 = C + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  if (!Number.isFinite(radius) || radius > MAX_FIT_RADIUS_MM) return null;
  if (radius < opts.minRadiusMm) return null;

  for (const p of points) {
    const x = p.x - ox;
    const y = p.y - oy;
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - radius) > opts.toleranceMm) return null;
  }

  return { center: { x: cx + ox, y: cy + oy }, radius };
}

function det3(
  m00: number,
  m01: number,
  m02: number,
  m10: number,
  m11: number,
  m12: number,
  m20: number,
  m21: number,
  m22: number,
): number {
  return (
    m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20)
  );
}
