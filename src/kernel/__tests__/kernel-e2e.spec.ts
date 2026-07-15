/**
 * End-to-end kernel run on the motor_driver fixtures: ingest → copper →
 * isolation + drill + cutout → 3D model → HPGL export.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper, polygonSetArea } from '../clip';
import { runKernelJob } from '../index';
import { exportHpgl } from '../hpgl';
import { ingestTracespace } from '../ingest/tracespace';
import type { KernelJobInput, KernelJobResult } from '../types';

const FIXTURE_DIR = join(__dirname, '../../../test_gerbers/motor_driver');

function load(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

let result: KernelJobResult;

const input: KernelJobInput = { layers: [], operations: [] };

beforeAll(async () => {
  await initClipper();
  input.layers = [
    { ...ingestTracespace(load('ObsidianSpin-F_Cu.gbr'), 'fcu').layer, role: 'top-copper' },
    { ...ingestTracespace(load('ObsidianSpin-B_Cu.gbr'), 'bcu').layer, role: 'bottom-copper' },
    { ...ingestTracespace(load('ObsidianSpin-Edge_Cuts.gbr'), 'edge').layer, role: 'board-outline' },
    { ...ingestTracespace(load('ObsidianSpin.drl'), 'drl').layer, role: 'drill' },
  ];
  input.operations = [
    {
      id: 'iso-fcu',
      kind: 'isolation',
      layerId: 'fcu',
      toolNumber: 1,
      params: {
        toolDiameterMm: 0.2,
        passes: 2,
        overlap: 0.5,
        isoType: 'both',
        toolProfile: 'conical',
        tipDiameterMm: 0.1,
        toolAngleDeg: 30,
        cuttingDepthMm: 0.1,
        traceMarginMm: 0,
        hatchingMarginMm: 0,
        joinStyle: 'round',
        skipTightClearancePaths: false,
        extraPadContours: 0,
      },
    },
    {
      id: 'drill-1',
      kind: 'drill',
      layerId: 'drl',
      toolNumber: 2,
      params: { toolDiameterMm: 0.8, lateralStepoverPct: 50, allowOversizeForSmallHoles: false },
    },
    {
      id: 'cut-1',
      kind: 'cutout',
      layerId: 'edge',
      toolNumber: 3,
      params: {
        toolDiameterMm: 2,
        compensation: 'outside',
        holdingTabCount: 4,
        holdingTabWidthMm: 1,
      },
    },
  ];
  result = await runKernelJob(input);
}, 60_000);

describe('kernel end-to-end on motor_driver', () => {
  it('runs all three operations without op-level failures', () => {
    expect(result.warnings.filter((w) => w.includes('failed'))).toEqual([]);
    expect(result.operations.map((o) => o.kind).sort()).toEqual(['cutout', 'drill', 'isolation']);
  });

  it('isolation produces closed rings with sane total length', () => {
    const iso = result.operations.find((o) => o.kind === 'isolation')!;
    expect(iso.strokes.length).toBeGreaterThan(4);
    expect(iso.stats.pathLengthMm).toBeGreaterThan(50);
    expect(iso.stats.pathLengthMm).toBeLessThan(100_000);
    // Every isolation stroke is a closed loop.
    for (const stroke of iso.strokes) {
      if (stroke.type !== 'polyline') continue;
      const first = stroke.points[0];
      const last = stroke.points[stroke.points.length - 1];
      expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1e-6);
    }
  });

  it('drill emits a plunge for every drillable hole and arcs for larger ones', () => {
    const drill = result.operations.find((o) => o.kind === 'drill')!;
    expect(drill.stats.plungeCount).toBeGreaterThan(0);
    const holeCount = Number(drill.meta.drill_hole_count);
    expect(drill.stats.plungeCount! + drill.stats.skippedSmallHoles!).toBe(holeCount);
  });

  it('cutout finds the board outline loop and splits it into tab gaps', () => {
    const cut = result.operations.find((o) => o.kind === 'cutout')!;
    expect(cut.stats.loopCount).toBeGreaterThanOrEqual(1);
    // 4 tabs on a single closed loop → 4 or 5 pieces (first/last may merge).
    expect(cut.strokes.length).toBeGreaterThanOrEqual(4);
  });

  it('3D machining sim: engraved clad on both sides, channels removed', () => {
    expect(result.board3d.boardOutline.length).toBeGreaterThanOrEqual(1);
    const sides = new Set(result.board3d.copper.map((c) => c.side));
    expect(sides.has('top')).toBe(true);
    expect(sides.has('bottom')).toBe(true);

    const boardArea = result.board3d.boardOutline.reduce(
      (sum, p) => sum + Math.abs(polygonSetArea([p.outer])),
      0,
    );
    for (const copper of result.board3d.copper) {
      const area = copper.polys.reduce(
        (sum, p) =>
          sum +
          Math.abs(polygonSetArea([p.outer])) -
          p.holes.reduce((h, ring) => h + Math.abs(polygonSetArea([ring])), 0),
        0,
      );
      // Engraved clad: isolation channels remove SOME copper, but most of the
      // sheet remains (isolation-only milling keeps unused copper).
      expect(area).toBeGreaterThan(boardArea * 0.5);
      expect(area).toBeLessThan(boardArea);
    }
  });

  it('3D cutout: groove milled through stock, retaining tabs keep one piece', () => {
    // The stock stays one connected polygon — the tab gaps hold the board.
    expect(result.board3d.boardOutline.length).toBe(1);
    const substrate = result.board3d.boardOutline[0];
    // Holes = cutout channel pieces (4 tabs → ≥4 arcs) + 72 drill holes.
    expect(substrate.holes.length).toBeGreaterThanOrEqual(4 + 70);
  });

  it('3D custom stock: substrate matches the configured panel size', async () => {
    const custom = await runKernelJob({
      layers: input.layers,
      operations: [],
      stock: { widthMm: 200, heightMm: 150, offsetXMm: 10, offsetYMm: 10 },
    });
    expect(custom.board3d.boardOutline.length).toBe(1);
    const area = Math.abs(polygonSetArea([custom.board3d.boardOutline[0].outer]));
    expect(area).toBeCloseTo(200 * 150, 3);
    for (const copper of custom.board3d.copper) {
      const cladArea = Math.abs(polygonSetArea([copper.polys[0].outer]));
      expect(cladArea).toBeCloseTo(200 * 150, 3);
    }
  });

  it('3D before generation: plain full copper clad, no circuit, no holes', async () => {
    const base = await runKernelJob({ layers: input.layers, operations: [] });
    // Stock rectangle substrate (no cutout op yet) with untouched clad.
    expect(base.board3d.boardOutline.length).toBe(1);
    expect(base.board3d.boardOutline[0].holes.length).toBe(0);
    const stockArea = Math.abs(polygonSetArea([base.board3d.boardOutline[0].outer]));
    expect(base.board3d.copper.length).toBe(2); // double-sided: 2 copper layers loaded
    for (const copper of base.board3d.copper) {
      expect(copper.polys.length).toBe(1);
      expect(copper.polys[0].holes.length).toBe(0); // no engraving yet
      const area = Math.abs(polygonSetArea([copper.polys[0].outer]));
      expect(Math.abs(area - stockArea) / stockArea).toBeLessThan(1e-6); // full sheet
    }
  });

  it('3D single-sided: only one clad side when one copper layer is loaded', async () => {
    const singleSided = await runKernelJob({
      layers: input.layers.filter((l) => l.role !== 'bottom-copper'),
      operations: [],
    });
    expect(singleSided.board3d.copper.length).toBe(1);
    expect(singleSided.board3d.copper[0].side).toBe('top');
  });

  it('exports well-formed HPGL', () => {
    const { text } = exportHpgl(result.operations);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('IN;');
    expect(lines[1]).toBe('PA;');
    expect(lines[lines.length - 1]).toBe('PU0,0;SP0;');
    expect(text).toContain('SP1;');
    expect(text).toContain('SP2;');
    expect(text).toContain('SP3;');
    expect(text).toMatch(/AA-?\d+,-?\d+,[-\d.]+;/); // drill bore arcs
    // PD batches never exceed 12 coordinate pairs.
    for (const line of lines) {
      const match = /^PD([-\d,]+);$/.exec(line);
      if (!match) continue;
      const pairCount = match[1].split(',').length / 2;
      expect(pairCount).toBeLessThanOrEqual(12);
    }
    // Normalized: no negative coordinates in PU/PD moves.
    for (const line of lines) {
      const coordMatch = /^P[UD]([-\d,]+);$/.exec(line);
      if (!coordMatch) continue;
      for (const value of coordMatch[1].split(',')) {
        expect(Number(value)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reports a minimum copper gap', () => {
    expect(result.minimumCopperGapMm).not.toBeNull();
    expect(result.minimumCopperGapMm!).toBeGreaterThan(0);
    expect(result.minimumCopperGapMm!).toBeLessThan(5);
  });
});
