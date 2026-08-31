/**
 * Board cutout toolpath: closed-loop extraction from outline centerlines,
 * per-loop tool compensation, and holding tabs.
 * Port of reference/PathKernel/app/core/cutout.py.
 *
 * The shapely linemerge+polygonize step is replaced with endpoint-snapped
 * chain walking; the healed fallback (buffer out then in) uses Clipper sweeps.
 */
import { DEFAULT_ARC_FIT_OPTIONS, fitArcsToOpenPath, ringPieceToStroke } from './arcFit';
import {
  clipOpenPathsOutside,
  differencePolygons,
  offsetPolygons,
  sweptOpenPaths,
  unionPolygons,
} from './clip';
import {
  dedupePoints,
  distance,
  ensureCcw,
  flattenSegments,
  flattenStroke,
  lineSubstring,
  pathLength,
  pointInRing,
  pointsClose,
  ringArea,
} from './geom2d';
import {
  centroidOfRing,
  chainInFixedOrder,
  reorderForTravel,
  unitFromStrokes,
  type TravelUnit,
} from './pathOrder';
import type {
  CutoutParams,
  KernelOpResult,
  KPoint,
  KPrimitive,
  PolyWithHoles,
  Stroke,
} from './types';

export interface CutoutInput {
  id: string;
  layerId: string;
  label: string;
  toolNumber: number;
  primitives: KPrimitive[];
  params: CutoutParams;
}

export function buildCutout(input: CutoutInput): KernelOpResult {
  const { params } = input;
  if (params.toolDiameterMm <= 0) {
    throw new Error('Tool diameter must be greater than zero.');
  }

  const loops = extractCutoutLoops(input.primitives);
  if (loops.length === 0) {
    throw new Error('Could not derive a closed board outline from this layer.');
  }

  const radius = params.toolDiameterMm / 2;
  const warnings: string[] = [];
  // A cutout layer commonly nests loops: the board's exterior boundary plus
  // one or more interior holes/slots cut directly inside it (or, deeper
  // still, an island sitting inside one of those holes). `params.compensation`
  // is the direction the CALLER chose for the outermost/material boundary;
  // each loop's ACTUAL direction flips on every odd nesting level so an
  // interior hole is offset away from the material surrounding it (shrinking
  // into itself) instead of using the same "grow outward" sign as the
  // exterior loop, which would eat up to a full tool radius into the board
  // around every hole. See `loopNestingDepths` / `effectiveCompensation`.
  const depths = loopNestingDepths(loops);
  const loopCompensations = depths.map((depth) => effectiveCompensation(params.compensation, depth));
  // Panelized boards: a board's own outline loop can include a connecting
  // "finger" reaching across the gap toward a neighboring board (see the
  // keepout comment on compensatedFragments below). Each loop's compensated
  // path is clipped against every OTHER loop's own footprint EXPANDED by the
  // tool radius (excluding ancestors, e.g. an outer panel rail containing
  // everything) so the tool's full swept disk — not just its centerline —
  // never touches a board it doesn't belong to. A gap exactly as wide as the
  // tool diameter still cuts cleanly: each board's own radius-out offset and
  // its neighbor's radius-out keepout meet exactly at the midline, touching
  // but never crossing; anything narrower is safely left uncut instead of
  // gouging into either board.
  const keepoutSets = siblingKeepoutRings(loops, radius);
  const loopFragments: PathFragment[][] = [];
  for (let i = 0; i < loops.length; i++) {
    const comp = loopCompensations[i];
    const fragments = compensatedFragments(loops[i], radius, comp, keepoutSets[i]);
    if (fragments.length === 0) {
      // Skip this ONE loop rather than aborting the whole cutout — either
      // the tool is simply too large for this feature (a hole compensated
      // 'inside' can offset to nothing), or the keepout clip consumed the
      // entire path (the tool can't reach this spot without touching a
      // neighboring board anywhere along it). Either way the other loops
      // may still be perfectly cuttable; only fail if NONE of them are
      // (checked once all loops are processed, below).
      warnings.push(
        keepoutSets[i].length > 0
          ? `Cutout loop ${i + 1}/${loops.length}: skipped — the tool can't reach this feature without cutting into a neighboring board's outline anywhere along its path.`
          : `Cutout loop ${i + 1}/${loops.length}: skipped — compensation '${comp}' produced no valid toolpath (tool likely too large for this loop).`,
      );
      loopFragments.push([]);
      continue;
    }
    if (keepoutSets[i].length > 0 && (fragments.length > 1 || !fragments[0].closed)) {
      warnings.push(
        `Cutout loop ${i + 1}/${loops.length}: compensation path trimmed to avoid cutting into a neighboring board's outline.`,
      );
    }
    loopFragments.push(fragments);
  }

  const tabCount = Math.max(0, Math.floor(params.holdingTabCount));
  const tabWidth = Math.max(0, params.holdingTabWidthMm);
  // The tool (radius r) cuts r beyond each path endpoint (round end caps), so
  // the centerline gap must be tabWidth + toolDiameter to leave tabWidth of
  // actual material. (Deviation from the Python kernel, which used the raw
  // width and silently produced no tab when gap <= tool diameter.)
  const tabGap = tabWidth > 0 ? tabWidth + params.toolDiameterMm : 0;

  const strokes: Stroke[] = [];
  const previewPolylines: KPoint[][] = [];
  // Each fragment's tab-split pieces are chained in their existing (already
  // contiguous) order — only their own entry points are optimized — then all
  // fragments are nearest-neighbor sequenced against each other so the tool
  // finishes one loop (or keepout-trimmed piece of one) before jumping to
  // the next-closest one.
  const loopUnits: TravelUnit[] = [];
  for (const fragments of loopFragments) {
    for (const fragment of fragments) {
      const path = fragment.closed ? [...fragment.path, fragment.path[0]] : fragment.path;
      const tabPieces = fragment.closed
        ? splitPathForHoldingTabs(path, tabCount, tabGap)
        : [path];
      const pieceUnits: TravelUnit[] = [];
      for (const tabPiece of tabPieces) {
        if (tabPiece.length < 2) continue;
        // Re-fit rounded-corner facets into native arcs (see arcFit.ts) so
        // outside/inside compensation with round joins cuts as AA sweeps
        // instead of many short PD segments.
        const pieces = fitArcsToOpenPath(tabPiece, DEFAULT_ARC_FIT_OPTIONS);
        pieceUnits.push(unitFromStrokes(pieces.map(ringPieceToStroke)));
      }
      if (pieceUnits.length === 0) continue;
      loopUnits.push(chainInFixedOrder(pieceUnits, centroidOfRing(path)));
    }
  }
  for (const s of reorderForTravel(loopUnits, { x: 0, y: 0 })) {
    strokes.push(s);
    previewPolylines.push(flattenStroke(s));
  }
  if (strokes.length === 0) {
    throw new Error('Generated cutout toolpath is empty.');
  }

  let totalLength = 0;
  for (const line of previewPolylines) totalLength += pathLength(line);

  return {
    id: input.id,
    kind: 'cutout',
    layerId: input.layerId,
    label: input.label,
    toolNumber: input.toolNumber,
    effectiveToolDiameterMm: params.toolDiameterMm,
    strokes,
    previewPolylines,
    warnings,
    meta: {
      kind: 'cutout_toolpath',
      tool_diameter_mm: params.toolDiameterMm.toFixed(6),
      compensation: params.compensation,
      loop_count: String(loops.length),
      holding_tab_count: String(tabCount),
      holding_tab_width_mm: tabWidth.toFixed(6),
    },
    stats: {
      pathLengthMm: totalLength,
      strokeCount: strokes.length,
      loopCount: loops.length,
    },
  };
}

/**
 * Extract closed outline loops (rings, area-descending) from outline-layer
 * primitives. Port of Python `extract_cutout_loops`.
 */
export function extractCutoutLoops(primitives: KPrimitive[]): KPoint[][] {
  const segments = collectOutlineSegments(primitives);
  const loops: KPoint[][] = [];

  if (segments.length > 0) {
    const snapTol = estimateSnapTolerance(segments);
    const snapped = snapSegmentEndpoints(segments, snapTol);
    loops.push(...chainSegmentsIntoLoops(snapped));

    // Healed fallback: sweep the centerlines outward then shrink back so
    // almost-closed outlines with tiny gaps still form a polygon.
    if (loops.length === 0) {
      const healed = offsetPolygons(sweptOpenPaths(snapped, 0.03), -0.03, 'round');
      for (const ring of healed) {
        if (ring.length >= 3 && Math.abs(ringArea(ring)) > 1e-8) loops.push(ring);
      }
    }
  }

  // Explicit polygon primitives fallback (filled region outlines).
  for (const primitive of primitives) {
    if (primitive.type === 'polygon' && primitive.points.length >= 3) {
      loops.push(dedupePoints(primitive.points));
    } else if (primitive.type === 'outline') {
      const ring = dedupePoints(flattenSegments(primitive.segments));
      if (ring.length >= 3) loops.push(ring);
    }
  }

  const deduped = dedupeLoops(loops);
  const filtered = filterMeaningfulLoops(deduped);
  filtered.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  return filtered;
}

/**
 * Even-odd containment nesting: loops at even depth add material, odd depth
 * subtract. Port of hatching.py `_loops_to_domain`; used for the 3D board.
 */
export function loopsToDomain(loops: KPoint[][]): PolyWithHoles[] {
  const valid = loops.filter((l) => l.length >= 3);
  if (valid.length === 0) return [];

  const areas = valid.map((l) => Math.abs(ringArea(l)));
  const add: KPoint[][] = [];
  const sub: KPoint[][] = [];
  for (let i = 0; i < valid.length; i++) {
    const rp = valid[i][0];
    let depth = 0;
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;
      if (areas[j] <= areas[i]) continue;
      if (pointInRing(rp, valid[j])) depth++;
    }
    if (depth % 2 === 0) add.push(ensureCcw(valid[i]));
    else sub.push(ensureCcw(valid[i]));
  }
  if (add.length === 0) return [];

  const domainRings = unionPolygons(add);
  const rings = sub.length > 0 ? subtract(domainRings, sub) : domainRings;
  return assignHoles(rings);
}

function subtract(subject: KPoint[][], clips: KPoint[][]): KPoint[][] {
  // unionPolygons on clips first keeps orientation consistent.
  const clipRings = unionPolygons(clips);
  if (clipRings.length === 0) return subject;
  return differencePolygons(subject, clipRings);
}

/** Group a signed ring soup into PolyWithHoles by orientation + containment. */
export function assignHoles(rings: KPoint[][]): PolyWithHoles[] {
  const outers: Array<{ ring: KPoint[]; area: number }> = [];
  const holes: KPoint[][] = [];
  for (const ring of rings) {
    const area = ringArea(ring);
    if (area >= 0) outers.push({ ring, area });
    else holes.push(ring);
  }
  const polys: PolyWithHoles[] = outers.map((o) => ({ outer: o.ring, holes: [] }));
  for (const hole of holes) {
    const rp = hole[0];
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (outers[i].area < bestArea && pointInRing(rp, outers[i].ring)) {
        best = i;
        bestArea = outers[i].area;
      }
    }
    if (best >= 0) polys[best].holes.push(hole);
  }
  return polys;
}

function collectOutlineSegments(primitives: KPrimitive[]): KPoint[][] {
  const segments: KPoint[][] = [];
  for (const primitive of primitives) {
    if (primitive.type === 'path') {
      // Outline draws: use the centerline, ignoring stroke width. Split into
      // per-segment polylines so endpoint snapping can re-chain them.
      let run: KPoint[] = [];
      for (const seg of primitive.segments) {
        const pts =
          seg.type === 'line'
            ? [seg.start, seg.end]
            : flattenSegments([seg]);
        if (run.length > 0 && !pointsClose(run[run.length - 1], pts[0], 1e-9)) {
          if (run.length >= 2) segments.push(run);
          run = [];
        }
        for (const p of pts) {
          if (run.length === 0 || !pointsClose(run[run.length - 1], p, 1e-12)) run.push(p);
        }
      }
      if (run.length >= 2) segments.push(run);
    } else if (primitive.type === 'polygon' && primitive.points.length >= 3) {
      segments.push([...primitive.points, primitive.points[0]]);
    } else if (primitive.type === 'outline') {
      const pts = flattenSegments(primitive.segments);
      if (pts.length >= 2) segments.push(pts);
    }
  }
  return segments;
}

function estimateSnapTolerance(segments: KPoint[][]): number {
  const lengths = segments.map(pathLength).filter((l) => l > 0);
  if (lengths.length === 0) return 1e-3;
  const ref = Math.min(...lengths);
  return Math.max(1e-4, Math.min(0.05, ref * 0.002));
}

/**
 * Cluster segment endpoints within `tol` (union-find, averaged
 * representatives) and rewrite segments to the representatives.
 */
export function snapSegmentEndpoints(segments: KPoint[][], tol: number): KPoint[][] {
  const endpoints: KPoint[] = [];
  const segInfo: Array<{ s: number; e: number; mid: KPoint[] }> = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    const s = endpoints.length;
    endpoints.push(seg[0]);
    const e = endpoints.length;
    endpoints.push(seg[seg.length - 1]);
    segInfo.push({ s, e, mid: seg.slice(1, -1) });
  }
  const n = endpoints.length;
  if (n === 0) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distance(endpoints[i], endpoints[j]) <= tol) union(i, j);
    }
  }

  const clusterSums = new Map<number, { x: number; y: number; count: number }>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const sum = clusterSums.get(root) ?? { x: 0, y: 0, count: 0 };
    sum.x += endpoints[i].x;
    sum.y += endpoints[i].y;
    sum.count++;
    clusterSums.set(root, sum);
  }
  const rep = new Map<number, KPoint>();
  for (const [root, sum] of clusterSums) {
    rep.set(root, { x: sum.x / sum.count, y: sum.y / sum.count });
  }

  return segInfo.map(({ s, e, mid }) => [rep.get(find(s))!, ...mid, rep.get(find(e))!]);
}

/**
 * Walk snapped segments into closed loops (replaces shapely
 * linemerge + polygonize). Segments whose chain returns to its start point
 * (within 1e-6 after snapping) become rings.
 */
export function chainSegmentsIntoLoops(segments: KPoint[][]): KPoint[][] {
  const unused = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const loops: KPoint[][] = [];
  const tol = 1e-6;

  while (unused.length > 0) {
    const chain = unused.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      if (pointsClose(chain[0], tail, tol) && chain.length >= 4) break;
      for (let i = 0; i < unused.length; i++) {
        const seg = unused[i];
        const segStart = seg[0];
        const segEnd = seg[seg.length - 1];
        if (pointsClose(tail, segStart, tol)) {
          chain.push(...seg.slice(1));
          unused.splice(i, 1);
          extended = true;
          break;
        }
        if (pointsClose(tail, segEnd, tol)) {
          chain.push(...[...seg].reverse().slice(1));
          unused.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    if (chain.length >= 4 && pointsClose(chain[0], chain[chain.length - 1], 1e-3)) {
      const ring = dedupePoints(chain.slice(0, -1));
      if (ring.length >= 3 && Math.abs(ringArea(ring)) > 1e-8) loops.push(ring);
    }
  }
  return loops;
}

function dedupeLoops(loops: KPoint[][], areaTol = 1e-5, ptTol = 1e-3): KPoint[][] {
  const out: KPoint[][] = [];
  const sigs: Array<{ area: number; x: number; y: number }> = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const area = Math.abs(ringArea(loop));
    const rp = loop[0];
    let duplicate = false;
    for (const sig of sigs) {
      if (Math.abs(area - sig.area) <= areaTol && Math.hypot(rp.x - sig.x, rp.y - sig.y) <= ptTol) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    sigs.push({ area, x: rp.x, y: rp.y });
    out.push(loop);
  }
  return out;
}

function filterMeaningfulLoops(loops: KPoint[][]): KPoint[][] {
  if (loops.length === 0) return [];
  const areas = loops.map((l) => Math.abs(ringArea(l)));
  const perimeters = loops.map((l) => pathLength([...l, l[0]]));
  const maxArea = Math.max(...areas, 0);
  const maxPerimeter = Math.max(...perimeters, 0);
  const minArea = Math.max(1e-6, maxArea * 1e-5);
  const minPerimeter = Math.max(1e-3, maxPerimeter * 1e-4);
  return loops.filter((_, i) => areas[i] >= minArea && perimeters[i] >= minPerimeter);
}

/**
 * How many OTHER loops (each of strictly larger area) contain this loop's
 * representative point — same containment test `loopsToDomain` uses for its
 * even-odd add/subtract fill rule. Depth 0 = an outermost boundary (a board,
 * or a lone panel rail). Depth 1 = a hole cut directly into whatever
 * contains it. Depth 2 = an island sitting inside that hole (material
 * again), and so on, alternating.
 */
function loopNestingDepths(loops: KPoint[][]): number[] {
  const areas = loops.map((l) => Math.abs(ringArea(l)));
  return loops.map((loop, i) => {
    const rp = loop[0];
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (i === j) continue;
      if (areas[j] <= areas[i]) continue;
      if (pointInRing(rp, loops[j])) depth++;
    }
    return depth;
  });
}

/**
 * The compensation direction to actually cut a loop with: `base` (the
 * caller's configured direction, meant for the outermost boundary) flipped
 * once per odd nesting level. Growing a loop's own path outward keeps
 * whatever it directly encloses at full size — correct for an exterior
 * board edge, wrong for a hole one level in (it would grow the tool path
 * into the surrounding board instead of away from it). 'onpath' has no
 * offset to flip; it traces the drawn line as-is at any depth.
 */
function effectiveCompensation(
  base: CutoutParams['compensation'],
  depth: number,
): CutoutParams['compensation'] {
  if (base === 'onpath' || depth % 2 === 0) return base;
  return base === 'outside' ? 'inside' : 'outside';
}

/**
 * For each loop, the set of OTHER loops' own (un-offset) footprints that its
 * compensated path must never enter — every loop that neither contains this
 * one nor is contained BY this one (true peers: siblings on a panel, or
 * unrelated boards/features sharing no ancestor either way).
 *
 * Why this is needed: on a panelized board, one board's own outline loop can
 * include a connecting "finger" that reaches most of the way across the gap
 * toward a neighboring board (KiCad-style mouse-bite tab, drawn as part of
 * the board's own closed ring, not a separate shape). A uniform ±radius
 * offset on the WHOLE loop pushes the path sideways off that narrow finger
 * by the same amount as everywhere else — on a finger only a couple mm wide,
 * that sideways push easily lands inside the neighboring board's own
 * outline. Clipping the compensated path against peer loops' footprints
 * (the exact same `clipOpenPathsOutside` safety-net pattern hatching.ts uses
 * against copper) guarantees the toolpath never cuts into a board it
 * doesn't belong to, at the cost of leaving that one spot un-milled — which
 * is exactly the outcome you want at a mouse-bite bridge anyway.
 *
 * A plain single-board layer has exactly one loop, so this is always `[]`
 * for that case — zero behavior change from before this fix existed.
 *
 * Each peer's keepout is its OWN footprint expanded outward by `radius`
 * (not the raw footprint) — the tool sweeps a full disk of that radius
 * while cutting, so "never touch a neighboring board" means the path must
 * clear every point within one radius of that board's edge, not merely
 * avoid landing literally inside it. This is what makes a gap exactly as
 * wide as the tool diameter still cuttable: this board's own +radius offset
 * and the neighbor's +radius keepout meet exactly at the gap's midline —
 * touching, not overlapping — so nothing gets clipped away there.
 *
 * Ancestors and descendants are deliberately EXCLUDED here (an earlier
 * version treated any non-root ancestor as a keepout too, to protect a hole
 * from crossing out through the board containing it). `effectiveCompensation`
 * now does that job instead, by flipping the offset direction at every
 * nesting level so a properly-nested hole shrinks into itself and an island
 * inside it grows only back out to the hole's own boundary — neither ever
 * reaches its parent's edge in the first place. Treating an ancestor's
 * WHOLE footprint as a keepout doesn't compose with that: a loop nested two
 * or more levels deep (an island inside a hole inside a board) sits
 * entirely inside its non-root parent's footprint by design, so that older
 * rule clipped the entire loop away instead of trimming a genuine overrun.
 */
function siblingKeepoutRings(loops: KPoint[][], radius: number): KPoint[][][] {
  if (loops.length <= 1) return loops.map(() => []);
  const areas = loops.map((l) => Math.abs(ringArea(l)));
  // "a contains b" — b's representative point falls inside a's ring and a
  // has strictly larger area. Two loops are peers when neither contains
  // the other.
  const contains = (a: number, b: number): boolean =>
    areas[a] > areas[b] && pointInRing(loops[b][0], loops[a]);
  // Expand every loop by the tool radius once (not per peer pair).
  const expanded = loops.map((l) => (radius > 0 ? offsetPolygons([l], radius, 'round') : [l]));
  return loops.map((_, i) => {
    const out: KPoint[][] = [];
    for (let j = 0; j < loops.length; j++) {
      if (j === i) continue;
      if (contains(i, j) || contains(j, i)) continue; // ancestor/descendant, not a peer
      out.push(...expanded[j]);
    }
    return out;
  });
}

interface PathFragment {
  path: KPoint[];
  /** true = an unbroken closed ring (open representation, no duplicate endpoint); false = an open piece left by keepout clipping. */
  closed: boolean;
}

/**
 * Tool compensation for one loop, safety-clipped against `keepoutRings` (see
 * `siblingKeepoutRings`). Port of Python `_compensated_path` (outside →
 * outward offset exterior; inside → largest ring of inward offset; onpath →
 * the loop itself), extended with the keepout clip this port adds.
 */
function compensatedFragments(
  loop: KPoint[],
  radius: number,
  compensation: CutoutParams['compensation'],
  keepoutRings: KPoint[][],
): PathFragment[] {
  let best: KPoint[] | null;
  if (compensation === 'onpath') {
    best = loop;
  } else {
    const delta = compensation === 'outside' ? radius : -radius;
    const rings = offsetPolygons([loop], delta, 'round');
    // Largest positive-area ring is the exterior of the offset result.
    best = null;
    let bestArea = -Infinity;
    for (const ring of rings) {
      const area = ringArea(ring);
      if (area > bestArea) {
        bestArea = area;
        best = ring;
      }
    }
    if (best != null && bestArea <= 0) best = null;
  }
  if (best == null || best.length < 3) return [];
  if (keepoutRings.length === 0) return [{ path: best, closed: true }];

  const closedPath = [...best, best[0]];
  const clipped = clipOpenPathsOutside([closedPath], keepoutRings);
  if (clipped.length === 0) return [];
  if (clipped.length === 1 && pointsClose(clipped[0][0], clipped[0][clipped[0].length - 1], 1e-6)) {
    // Nothing was actually inside any sibling's footprint — still one whole
    // closed loop, just re-derived through the clip; drop its duplicated
    // closing point so downstream treats it exactly like the unclipped path.
    return [{ path: clipped[0].slice(0, -1), closed: true }];
  }
  return clipped.map((path) => ({ path, closed: false }));
}

/**
 * Split a (closed) path into pieces separated by holding-tab gaps.
 * Port of Python `_split_path_for_holding_tabs`.
 */
export function splitPathForHoldingTabs(
  points: KPoint[],
  count: number,
  widthMm: number,
): KPoint[][] {
  if (points.length < 2) return [];
  const length = pathLength(points);
  const tabCount = Math.max(0, Math.floor(count));
  const tabWidth = Math.max(0, widthMm);
  if (tabCount <= 0 || tabWidth <= 0 || length <= tabWidth) return [points];

  const safeWidth = Math.min(tabWidth, length / Math.max(1, tabCount * 2));
  const intervals: Array<[number, number]> = [];
  for (let idx = 0; idx < tabCount; idx++) {
    const center = (idx + 0.5) * (length / tabCount);
    intervals.push([
      Math.max(0, center - safeWidth / 2),
      Math.min(length, center + safeWidth / 2),
    ]);
  }

  const cutParts: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of intervals) {
    if (start > cursor) cutParts.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < length) cutParts.push([cursor, length]);

  const out: KPoint[][] = [];
  for (const [start, end] of cutParts) {
    const piece = lineSubstring(points, start, end);
    if (piece && pathLength(piece) > 1e-9) out.push(piece);
  }
  return out;
}
