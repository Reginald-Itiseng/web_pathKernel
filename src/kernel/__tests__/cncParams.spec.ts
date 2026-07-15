import { describe, expect, it } from 'vitest';
import { calculateCoppercamParams, deriveIsolationToolGeometry } from '../cncParams';

describe('calculateCoppercamParams', () => {
  it('matches the Python golden: tip 0.1mm, 30 deg, depth 0.1mm', () => {
    const out = calculateCoppercamParams(0.1, 30, 0.1);
    // r_eff = 0.05 + 0.1 * tan(15deg) = 0.05 + 0.0267949...
    expect(out.effectiveRadius).toBeCloseTo(0.0767949, 6);
    expect(out.totalPathWidth).toBeCloseTo(0.1535898, 6);
    expect(out.hatchingMargin).toBeCloseTo(out.effectiveRadius, 12);
    expect(out.traceCompensation).toBeCloseTo(out.effectiveRadius, 12);
  });

  it('degenerates to a cylinder when angle or depth is zero', () => {
    expect(calculateCoppercamParams(0.8, 0, 1).effectiveRadius).toBeCloseTo(0.4, 12);
    expect(calculateCoppercamParams(0.8, 30, 0).effectiveRadius).toBeCloseTo(0.4, 12);
  });

  it('clamps negative inputs to zero and rejects non-finite', () => {
    expect(calculateCoppercamParams(-1, 30, 0.1).effectiveRadius).toBeCloseTo(
      0.1 * Math.tan((15 * Math.PI) / 180),
      9,
    );
    expect(() => calculateCoppercamParams(Number.NaN, 30, 0.1)).toThrow();
  });
});

describe('deriveIsolationToolGeometry', () => {
  const base = {
    toolDiameterMm: 0.8,
    toolProfile: 'cylindrical' as const,
    tipDiameterMm: 0,
    toolAngleDeg: 0,
    cuttingDepthMm: 0,
    traceMarginMm: 0,
    overlap: 0,
    hatchingMarginMm: 0,
  };

  it('cylindrical: effective = nominal, margin from overlap', () => {
    const out = deriveIsolationToolGeometry({ ...base, overlap: 0.5 });
    expect(out.profile).toBe('cylindrical');
    expect(out.effectiveDiameterMm).toBeCloseTo(0.8, 12);
    expect(out.effectiveRadiusMm).toBeCloseTo(0.4, 12);
    expect(out.hatchingMarginMm).toBeCloseTo(0.4, 12); // dia * (1 - 0.5)
    expect(out.traceCompensationMm).toBeCloseTo(0.4, 12);
  });

  it('conical trigger via angle+depth even when profile says cylindrical', () => {
    const out = deriveIsolationToolGeometry({
      ...base,
      tipDiameterMm: 0.1,
      toolAngleDeg: 30,
      cuttingDepthMm: 0.1,
    });
    expect(out.profile).toBe('conical');
    expect(out.effectiveRadiusMm).toBeCloseTo(0.0767949, 6);
    expect(out.hatchingMarginMm).toBeCloseTo(0.0767949, 6);
  });

  it('conical falls back to nominal diameter when tip is zero', () => {
    const out = deriveIsolationToolGeometry({
      ...base,
      toolProfile: 'conical',
      toolAngleDeg: 20,
      cuttingDepthMm: 0.05,
    });
    expect(out.tipDiameterMm).toBeCloseTo(0.8, 12);
  });

  it('trace margin adds to compensation but not to effective radius', () => {
    const out = deriveIsolationToolGeometry({ ...base, traceMarginMm: 0.1 });
    expect(out.effectiveRadiusMm).toBeCloseTo(0.4, 12);
    expect(out.traceCompensationMm).toBeCloseTo(0.5, 12);
  });

  it('explicit hatching margin overrides the derived one', () => {
    const out = deriveIsolationToolGeometry({ ...base, overlap: 0.5, hatchingMarginMm: 0.123 });
    expect(out.hatchingMarginMm).toBeCloseTo(0.123, 12);
  });
});
