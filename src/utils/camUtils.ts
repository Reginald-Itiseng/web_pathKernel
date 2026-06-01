import { computeUnionViewBox, type LayerEntry } from './gerberUtils';
import { LAYER_LABELS, layerDetectionConfidence, type LayerType } from './layerUtils';
import {
  analyzePadHoleMatches,
  DEFAULT_VALIDATION_RULES,
} from './geometryUtils';
import type {
  CamJob,
  CamOperation,
  DrillParseSettings,
  HpglExportSettings,
  ImportReport,
  PadDefinition,
  PadHoleAnalysis,
  Point2D,
  ValidationIssue,
  ValidationRuleSet,
} from '../types/geometry';

export const DEFAULT_DRILL_SETTINGS: DrillParseSettings = {
  units: 'auto',
  zeroSuppression: 'auto',
  integerDigits: 2,
  decimalDigits: 4,
  plated: 'unknown',
  scale: 1,
  offsetXmm: 0,
  offsetYmm: 0,
};

export const DEFAULT_HPGL_SETTINGS: HpglExportSettings = {
  unitsPerMm: 40,
  origin: 'board-min',
  invertY: true,
  penNumber: 1,
};

export function buildImportReport(
  file: File,
  content: string,
  layerType: LayerType,
  parserFiletype: 'gerber' | 'drill',
  result: LayerEntry['result'],
  geometry: LayerEntry['geometry'],
  drillSettings?: DrillParseSettings,
): ImportReport {
  const warnings: string[] = [];
  const confidence = layerDetectionConfidence(file.name, content, layerType);

  if (layerType === 'unknown') warnings.push('Layer role could not be inferred from filename or content.');
  if (confidence !== 'high') warnings.push(`Layer detection confidence is ${confidence}.`);
  if (parserFiletype === 'drill' && !result.units) warnings.push('Drill units were not explicit; fallback units were used.');
  if (result.viewBox && Math.max(result.viewBox[2], result.viewBox[3]) <= 0) warnings.push('Parsed layer has an empty viewBox.');
  // Complex aperture notice is reported as a validation issue (one summary per layer),
  // so no need to repeat it as an import warning.

  return {
    filename: file.name,
    detectedType: layerType,
    confidence,
    parserFiletype,
    units: result.units,
    viewBox: result.viewBox,
    warnings,
    drillSettings: parserFiletype === 'drill' ? (drillSettings ?? DEFAULT_DRILL_SETTINGS) : undefined,
    geometryCounts: {
      padTypes: geometry?.padDefs.length ?? 0,
      padInstances: geometry?.padInstances.length ?? 0,
      traceClasses: geometry?.traceClasses.length ?? 0,
      holes: geometry?.holeInstances.length ?? 0,
    },
  };
}

export function buildCamJob(
  layers: LayerEntry[],
  rules: ValidationRuleSet = DEFAULT_VALIDATION_RULES,
): CamJob {
  const boardBounds = computeUnionViewBox(layers.map((l) => l.result));
  const padHoleAnalysis = analyzePadHoleMatches(layers, rules);
  const validationIssues = validateLayers(layers, padHoleAnalysis, rules);
  const operations = buildCamOperations(layers);

  return {
    layers,
    boardBounds,
    importReports: layers.map((l) => l.importReport),
    padHoleAnalysis,
    validationIssues,
    operations,
  };
}

function validateLayers(
  layers: LayerEntry[],
  analysis: PadHoleAnalysis,
  rules: ValidationRuleSet,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const layer of layers) {
    for (const warning of layer.importReport.warnings) {
      issues.push({
        id: `${layer.id}:import:${warning}`,
        severity: layer.importReport.confidence === 'low' ? 'warning' : 'info',
        title: `${layer.file.name}: import notice`,
        detail: warning,
        layerId: layer.id,
      });
    }

    // Trace-width check only applies to copper — board outlines, silkscreens, etc.
    // have "traces" that are not electrical and should not trigger this warning.
    const isCopper = layer.layerType === 'top-copper' || layer.layerType === 'bottom-copper';
    if (isCopper) {
      for (const tc of layer.geometry?.traceClasses ?? []) {
        if (tc.widthMm < rules.minTraceWidthMm) {
          issues.push({
            id: `${layer.id}:trace:${tc.strokeWidthRaw}`,
            severity: 'warning',
            title: 'Trace below milling minimum',
            detail: `${LAYER_LABELS[layer.layerType]} has ${tc.instanceCount} trace(s) at ${tc.widthMm.toFixed(3)} mm — below ${rules.minTraceWidthMm.toFixed(3)} mm tool minimum.`,
            layerId: layer.id,
          });
        }
      }
    }

    for (const hole of layer.geometry?.holeInstances ?? []) {
      if (hole.diameterMm < rules.minDrillMm) {
        issues.push({
          id: `${hole.instanceId}:min-drill`,
          severity: 'warning',
          title: 'Drill below minimum',
          detail: `Hole diameter ${hole.diameterMm.toFixed(3)} mm is below ${rules.minDrillMm.toFixed(3)} mm.`,
          layerId: hole.layerId,
          featureId: hole.featureId,
        });
      }
    }

    // One summary per layer, not one message per aperture definition.
    const complexDefs = (layer.geometry?.padDefs ?? []).filter(
      (d) => d.shape === 'complex' || d.shape === 'polygon',
    );
    if (complexDefs.length > 0) {
      const codes = complexDefs.map((d) => d.toolCode).join(', ');
      issues.push({
        id: `${layer.id}:macros`,
        severity: 'info',
        title: 'Complex apertures not directly editable',
        detail: `${layer.file.name} has ${complexDefs.length} complex/polygon aperture(s) (${codes}). Previewed correctly but cannot be resized in V1.`,
        layerId: layer.id,
      });
    }
  }

  if (!layers.some((l) => l.layerType === 'board-outline')) {
    issues.push({
      id: 'outline:missing',
      severity: 'warning',
      title: 'Board outline missing',
      detail: 'No board-outline layer was detected, so outline HPGL output will be empty.',
    });
  }

  // Only meaningful when a drill file is present. Without one, every copper pad
  // is "unmatched" which is noise, not signal. When a drill file IS loaded,
  // unmatched pads are likely SMD — collapse to a single summary instead of
  // one message per pad.
  const hasDrillLayer = layers.some((l) => l.layerType === 'drill');
  if (hasDrillLayer && analysis.unmatchedPads.length > 0) {
    issues.push({
      id: 'unmatched-pads:summary',
      severity: 'info',
      title: `${analysis.unmatchedPads.length} copper pad(s) have no matched drill hole`,
      detail: `These are likely SMD pads. If any are PTH, check that the correct drill file is loaded (tolerance: ${rules.matchToleranceMm.toFixed(3)} mm).`,
    });
  }

  for (const hole of analysis.unmatchedHoles) {
    issues.push({
      id: `${hole.instanceId}:unmatched-hole`,
      severity: 'warning',
      title: 'Drill hole has no matched copper pad',
      detail: `Hole at ${hole.xMm.toFixed(3)}, ${hole.yMm.toFixed(3)} mm has no copper pad within tolerance.`,
      layerId: hole.layerId,
      featureId: hole.featureId,
    });
  }

  for (const match of analysis.ambiguousMatches) {
    issues.push({
      id: `${match.hole.instanceId}:${match.pad.instanceId}:ambiguous`,
      severity: 'warning',
      title: 'Ambiguous pad-hole match',
      detail: `Hole matches multiple pads near ${match.hole.xMm.toFixed(3)}, ${match.hole.yMm.toFixed(3)} mm.`,
      layerId: match.hole.layerId,
      featureId: match.hole.featureId,
    });
  }

  for (const match of analysis.annularWarnings) {
    issues.push({
      id: `${match.hole.instanceId}:${match.pad.instanceId}:annular`,
      severity: 'warning',
      title: 'Annular ring below minimum',
      detail: `Ring is ${match.annularRingMm?.toFixed(3)} mm; minimum is ${rules.minAnnularRingMm.toFixed(3)} mm.`,
      layerId: match.pad.layerId,
      featureId: match.pad.featureId,
    });
  }

  return issues;
}

export function buildCamOperations(layers: LayerEntry[]): CamOperation[] {
  const operations: CamOperation[] = [];

  for (const layer of layers) {
    if (layer.layerType === 'drill') {
      const paths = (layer.geometry?.holeInstances ?? []).map((hole) => drillMarkPath(hole.xMm, hole.yMm, hole.diameterMm));
      if (paths.length) {
        operations.push({ id: `${layer.id}:drills`, type: 'drill', layerId: layer.id, label: `${layer.file.name} drill marks`, paths });
      }
    }

    if (layer.layerType === 'top-copper' || layer.layerType === 'bottom-copper') {
      const paths = extractPathPolylines(layer.result.svgString, layer.result.units);
      if (paths.length) {
        operations.push({ id: `${layer.id}:isolation`, type: 'isolation', layerId: layer.id, label: `${layer.file.name} copper center paths`, paths });
      }
    }

    if (layer.layerType === 'board-outline') {
      const paths = extractPathPolylines(layer.result.svgString, layer.result.units);
      if (paths.length) {
        operations.push({ id: `${layer.id}:outline`, type: 'outline', layerId: layer.id, label: `${layer.file.name} outline`, paths });
      }
    }
  }

  return operations;
}

export function exportHpgl(
  operations: CamOperation[],
  bounds: [number, number, number, number] | null,
  settings: HpglExportSettings = DEFAULT_HPGL_SETTINGS,
): string {
  const [minX, minY, , heightRaw] = bounds ?? [0, 0, 0, 0];
  const heightMm = heightRaw / 1000;
  const lines = ['IN;', `SP${settings.penNumber};`, 'PA;'];

  for (const operation of operations) {
    lines.push(`; ${operation.type.toUpperCase()} ${operation.label}`);
    for (const path of operation.paths) {
      const points = path.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!points.length) continue;
      const first = toHpglPoint(points[0], minX / 1000, minY / 1000, heightMm, settings);
      lines.push(`PU${first.x},${first.y};`);
      if (points.length > 1) {
        const rest = points.map((p) => toHpglPoint(p, minX / 1000, minY / 1000, heightMm, settings));
        lines.push(`PD${rest.map((p) => `${p.x},${p.y}`).join(',')};`);
      }
      lines.push('PU;');
    }
  }

  lines.push('SP0;');
  return lines.join('\n');
}

function drillMarkPath(x: number, y: number, diameter: number): Point2D[] {
  const r = Math.max(diameter * 0.2, 0.05);
  return [
    { x: x - r, y },
    { x: x + r, y },
    { x, y },
    { x, y: y - r },
    { x, y: y + r },
  ];
}

function extractPathPolylines(svgString: string, units: string | null): Point2D[][] {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const scale = units === 'in' ? 25.4 : 1;
  return Array.from(doc.querySelectorAll('path'))
    .map((path) => parseSimplePath(path.getAttribute('d') ?? '', scale))
    .filter((path) => path.length > 1);
}

function parseSimplePath(d: string, scale: number): Point2D[] {
  const tokens = d.match(/[MmLlHhVvZz]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const points: Point2D[] = [];
  let i = 0;
  let cmd = '';
  let current = { x: 0, y: 0 };

  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;

    if (cmd === 'M' || cmd === 'L') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      current = { x: (x / 1000) * scale, y: (y / 1000) * scale };
      points.push(current);
    } else if (cmd === 'm' || cmd === 'l') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      current = { x: current.x + (x / 1000) * scale, y: current.y + (y / 1000) * scale };
      points.push(current);
    } else if (cmd === 'H') {
      current = { ...current, x: (Number(tokens[i++]) / 1000) * scale };
      points.push(current);
    } else if (cmd === 'V') {
      current = { ...current, y: (Number(tokens[i++]) / 1000) * scale };
      points.push(current);
    } else if (cmd === 'Z' || cmd === 'z') {
      if (points[0]) points.push(points[0]);
    } else {
      i++;
    }
  }

  return points;
}

function toHpglPoint(
  point: Point2D,
  minX: number,
  minY: number,
  heightMm: number,
  settings: HpglExportSettings,
): { x: number; y: number } {
  const xMm = settings.origin === 'board-min' ? point.x - minX : point.x;
  const yBase = settings.origin === 'board-min' ? point.y - minY : point.y;
  const yMm = settings.invertY ? heightMm - yBase : yBase;
  return {
    x: Math.round(xMm * settings.unitsPerMm),
    y: Math.round(yMm * settings.unitsPerMm),
  };
}

export function padDisplayDiameter(def: PadDefinition): number | null {
  return def.diameterMm ?? (def.widthMm != null ? Math.max(def.widthMm, def.heightMm ?? 0) : null);
}
