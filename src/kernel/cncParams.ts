/**
 * V-bit / tool geometry math.
 * Port of reference/PathKernel/app/core/cnc_params.py and
 * isolation.py `_derive_isolation_tool_geometry`.
 */
import type { IsolationParams, ToolProfile } from './types';

export interface CoppercamParams {
  /** Radius at the material surface at the given depth (mm). */
  effectiveRadius: number;
  /** Effective diameter — single-pass cut width (mm). */
  totalPathWidth: number;
  /** Recommended step-over for 50% overlap (mm). */
  hatchingMargin: number;
  /** Centerline offset compensation to preserve trace width (mm). */
  traceCompensation: number;
}

function cleanNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  return value < 0 ? 0 : value;
}

/**
 * Compute effective V-bit cutting parameters for PCB isolation.
 * effective_radius = tip/2 + depth * tan(angle/2)
 */
export function calculateCoppercamParams(
  tipDiameterMm: number,
  toolAngleDeg: number,
  cuttingDepthMm: number,
): CoppercamParams {
  const tipDia = cleanNonNegativeFinite(tipDiameterMm, 'tipDiameterMm');
  const toolAngle = cleanNonNegativeFinite(toolAngleDeg, 'toolAngleDeg');
  const cutDepth = cleanNonNegativeFinite(cuttingDepthMm, 'cuttingDepthMm');

  const theta = toolAngle > 0 ? (toolAngle / 2) * (Math.PI / 180) : 0;
  const baseRadius = tipDia / 2;
  const flareRadius = theta > 0 ? cutDepth * Math.tan(theta) : 0;
  const effectiveRadius = baseRadius + flareRadius;

  return {
    effectiveRadius,
    totalPathWidth: effectiveRadius * 2,
    // 50% overlap means step-over equals radius.
    hatchingMargin: effectiveRadius,
    traceCompensation: effectiveRadius,
  };
}

export interface IsolationToolGeometry {
  profile: ToolProfile;
  nominalDiameterMm: number;
  tipDiameterMm: number;
  angleDeg: number;
  cuttingDepthMm: number;
  traceMarginMm: number;
  effectiveRadiusMm: number;
  effectiveDiameterMm: number;
  hatchingMarginMm: number;
  traceCompensationMm: number;
}

/** Subset of IsolationParams used by the tool derivation (hatching shares it). */
export type ToolGeometryInputs = Pick<
  IsolationParams,
  | 'toolDiameterMm'
  | 'toolProfile'
  | 'tipDiameterMm'
  | 'toolAngleDeg'
  | 'cuttingDepthMm'
  | 'traceMarginMm'
  | 'overlap'
  | 'hatchingMarginMm'
>;

export function deriveIsolationToolGeometry(params: ToolGeometryInputs): IsolationToolGeometry {
  const nominalDiameter = Math.max(0.001, params.toolDiameterMm || 0);
  const tipDia = Math.max(0, params.tipDiameterMm || 0);
  const angleDeg = Math.max(0, params.toolAngleDeg || 0);
  const cutDepth = Math.max(0, params.cuttingDepthMm || 0);
  const traceMargin = Math.max(0, params.traceMarginMm || 0);
  const overlap = Math.max(0, Math.min(0.999, params.overlap || 0));
  const explicitMargin = Math.max(0, params.hatchingMarginMm || 0);

  if (params.toolProfile === 'conical' || (angleDeg > 0 && cutDepth > 0)) {
    const tip = tipDia > 0 ? tipDia : nominalDiameter;
    const calc = calculateCoppercamParams(tip, angleDeg, cutDepth);
    const effectiveRadius = Math.max(0.001, calc.effectiveRadius);
    const effectiveDiameter = Math.max(0.002, calc.totalPathWidth);
    const autoMargin = Math.max(0.001, calc.hatchingMargin);
    const margin = explicitMargin > 0 ? explicitMargin : autoMargin;
    return {
      profile: 'conical',
      nominalDiameterMm: nominalDiameter,
      tipDiameterMm: tip,
      angleDeg,
      cuttingDepthMm: cutDepth,
      traceMarginMm: traceMargin,
      effectiveRadiusMm: effectiveRadius,
      effectiveDiameterMm: effectiveDiameter,
      hatchingMarginMm: Math.max(0.001, margin),
      traceCompensationMm: Math.max(0.001, effectiveRadius + traceMargin),
    };
  }

  const effectiveDiameter = nominalDiameter;
  const effectiveRadius = Math.max(0.001, effectiveDiameter * 0.5);
  const autoMargin = effectiveDiameter * Math.max(0.01, 1 - overlap);
  const margin = explicitMargin > 0 ? explicitMargin : autoMargin;
  return {
    profile: 'cylindrical',
    nominalDiameterMm: nominalDiameter,
    tipDiameterMm: nominalDiameter,
    angleDeg: 0,
    cuttingDepthMm: 0,
    traceMarginMm: traceMargin,
    effectiveRadiusMm: effectiveRadius,
    effectiveDiameterMm: Math.max(0.002, effectiveDiameter),
    hatchingMarginMm: Math.max(0.001, margin),
    traceCompensationMm: effectiveRadius + traceMargin,
  };
}
