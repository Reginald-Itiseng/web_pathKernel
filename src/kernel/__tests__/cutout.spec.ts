/**
 * buildCutout: panelized-board keepout regression.
 *
 * Reproduces the real-world bug found in samples/Panel_Gerber — a KiCad
 * panel where each board's own Edge_Cuts outline includes a connecting
 * "finger" (mouse-bite tab) reaching most of the way across the gap toward
 * the neighboring board, as PART of that board's own single closed ring.
 * A uniform outward tool-radius offset on the whole ring pushes the path
 * sideways off that narrow finger by the same amount as everywhere else —
 * on a finger only a couple mm wide, that lands inside the neighbor's own
 * outline, milling into board material that should stay intact.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper } from '../clip';
import { buildCutout } from '../cutout';
import type { CutoutParams, KPoint, KPrimitive } from '../types';

beforeAll(async () => {
  await initClipper();
});

const BASE_PARAMS: CutoutParams = {
  toolDiameterMm: 2, // radius 1mm
  compensation: 'outside',
  holdingTabCount: 0,
  holdingTabWidthMm: 0,
};

function polygonPrimitive(points: KPoint[]): KPrimitive {
  return { type: 'polygon', points, polarity: 'dark', flashed: false };
}

// Board A: a 10x10 square with a 2mm-wide finger poking 3mm up out of its
// top edge, all as ONE continuous ring (mirrors the real panel geometry).
const boardAWithFinger: KPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 6, y: 10 },
  { x: 6, y: 13 },
  { x: 4, y: 13 },
  { x: 4, y: 10 },
  { x: 0, y: 10 },
];

// Board B: sits directly above, its bottom edge exactly where A's finger
// tip reaches — the finger is meant to almost-touch it, not merge into it.
const boardB: KPoint[] = [
  { x: 0, y: 13 },
  { x: 10, y: 13 },
  { x: 10, y: 23 },
  { x: 0, y: 23 },
];

/**
 * Any point landing squarely above the finger's own x-span, well past board
 * B's bottom edge, can only be A's blocked-offset bump crossing into B —
 * B's own legitimate offset ring stays on B's perimeter (bottom edge at
 * y=12, sides at x=-1/11), never cutting through its own interior here.
 */
function pointsAboveFingerInsideB(polylines: KPoint[][]): KPoint[] {
  return polylines.flat().filter((p) => p.x > 3 && p.x < 7 && p.y > 13.5 && p.y < 22.5);
}

describe('buildCutout — panelized board keepout', () => {
  it('does not let one board’s finger offset path cross into the neighboring board', () => {
    const op = buildCutout({
      id: 'cutout-panel',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(boardAWithFinger), polygonPrimitive(boardB)],
      params: BASE_PARAMS,
    });

    // Without the keepout clip, the naive +1mm offset on the finger's tip
    // (y=13) would land at y=14, well inside board B (y in [13,23]).
    expect(pointsAboveFingerInsideB(op.previewPolylines)).toEqual([]);
    // The clip should have left a visible trace in the warnings.
    expect(op.warnings.some((w) => w.includes('neighboring board'))).toBe(true);
    expect(op.strokes.length).toBeGreaterThan(0);
  });

  it('still produces a clean, unwarned, single-ring path for an isolated board (no siblings)', () => {
    const op = buildCutout({
      id: 'cutout-single',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(boardB)],
      params: BASE_PARAMS,
    });
    expect(op.warnings).toEqual([]);
    expect(op.stats.loopCount).toBe(1);
  });

  it('onpath traces the finger to its actual tip, touching but never past board B', () => {
    const op = buildCutout({
      id: 'cutout-onpath',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(boardAWithFinger), polygonPrimitive(boardB)],
      params: { ...BASE_PARAMS, compensation: 'onpath' },
    });
    // onpath draws the original geometry as-is — the finger tip sits exactly
    // at y=13 (board B's own edge), never crossing into B's interior.
    expect(pointsAboveFingerInsideB(op.previewPolylines)).toEqual([]);
  });

  function rect(x0: number, y0: number, x1: number, y1: number): KPoint[] {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }

  function pointsInsideRect(polylines: KPoint[][], x0: number, y0: number, x1: number, y1: number): KPoint[] {
    const eps = 1e-6;
    return polylines
      .flat()
      .filter((p) => p.x > x0 + eps && p.x < x1 - eps && p.y > y0 + eps && p.y < y1 - eps);
  }

  it('a gap exactly as wide as the tool diameter still cuts a complete, unwarned path', () => {
    // Board C (0,0)-(10,10) and board D (0,12)-(10,22): a 2mm gap, tool
    // diameter also 2mm — each board's own +1mm offset meets the other's
    // +1mm keepout exactly at the midline (y=11), touching but not crossing.
    const boardC = rect(0, 0, 10, 10);
    const boardD = rect(0, 12, 10, 22);
    const op = buildCutout({
      id: 'cutout-exact-fit',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(boardC), polygonPrimitive(boardD)],
      params: BASE_PARAMS, // toolDiameterMm: 2
    });

    expect(op.warnings).toEqual([]);
    // The path stays a complete, unbroken rectangle for both boards (no
    // fragmentation from the exact-tangent gap): 2 loops in, 2 loops out.
    expect(op.stats.loopCount).toBe(2);
    expect(pointsInsideRect(op.previewPolylines, 0, 0, 10, 10)).toEqual([]);
    expect(pointsInsideRect(op.previewPolylines, 0, 12, 10, 22)).toEqual([]);
  });

  it('a gap narrower than the tool diameter is safely left uncut, never entering either board', () => {
    // Only a 1mm gap between the boards but a 2mm tool — physically too
    // narrow to cut cleanly without touching one side or the other.
    const boardC = rect(0, 0, 10, 10);
    const boardE = rect(0, 11, 10, 21);
    const op = buildCutout({
      id: 'cutout-too-narrow',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(boardC), polygonPrimitive(boardE)],
      params: BASE_PARAMS, // toolDiameterMm: 2
    });

    expect(op.warnings.length).toBeGreaterThan(0);
    expect(pointsInsideRect(op.previewPolylines, 0, 0, 10, 10)).toEqual([]);
    expect(pointsInsideRect(op.previewPolylines, 0, 11, 10, 21)).toEqual([]);
  });

  it('an interior hole close to the board edge shrinks inward and never crosses out — no keepout rescue needed', () => {
    // Board (0,0)-(50,50). Hole G sits INSIDE the board, its right edge only
    // 2.5mm from the board's own right edge (x=50) — an internal feature
    // drawn within the board's own outline, not a sibling board. With the
    // OLD uniform-direction behavior, G's 'outside' offset would have grown
    // +3mm and landed at x=50.5, half a millimeter PAST the board's edge.
    // Nesting-aware compensation (see `effectiveCompensation`) flips G to
    // 'inside' since it's one level deep, so it shrinks AWAY from the
    // board's edge instead — it can never reach the edge in the first
    // place, so no sibling-keepout rescue is needed at all.
    const board = rect(0, 0, 50, 50);
    const loopG = rect(30, 15, 47.5, 30); // 2.5mm from the board's right edge
    const op = buildCutout({
      id: 'cutout-nested-in-board',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(board), polygonPrimitive(loopG)],
      params: { ...BASE_PARAMS, toolDiameterMm: 6 }, // radius 3mm > the 2.5mm gap to the board's edge
    });

    expect(op.warnings).toEqual([]);
    // Nothing belonging to G may land past the board's own right edge (the
    // board's own offset boundary legitimately grows out to x≈53, but only
    // at its own perimeter — this window sits strictly between the board's
    // drawn edge at x=50 and that outer boundary, in G's own row).
    const crossedBoard = op.previewPolylines
      .flat()
      .filter((p) => p.x > 50 + 1e-6 && p.x < 52.5 && p.y > 15 && p.y < 30);
    expect(crossedBoard).toEqual([]);
    // G's own path shrank INTO its drawn footprint (30-47.5, 15-30), not
    // grown out of it — points near G stay strictly inside that box.
    const gPoints = op.previewPolylines
      .flat()
      .filter((p) => p.x > 25 && p.x < 49 && p.y > 10 && p.y < 35);
    expect(gPoints.length).toBeGreaterThan(0);
    for (const p of gPoints) {
      expect(p.x).toBeGreaterThanOrEqual(30 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(47.5 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(30 + 1e-6);
    }
    expect(op.stats.loopCount).toBe(2);
  });
});

describe('buildCutout — interior hole compensation', () => {
  function rect(x0: number, y0: number, x1: number, y1: number): KPoint[] {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }

  // Points that can only belong to the interior hole's own toolpath: the
  // board's own (0,0)-(40,40) exterior offset never reaches this inner box.
  function holePoints(polylines: KPoint[][]): KPoint[] {
    return polylines.flat().filter((p) => p.x > 5 && p.x < 35 && p.y > 5 && p.y < 35);
  }

  it('an interior hole shrinks inward instead of growing into the surrounding board (outside comp)', () => {
    const board = rect(0, 0, 40, 40);
    const hole = rect(15, 15, 25, 25); // drawn directly inside the board, no rail, no siblings
    const op = buildCutout({
      id: 'cutout-board-with-hole',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(board), polygonPrimitive(hole)],
      params: { ...BASE_PARAMS, toolDiameterMm: 4 }, // radius 2mm
    });

    const pts = holePoints(op.previewPolylines);
    expect(pts.length).toBeGreaterThan(0);
    // The old (buggy) behavior grew the hole's +2mm 'outside' offset out to
    // roughly [13,27] — past the drawn [15,25] edge, eating board material.
    // Correct behavior shrinks the hole's path INTO itself instead, so every
    // point must stay strictly within the drawn hole boundary.
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(25 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(25 + 1e-6);
    }
    expect(op.stats.loopCount).toBe(2);
  });

  it('an island inside that hole flips back to growing outward (material again)', () => {
    const board = rect(0, 0, 40, 40);
    const hole = rect(10, 10, 30, 30);
    const island = rect(17, 17, 23, 23); // a post left standing inside the hole
    const op = buildCutout({
      id: 'cutout-board-with-island',
      layerId: 'edge-cuts',
      label: 'Cutout',
      toolNumber: 1,
      primitives: [polygonPrimitive(board), polygonPrimitive(hole), polygonPrimitive(island)],
      params: { ...BASE_PARAMS, toolDiameterMm: 2 }, // radius 1mm
    });

    // The island (depth 2, same parity as the board) should grow outward
    // like a normal 'outside' boundary: some point must land outside its
    // drawn [17,23] box (up to +1mm), not shrink inward like the hole does.
    const islandArea = op.previewPolylines
      .flat()
      .filter((p) => p.x > 15 && p.x < 25 && p.y > 15 && p.y < 25);
    expect(islandArea.some((p) => p.x < 17 - 1e-6 || p.x > 23 + 1e-6)).toBe(true);
    expect(op.stats.loopCount).toBe(3);
  });
});
