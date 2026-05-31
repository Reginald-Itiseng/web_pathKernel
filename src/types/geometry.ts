export type PadShape = 'circle' | 'rect' | 'ring' | 'polygon' | 'complex';

export interface PadDefinition {
  /** Full SVG def id, e.g. "board-abc_pad-D1.0" */
  defId: string;
  /** Tool code suffix after "_pad-", e.g. "D1.0" */
  toolCode: string;
  shape: PadShape;
  /** circle / ring: diameter = r×2 / 1000. null for rect/complex. */
  diameterMm: number | null;
  /** rect: width in mm. null otherwise. */
  widthMm: number | null;
  /** rect: height in mm. null otherwise. */
  heightMm: number | null;
  /** ring (annular): stroke-width / 1000. null otherwise. */
  ringStrokeWidthMm: number | null;
}

/** One placed pad instance — a `<use>` element inside the layer group. */
export interface PadInstance {
  /** References PadDefinition.defId */
  defId: string;
  /** use.x / 1000 — Gerber X in mm (pre-Y-flip coordinate) */
  xMm: number;
  /** use.y / 1000 — Gerber Y in mm (pre-Y-flip coordinate) */
  yMm: number;
  layerId: string;
}

/** A unique stroke-width class among trace paths in a layer. */
export interface TraceClass {
  /** Raw SVG stroke-width value (Gerber units × 1000). Key for edits. */
  strokeWidthRaw: number;
  /** Human-readable: strokeWidthRaw / 1000 */
  widthMm: number;
  instanceCount: number;
  layerId: string;
}

/** One drill hole instance extracted from a drill layer. */
export interface HoleInstance {
  defId: string;
  diameterMm: number;
  xMm: number;
  yMm: number;
  layerId: string;
}

/** A copper pad matched to a drill hole at the same board position. */
export interface PadHoleMatch {
  pad: PadInstance;
  hole: HoleInstance;
  distanceMm: number;
}

export interface LayerGeometry {
  layerId: string;
  padDefs: PadDefinition[];
  padInstances: PadInstance[];
  traceClasses: TraceClass[];
  /** Populated for drill layers; empty array for copper / silkscreen / etc. */
  holeInstances: HoleInstance[];
}
