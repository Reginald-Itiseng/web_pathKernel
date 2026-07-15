/**
 * Regression: zone-fill regions arrive CLOCKWISE from the tracespace plotter
 * (measured: all 48 outline regions in motor_driver F_Cu/B_Cu were CW while
 * traces/pads are CCW). Clipper's NonZero union is winding-sensitive, so a CW
 * zone overlapped by a CCW same-net trace cancelled to zero — traces were
 * "clipped out" of zones and gaps appeared at trace↔pad joints. Standalone
 * filled rings must be normalized to CCW before union (shapely's unary_union
 * is orientation-agnostic; this restores that behavior).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper, polygonSetArea } from '../clip';
import { buildCopperGeometry } from '../copper';
import { dedupePoints, flattenSegments, ringArea } from '../geom2d';
import { ingestTracespace } from '../ingest/tracespace';
import type { KPrimitive } from '../types';

const FIXTURE_DIR = join(__dirname, '../../../test_gerbers/motor_driver');

beforeAll(async () => {
  await initClipper();
});

describe('ring orientation vs union', () => {
  it('merges a CW zone with an overlapping CCW trace instead of cancelling', () => {
    const cwZone: KPrimitive = {
      type: 'polygon',
      // 10x10 square, CLOCKWISE
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
      ],
      polarity: 'dark',
      flashed: false,
    };
    const trace: KPrimitive = {
      type: 'path',
      width: 1,
      // Crosses the zone and extends 5mm beyond on each side.
      segments: [{ type: 'line', start: { x: -5, y: 5 }, end: { x: 15, y: 5 } }],
      polarity: 'dark',
    };
    const copper = buildCopperGeometry([cwZone, trace]);
    const area = polygonSetArea(copper);
    // Zone (100) + trace outside the zone (2 stubs of 5x1 + round caps).
    const expected = 100 + 2 * 5 + Math.PI * 0.25;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
    // One connected blob, no hole rings carved where the trace crossed.
    expect(copper.filter((r) => ringArea(r) < 0).length).toBe(0);
  });

  it('motor_driver copper has no cancellation holes under zone traces', () => {
    for (const file of ['ObsidianSpin-F_Cu.gbr', 'ObsidianSpin-B_Cu.gbr']) {
      const content = readFileSync(join(FIXTURE_DIR, file), 'utf8');
      const { layer } = ingestTracespace(content, 'probe');

      // Sanity: this fixture still exercises the CW-region case.
      const cwOutlines = layer.primitives.filter((p) => {
        if (p.type !== 'outline') return false;
        const ring = dedupePoints(flattenSegments(p.segments));
        return ring.length >= 3 && ringArea(ring) < 0;
      });
      expect(cwOutlines.length).toBeGreaterThan(0);

      const copper = buildCopperGeometry(layer.primitives);
      const outerArea = copper.filter((r) => ringArea(r) > 0).reduce((s, r) => s + ringArea(r), 0);
      const holeArea = copper
        .filter((r) => ringArea(r) < 0)
        .reduce((s, r) => s + Math.abs(ringArea(r)), 0);
      // Real boards have a few legitimate holes (e.g. swept loops), but the
      // cancellation bug produced hole area comparable to the trace area.
      // Keep holes below 2% of copper.
      expect(holeArea / outerArea).toBeLessThan(0.02);
    }
  });
});
