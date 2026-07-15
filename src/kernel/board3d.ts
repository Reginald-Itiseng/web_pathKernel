/**
 * Build the displayable 3D model as a MACHINING SIMULATION of copper-clad
 * stock, not a render of the Gerber artwork:
 *
 *  - Stock: user-sized blank panel (or circuit bounds + 5 mm auto margin),
 *    with the circuit positioned on it via the stock offset. Copper sheet on
 *    every side that has a copper layer loaded (single/double sided).
 *  - Isolation generated: swept tool channels are subtracted from the clad,
 *    engraving the circuit into the copper.
 *  - Drill generated: through-holes punched in clad + substrate.
 *  - Cutout generated: the cutout channel is milled THROUGH the stock
 *    (substrate + both clads); the gaps in the path are the retaining tabs
 *    that keep the board attached to the stock.
 *  - Hatching (phase 2) will subtract the cleared regions the same way.
 *
 * All material removal happens here in Clipper — the 3D view just extrudes.
 */
import { differencePolygons, polysWithHoles, sweptOpenPaths, unionPolygons } from './clip';
import { circlePoints } from './geom2d';
import { collectDrillHoles } from './copper';
import type {
  Board3DModel,
  KernelJobLayer,
  KernelOpResult,
  KPoint,
  StockSettings,
} from './types';

export const FR4_THICKNESS_MM = 1.6;
/** Real copper is ~35 µm; rendered thicker so it reads visually. */
export const COPPER_RENDER_THICKNESS_MM = 0.05;
/** Auto-stock margin around the circuit bounds (mm). */
export const AUTO_STOCK_MARGIN_MM = 5;
/** Extra clearance auto stock keeps around generated toolpath geometry (mm). */
export const AUTO_STOCK_GEOMETRY_PAD_MM = 2;

export interface Board3DInputs {
  layers: KernelJobLayer[];
  /** Completed operation results; empty for the import-time preview. */
  opResults: KernelOpResult[];
  /** Omitted → auto stock (circuit bounds + margin). */
  stock?: StockSettings;
}

/** Resolve the stock rectangle in circuit coordinates. */
export function resolveStockRect(
  circuitBounds: [number, number, number, number],
  stock?: StockSettings,
): { minX: number; minY: number; width: number; height: number } {
  const [minX, minY, maxX, maxY] = circuitBounds;
  if (!stock) {
    return {
      minX: minX - AUTO_STOCK_MARGIN_MM,
      minY: minY - AUTO_STOCK_MARGIN_MM,
      width: maxX - minX + 2 * AUTO_STOCK_MARGIN_MM,
      height: maxY - minY + 2 * AUTO_STOCK_MARGIN_MM,
    };
  }
  return {
    minX: minX - Math.max(0, stock.offsetXMm),
    minY: minY - Math.max(0, stock.offsetYMm),
    width: Math.max(1, stock.widthMm),
    height: Math.max(1, stock.heightMm),
  };
}

export function buildBoard3DModel(inputs: Board3DInputs): Board3DModel {
  const { layers, opResults, stock } = inputs;
  const roleByLayer = new Map(layers.map((l) => [l.layerId, l.role]));

  const bounds = unionBounds(layers);
  if (!bounds) {
    return {
      boardOutline: [],
      copper: [],
      toolpaths: [],
      boardThicknessMm: FR4_THICKNESS_MM,
      copperThicknessMm: COPPER_RENDER_THICKNESS_MM,
    };
  }

  let rect = resolveStockRect(bounds, stock);
  if (!stock) {
    // Auto stock grows to cover generated geometry that reaches beyond the
    // circuit — centering holes, outside-compensated cutouts, pad contours.
    let gMinX = Infinity;
    let gMinY = Infinity;
    let gMaxX = -Infinity;
    let gMaxY = -Infinity;
    for (const op of opResults) {
      const reach = op.effectiveToolDiameterMm / 2 + AUTO_STOCK_GEOMETRY_PAD_MM;
      for (const line of op.previewPolylines) {
        for (const p of line) {
          if (p.x - reach < gMinX) gMinX = p.x - reach;
          if (p.y - reach < gMinY) gMinY = p.y - reach;
          if (p.x + reach > gMaxX) gMaxX = p.x + reach;
          if (p.y + reach > gMaxY) gMaxY = p.y + reach;
        }
      }
    }
    if (Number.isFinite(gMinX)) {
      const minX = Math.min(rect.minX, gMinX);
      const minY = Math.min(rect.minY, gMinY);
      const maxX = Math.max(rect.minX + rect.width, gMaxX);
      const maxY = Math.max(rect.minY + rect.height, gMaxY);
      rect = { minX, minY, width: maxX - minX, height: maxY - minY };
    }
  }
  const stockRing: KPoint[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.minX + rect.width, y: rect.minY },
    { x: rect.minX + rect.width, y: rect.minY + rect.height },
    { x: rect.minX, y: rect.minY + rect.height },
  ];

  // Drill holes exist in the simulation only once a drill op has run.
  const drilledLayerIds = new Set(
    opResults.filter((op) => op.kind === 'drill').map((op) => op.layerId),
  );
  const drillRings: KPoint[][] = [];
  for (const layer of layers) {
    if (!drilledLayerIds.has(layer.layerId)) continue;
    for (const hole of collectDrillHoles(layer.primitives)) {
      if (hole.diameter > 0) drillRings.push(circlePoints(hole.x, hole.y, hole.diameter / 2));
    }
  }
  // Centering (registration) holes are through-holes too: recover the hole
  // centers from the ε-plunge lines and punch at the requested hole diameter.
  for (const op of opResults) {
    if (op.kind !== 'centering') continue;
    const holeDia = Math.max(
      parseFloat(op.meta.centering_hole_diameter_mm ?? '0') || 0,
      op.effectiveToolDiameterMm,
    );
    if (holeDia <= 0) continue;
    for (const stroke of op.strokes) {
      if (stroke.type !== 'line') continue;
      if (Math.hypot(stroke.end.x - stroke.start.x, stroke.end.y - stroke.start.y) > 0.01) continue;
      drillRings.push(circlePoints(stroke.start.x, stroke.start.y, holeDia / 2));
    }
  }

  const drillUnion = drillRings.length > 0 ? unionPolygons(drillRings) : [];

  // Cutout channels cut through the whole stack (substrate + both clads).
  // Tab gaps in the paths leave material — the retaining tabs.
  const cutoutChannels: KPoint[][] = [];
  for (const op of opResults) {
    if (op.kind !== 'cutout') continue;
    const radius = op.effectiveToolDiameterMm / 2;
    if (radius <= 0 || op.previewPolylines.length === 0) continue;
    cutoutChannels.push(...sweptOpenPaths(op.previewPolylines, radius));
  }

  const throughCuts = [...drillUnion, ...(cutoutChannels.length > 0 ? unionPolygons(cutoutChannels) : [])];

  // Substrate = stock − through-cuts.
  const substrateRings =
    throughCuts.length > 0 ? differencePolygons([stockRing], throughCuts) : [stockRing];

  // Copper per side: full clad, minus through-cuts, minus isolation channels.
  const copper: Board3DModel['copper'] = [];
  for (const layer of layers) {
    if (layer.role !== 'top-copper' && layer.role !== 'bottom-copper') continue;

    let clad: KPoint[][] = [stockRing];
    if (throughCuts.length > 0) {
      clad = differencePolygons(clad, throughCuts);
    }
    for (const op of opResults) {
      if (op.kind !== 'isolation' || op.layerId !== layer.layerId) continue;
      const channelRadius = op.effectiveToolDiameterMm / 2;
      if (channelRadius <= 0 || op.previewPolylines.length === 0) continue;
      const channels = sweptOpenPaths(op.previewPolylines, channelRadius);
      if (channels.length > 0) {
        clad = differencePolygons(clad, channels);
      }
    }

    copper.push({
      layerId: layer.layerId,
      side: layer.role === 'top-copper' ? 'top' : 'bottom',
      polys: polysWithHoles(clad),
    });
  }

  return {
    boardOutline: polysWithHoles(substrateRings),
    copper,
    toolpaths: opResults.map((op) => ({
      opId: op.id,
      kind: op.kind,
      side: roleByLayer.get(op.layerId) === 'bottom-copper' ? ('bottom' as const) : ('top' as const),
      polylines: op.previewPolylines,
    })),
    boardThicknessMm: FR4_THICKNESS_MM,
    copperThicknessMm: COPPER_RENDER_THICKNESS_MM,
  };
}

function unionBounds(layers: KernelJobLayer[]): [number, number, number, number] | null {
  let out: [number, number, number, number] | null = null;
  for (const layer of layers) {
    if (!layer.bounds) continue;
    if (!out) {
      out = [...layer.bounds];
    } else {
      out = [
        Math.min(out[0], layer.bounds[0]),
        Math.min(out[1], layer.bounds[1]),
        Math.max(out[2], layer.bounds[2]),
        Math.max(out[3], layer.bounds[3]),
      ];
    }
  }
  return out;
}
