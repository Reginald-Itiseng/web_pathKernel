/**
 * Kernel data model.
 *
 * Coordinate convention: the kernel ALWAYS works in millimetres in Gerber
 * space (X right, Y up). The only places this convention is crossed are:
 *  - the 2D SVG overlay (which re-uses the composite Y-flip transform), and
 *  - HPGL export (normalize-to-origin, no Y flip, matching the Python kernel).
 */

export interface KPoint {
  x: number;
  y: number;
}

export type KSegment =
  | { type: 'line'; start: KPoint; end: KPoint }
  | {
      type: 'arc';
      start: KPoint;
      end: KPoint;
      center: KPoint;
      radius: number;
      ccw: boolean;
    };

export type Polarity = 'dark' | 'clear';

export type KPrimitive =
  | { type: 'circle'; cx: number; cy: number; r: number; polarity: Polarity; flashed: boolean }
  | {
      type: 'rect';
      cx: number;
      cy: number;
      w: number;
      h: number;
      /** Corner radius; 0 = sharp corners, min(w,h)/2 = obround. */
      r: number;
      polarity: Polarity;
      flashed: boolean;
    }
  | { type: 'polygon'; points: KPoint[]; polarity: Polarity; flashed: boolean }
  /** Filled region / macro outline (closed segment loop). */
  | { type: 'outline'; segments: KSegment[]; polarity: Polarity; flashed: boolean }
  /** Stroked draw (trace); width is the full stroke width. */
  | { type: 'path'; width: number; segments: KSegment[]; polarity: Polarity }
  | { type: 'drill'; cx: number; cy: number; diameter: number };

export interface LayerPrimitives {
  layerId: string;
  source: 'tracespace' | 'svg-fallback';
  primitives: KPrimitive[];
  /** [minX, minY, maxX, maxY] in mm, or null when empty. */
  bounds: [number, number, number, number] | null;
}

/** Polygon ring set with hole nesting — the lingua franca for 3D and display. */
export interface PolyWithHoles {
  outer: KPoint[];
  holes: KPoint[][];
}

export type Stroke =
  | { type: 'polyline'; points: KPoint[] }
  | { type: 'line'; start: KPoint; end: KPoint }
  | { type: 'arc'; start: KPoint; end: KPoint; center: KPoint; ccw: boolean };

export type IsoType = 'exterior' | 'interior' | 'both';
export type JoinStyle = 'round' | 'miter' | 'bevel';
export type ToolProfile = 'cylindrical' | 'conical';

export interface IsolationParams {
  toolDiameterMm: number;
  passes: number;
  /** 0..0.999 — fraction of tool overlap between passes (cylindrical). */
  overlap: number;
  isoType: IsoType;
  toolProfile: ToolProfile;
  tipDiameterMm: number;
  toolAngleDeg: number;
  cuttingDepthMm: number;
  /** Extra offset beyond the effective tool radius for the first pass. */
  traceMarginMm: number;
  /** Explicit step-over (mm); <= 0 derives automatically. */
  hatchingMarginMm: number;
  joinStyle: JoinStyle;
  /** Skip passes wider than the minimum measured copper gap. */
  skipTightClearancePaths: boolean;
  /** Reserved for phase 1.5 — extra contours around pads only. */
  extraPadContours: number;
}

export interface DrillParams {
  toolDiameterMm: number;
  /** Radial stepover as % of tool radius (1..100). */
  lateralStepoverPct: number;
  /** Drill holes smaller than the tool at tool size instead of skipping. */
  allowOversizeForSmallHoles: boolean;
}

export type CutoutCompensation = 'outside' | 'inside' | 'onpath';

export interface CutoutParams {
  toolDiameterMm: number;
  compensation: CutoutCompensation;
  holdingTabCount: number;
  holdingTabWidthMm: number;
}

export type OperationKind = 'isolation' | 'drill' | 'cutout';

export type OperationRequest =
  | { id: string; kind: 'isolation'; layerId: string; params: IsolationParams; toolNumber: number }
  | { id: string; kind: 'drill'; layerId: string; params: DrillParams; toolNumber: number }
  | { id: string; kind: 'cutout'; layerId: string; params: CutoutParams; toolNumber: number };

export interface KernelOpStats {
  pathLengthMm: number;
  strokeCount: number;
  plungeCount?: number;
  boreHoleCount?: number;
  borePassCount?: number;
  skippedSmallHoles?: number;
  oversizedHoles?: number;
  loopCount?: number;
  skippedPasses?: number;
}

export interface KernelOpResult {
  id: string;
  kind: OperationKind;
  layerId: string;
  label: string;
  toolNumber: number;
  effectiveToolDiameterMm: number;
  /** Exact geometry for export — arcs preserved. */
  strokes: Stroke[];
  /** Flattened @0.05 mm chord for 2D/3D overlays. */
  previewPolylines: KPoint[][];
  warnings: string[];
  /** Provenance parity with the Python kernel's layer metadata. */
  meta: Record<string, string>;
  stats: KernelOpStats;
}

export interface Board3DModel {
  /** Board substrate polygons (cutout domain minus drill holes). */
  boardOutline: PolyWithHoles[];
  copper: Array<{
    layerId: string;
    side: 'top' | 'bottom';
    polys: PolyWithHoles[];
  }>;
  toolpaths: Array<{
    opId: string;
    kind: OperationKind;
    side: 'top' | 'bottom';
    polylines: KPoint[][];
  }>;
  boardThicknessMm: number;
  copperThicknessMm: number;
}

/** Layer roles the kernel cares about (mirrors LayerType in utils/layerUtils). */
export type KernelLayerRole =
  | 'top-copper'
  | 'bottom-copper'
  | 'board-outline'
  | 'drill'
  | 'other';

export interface KernelJobLayer extends LayerPrimitives {
  role: KernelLayerRole;
}

/**
 * Stock (blank copper-clad panel) definition. The circuit keeps its Gerber
 * coordinates; the stock is placed around it: the circuit's bounding-box min
 * corner sits at (offsetXMm, offsetYMm) from the stock's bottom-left corner.
 */
export interface StockSettings {
  widthMm: number;
  heightMm: number;
  offsetXMm: number;
  offsetYMm: number;
}

export interface KernelJobInput {
  layers: KernelJobLayer[];
  operations: OperationRequest[];
  /** Omitted → auto stock: circuit bounds + 5 mm margin on every side. */
  stock?: StockSettings;
}

export interface KernelJobResult {
  operations: KernelOpResult[];
  board3d: Board3DModel;
  minimumCopperGapMm: number | null;
  warnings: string[];
}

export interface KernelProgress {
  stage: string;
  /** 0..1 */
  pct: number;
}
