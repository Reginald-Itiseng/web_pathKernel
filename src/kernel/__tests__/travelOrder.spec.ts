/**
 * Integration checks that isolation/drilling actually wire up pathOrder.ts
 * correctly: pad contours stay grouped per pad, and holes get visited
 * nearest-neighbor instead of file order.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper } from '../clip';
import { buildCopperGeometry } from '../copper';
import { distance } from '../geom2d';
import { buildIsolation } from '../isolation';
import { buildDrillToolpaths } from '../drilling';
import { strokeStart } from '../pathOrder';
import type { DrillFeature, DrillParams, IsolationParams, KPrimitive } from '../types';

describe('pad-contour grouping', () => {
  beforeAll(async () => {
    await initClipper();
  });

  it('finishes one pad fully (main ring + whole contour cluster) before moving on', () => {
    // 5 well-separated round pads (20mm apart) — no traces, no ambiguity.
    const padCenters = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 20 },
      { x: 40, y: 20 },
    ];
    const primitives: KPrimitive[] = padCenters.map((c) => ({
      type: 'circle',
      cx: c.x,
      cy: c.y,
      r: 1,
      polarity: 'dark',
      flashed: true,
    }));
    const copper = buildCopperGeometry(primitives);
    const params: IsolationParams = {
      toolDiameterMm: 0.2,
      passes: 1,
      overlap: 0.5,
      isoType: 'exterior',
      toolProfile: 'cylindrical',
      tipDiameterMm: 0.1,
      toolAngleDeg: 30,
      cuttingDepthMm: 0.1,
      traceMarginMm: 0,
      hatchingMarginMm: 0,
      joinStyle: 'round',
      skipTightClearancePaths: false,
      extraPadContours: 4,
    };
    const result = buildIsolation({
      id: 'iso',
      layerId: 'x',
      label: 'test',
      toolNumber: 1,
      copper,
      primitives,
      params,
    });

    // Collapse the stroke sequence into "which pad is the tool nearest to
    // right now", merging consecutive same-pad strokes.
    let lastPad = -1;
    const sequence: number[] = [];
    for (const s of result.strokes) {
      const p = strokeStart(s);
      let nearest = -1;
      let nearestD = Infinity;
      for (let i = 0; i < padCenters.length; i++) {
        const d = distance(p, padCenters[i]);
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
      }
      if (nearest !== lastPad) {
        sequence.push(nearest);
        lastPad = nearest;
      }
    }

    // Each pad may legitimately appear up to TWICE: once for its main-pass
    // ring, once for its whole (outermost→innermost, chained) pad-contour
    // cluster — separate machining stages. A THIRD visit would mean its
    // contour cluster got split across two returns instead of staying one
    // atomic block, which is exactly what pad-major grouping must prevent.
    const counts = new Map<number, number>();
    for (const padIdx of sequence) counts.set(padIdx, (counts.get(padIdx) ?? 0) + 1);
    const overVisited = [...counts.entries()].filter(([, c]) => c > 2);
    expect(overVisited).toEqual([]);
    expect(new Set(sequence).size).toBe(5);
  });
});

describe('drill hole nearest-neighbor sequencing', () => {
  it('visits holes by proximity, not input (file) order', () => {
    // Deliberately scrambled input order — a naive "file order" pass would
    // zigzag across the whole layout.
    const holes: DrillFeature[] = [
      { type: 'hole', x: 0, y: 0, diameter: 0.5 },
      { type: 'hole', x: 100, y: 0, diameter: 0.5 },
      { type: 'hole', x: 1, y: 0, diameter: 0.5 },
      { type: 'hole', x: 101, y: 0, diameter: 0.5 },
      { type: 'hole', x: 2, y: 0, diameter: 0.5 },
      { type: 'hole', x: 102, y: 0, diameter: 0.5 },
    ];
    const params: DrillParams = {
      toolDiameterMm: 0.3,
      lateralStepoverPct: 50,
      allowOversizeForSmallHoles: false,
    };
    const result = buildDrillToolpaths({
      id: 'drill',
      layerId: 'x',
      label: 'test',
      toolNumber: 1,
      holes,
      params,
    });

    // Reconstruct plunge x-positions in stroke order (first stroke of each
    // hole unit is its plunge line).
    const plungeXs: number[] = [];
    for (const s of result.strokes) {
      if (s.type === 'line' && Math.abs(s.start.y) < 1e-9) {
        plungeXs.push(s.start.x);
      }
    }
    // Nearest-neighbor from (0,0) must cluster the {0,1,2} group fully
    // before jumping to the {100,101,102} group — never interleaved.
    const firstGroupDone = plungeXs.slice(0, 3).every((x) => x < 50);
    const secondGroupAfter = plungeXs.slice(3).every((x) => x > 50);
    expect(firstGroupDone).toBe(true);
    expect(secondGroupAfter).toBe(true);
  });
});
