/**
 * Regression: the tracespace plotter groups all strokes drawn with one tool
 * into a single imagePath whose segments are DISCONTIGUOUS (measured on
 * motor_driver F_Cu: 125 jumps up to 59 mm inside 10 paths). Ingest must
 * split them into one path primitive per contiguous run, otherwise phantom
 * traces appear between unrelated tracks and isolation becomes garbage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper, polygonSetArea, unionPolygons } from '../clip';
import { primitiveToPolygons } from '../copper';
import { ingestTracespace } from '../ingest/tracespace';

const FIXTURE_DIR = join(__dirname, '../../../test_gerbers/motor_driver');

beforeAll(async () => {
  await initClipper();
});

describe('path continuity', () => {
  it('every ingested path primitive is contiguous', () => {
    const content = readFileSync(join(FIXTURE_DIR, 'ObsidianSpin-F_Cu.gbr'), 'utf8');
    const { layer } = ingestTracespace(content, 'fcu');
    let paths = 0;
    for (const prim of layer.primitives) {
      if (prim.type !== 'path') continue;
      paths++;
      for (let i = 1; i < prim.segments.length; i++) {
        const prevEnd = prim.segments[i - 1].end;
        const currStart = prim.segments[i].start;
        const jump = Math.hypot(currStart.x - prevEnd.x, currStart.y - prevEnd.y);
        expect(jump).toBeLessThanOrEqual(1e-6);
      }
    }
    // Splitting must have produced many more paths than the raw plotter nodes.
    expect(paths).toBeGreaterThan(50);
  });

  it('primitiveToPolygons sweeps disjoint path runs separately (defense in depth)', () => {
    const rings = primitiveToPolygons({
      type: 'path',
      width: 1,
      polarity: 'dark',
      segments: [
        { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        // 40 mm gap — must NOT be bridged with phantom copper.
        { type: 'line', start: { x: 50, y: 0 }, end: { x: 60, y: 0 } },
      ],
    });
    const merged = unionPolygons(rings);
    expect(merged.length).toBe(2);
    // Two 10x1 stripes with round caps: 2 * (10 + pi/4)
    const expected = 2 * (10 + Math.PI * 0.25);
    expect(Math.abs(polygonSetArea(merged) - expected) / expected).toBeLessThan(0.01);
  });
});
