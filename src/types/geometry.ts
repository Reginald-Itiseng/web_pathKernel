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
  instanceId: string;
  featureId: string;
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
  pathIds: string[];
}

/** One drill hole instance extracted from a drill layer. */
export interface HoleInstance {
  instanceId: string;
  featureId: string;
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
  annularRingMm: number | null;
  status: 'matched' | 'ambiguous' | 'diameter-warning';
}

export interface PadHoleAnalysis {
  matches: PadHoleMatch[];
  ambiguousMatches: PadHoleMatch[];
  unmatchedPads: PadInstance[];
  unmatchedHoles: HoleInstance[];
  annularWarnings: PadHoleMatch[];
}

export type GeometryHighlightTarget =
  | {
      type: 'pad-def';
      layerId: string;
      defId: string;
    }
  | {
      type: 'trace-width';
      layerId: string;
      strokeWidthRaw: number;
    }
  | {
      type: 'pad-instance';
      layerId: string;
      instanceId: string;
    };

export interface LayerGeometry {
  layerId: string;
  padDefs: PadDefinition[];
  padInstances: PadInstance[];
  traceClasses: TraceClass[];
  /** Populated for drill layers; empty array for copper / silkscreen / etc. */
  holeInstances: HoleInstance[];
}

export interface DrillParseSettings {
  units: 'auto' | 'mm' | 'in';
  zeroSuppression: 'auto' | 'leading' | 'trailing';
  integerDigits: number;
  decimalDigits: number;
  plated: 'unknown' | 'plated' | 'non-plated';
  scale: number;
  offsetXmm: number;
  offsetYmm: number;
}

export interface ImportReport {
  filename: string;
  detectedType: import('../utils/layerUtils').LayerType;
  confidence: 'high' | 'medium' | 'low';
  parserFiletype: 'gerber' | 'drill';
  units: string | null;
  viewBox: number[] | null;
  warnings: string[];
  geometryCounts: {
    padTypes: number;
    padInstances: number;
    traceClasses: number;
    holes: number;
  };
  drillSettings?: DrillParseSettings;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  title: string;
  detail: string;
  layerId?: string;
  featureId?: string;
}

export interface ValidationRuleSet {
  minTraceWidthMm: number;
  minDrillMm: number;
  minAnnularRingMm: number;
  minIsolationMm: number;
  matchToleranceMm: number;
  outlineClosureToleranceMm: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface CamOperation {
  id: string;
  type: 'isolation' | 'drill' | 'outline';
  layerId: string;
  label: string;
  paths: Point2D[][];
}

export interface HpglExportSettings {
  unitsPerMm: number;
  origin: 'board-min' | 'absolute';
  invertY: boolean;
  penNumber: number;
}

export interface CamJob {
  layers: import('../utils/gerberUtils').LayerEntry[];
  boardBounds: [number, number, number, number] | null;
  importReports: ImportReport[];
  padHoleAnalysis: PadHoleAnalysis;
  validationIssues: ValidationIssue[];
  operations: CamOperation[];
}
