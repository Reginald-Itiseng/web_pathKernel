/**
 * Kernel job orchestrator — worker-agnostic so it runs in vitest (node) and
 * inside the web worker identically. `initClipper()` must be awaited first
 * (runKernelJob does it defensively).
 */
import { buildBoard3DModel, resolveStockRect } from './board3d';
import { buildCenteringHoles, centeringHoleCenters, centeringMirrorAxis } from './centering';
import { initClipper } from './clip';
import { buildCopperGeometry, collectDrillHoles, minimumCopperGap } from './copper';
import { buildCutout, extractCutoutLoops, loopsToDomain } from './cutout';
import { buildDrillToolpaths } from './drilling';
import { mergeBounds, ringBounds } from './geom2d';
import { buildHatching } from './hatching';
import { buildIsolation } from './isolation';
import type {
  KernelJobInput,
  KernelJobResult,
  KernelOpResult,
  KernelProgress,
  KPoint,
  MirrorAxis,
  OperationKind,
} from './types';

export type { KernelJobInput, KernelJobResult } from './types';

/** Machining order: centering → isolation → hatching → cutout → drill. */
const OP_PRIORITY: Record<OperationKind, number> = {
  centering: 0,
  isolation: 1,
  hatching: 2,
  cutout: 3,
  drill: 4,
};

export async function runKernelJob(
  input: KernelJobInput,
  onProgress?: (progress: KernelProgress) => void,
): Promise<KernelJobResult> {
  await initClipper();
  const report = (stage: string, pct: number): void => onProgress?.({ stage, pct });

  const layersById = new Map(input.layers.map((l) => [l.layerId, l]));
  const warnings: string[] = [];

  // Copper geometry for every copper layer (needed for ops and 3D).
  report('Deriving copper geometry', 0.05);
  const copperByLayer = new Map<string, KPoint[][]>();
  for (const layer of input.layers) {
    if (layer.role !== 'top-copper' && layer.role !== 'bottom-copper') continue;
    try {
      copperByLayer.set(layer.layerId, buildCopperGeometry(layer.primitives));
    } catch (err) {
      warnings.push(`Copper derivation failed for ${layer.layerId}: ${message(err)}`);
      copperByLayer.set(layer.layerId, []);
    }
  }

  // Board bounds: real outline loops when available, else union layer bounds.
  const boardBounds = computeBoardBounds(input);

  // Board cutout domain (ring soup: outer+holes together) for hatching's
  // clear-domain constraint — undefined when there's no board-outline layer,
  // in which case buildHatching falls back to a bbox+margin domain.
  const boardOutlineLayer = input.layers.find((l) => l.role === 'board-outline');
  let boardDomainRings: KPoint[][] | undefined;
  if (boardOutlineLayer) {
    try {
      const domain = loopsToDomain(extractCutoutLoops(boardOutlineLayer.primitives));
      boardDomainRings = domain.flatMap((p) => [p.outer, ...p.holes]);
    } catch {
      // fall through — hatching uses its own bbox fallback
    }
  }

  // Mirror axis: centering op axis when one is requested, else the vertical
  // centerline of the board (common left↔right flip).
  let mirrorAxis: MirrorAxis | null = null;
  const centeringRequest = input.operations.find((op) => op.kind === 'centering');
  if (boardBounds) {
    mirrorAxis = centeringRequest
      ? centeringMirrorAxis(boardBounds, centeringRequest.params.orientation)
      : { axis: 'x', position: (boardBounds[0] + boardBounds[2]) / 2 };
  }
  if (input.operations.some((op) => op.mirror) && !centeringRequest) {
    warnings.push(
      'Mirrored toolpaths without centering holes: alignment reference is the board centerline only.',
    );
  }

  // Stable priority ordering — nothing upstream (buildOperationRequests just
  // follows the layers array) enforces a sane machining order otherwise, and
  // hatching in particular must run after isolation cuts its keepout channel.
  const orderedOperations = [...input.operations].sort(
    (a, b) => OP_PRIORITY[a.kind] - OP_PRIORITY[b.kind],
  );

  const operations: KernelOpResult[] = [];
  const total = Math.max(1, orderedOperations.length);
  for (let i = 0; i < orderedOperations.length; i++) {
    const request = orderedOperations[i];
    const layer = layersById.get(request.layerId);
    const pctBase = 0.15 + (0.65 * i) / total;
    try {
      if (!layer) throw new Error(`Layer ${request.layerId} not found.`);
      if (request.kind === 'isolation') {
        report(`Isolation: ${request.layerId}`, pctBase);
        const copper = copperByLayer.get(request.layerId) ?? buildCopperGeometry(layer.primitives);
        operations.push(
          buildIsolation({
            id: request.id,
            layerId: request.layerId,
            label: `Isolation — ${request.layerId}`,
            toolNumber: request.toolNumber,
            copper,
            primitives: layer.primitives,
            params: request.params,
          }),
        );
      } else if (request.kind === 'drill') {
        report(`Drilling: ${request.layerId}`, pctBase);
        operations.push(
          buildDrillToolpaths({
            id: request.id,
            layerId: request.layerId,
            label: `Drill — ${request.layerId}`,
            toolNumber: request.toolNumber,
            holes: collectDrillHoles(layer.primitives),
            params: request.params,
          }),
        );
      } else if (request.kind === 'centering') {
        report('Centering holes', pctBase);
        if (!boardBounds) throw new Error('No board bounds available for centering holes.');
        operations.push(
          buildCenteringHoles({
            id: request.id,
            layerId: request.layerId,
            label: 'Centering holes',
            toolNumber: request.toolNumber,
            boardBounds,
            params: request.params,
          }),
        );
      } else if (request.kind === 'hatching') {
        report(`Hatching: ${request.layerId}`, pctBase);
        const copper = copperByLayer.get(request.layerId) ?? buildCopperGeometry(layer.primitives);
        // Prior same-layer ops already pushed this run (isolation, thanks to
        // the priority sort above) — kept as an additional keepout so
        // hatching doesn't recut isolation's own channel.
        const existingToolpathPreview = operations
          .filter((op) => op.layerId === request.layerId)
          .flatMap((op) => op.previewPolylines);
        operations.push(
          buildHatching({
            id: request.id,
            layerId: request.layerId,
            label: `Hatching — ${request.layerId}`,
            toolNumber: request.toolNumber,
            copper,
            boardDomainRings,
            existingToolpathPreview,
            params: request.params,
          }),
        );
      } else {
        report(`Cutout: ${request.layerId}`, pctBase);
        operations.push(
          buildCutout({
            id: request.id,
            layerId: request.layerId,
            label: `Cutout — ${request.layerId}`,
            toolNumber: request.toolNumber,
            primitives: layer.primitives,
            params: request.params,
          }),
        );
      }

      // Mark for export-time mirroring: previews stay artwork-aligned so the
      // GUI reads cleanly; the exporter flips the strokes about the axis.
      if (request.mirror && mirrorAxis) {
        const op = operations[operations.length - 1];
        if (op && op.id === request.id) {
          op.mirror = true;
          op.meta.mirrored_at_export = `about ${mirrorAxis.axis}=${mirrorAxis.position.toFixed(4)}`;
        }
      }
    } catch (err) {
      warnings.push(`${request.kind} on ${request.layerId} failed: ${message(err)}`);
    }
  }

  // Warn when centering holes fall outside an EXPLICITLY sized stock panel
  // (auto stock grows to cover generated geometry, so it always fits).
  if (centeringRequest && boardBounds && input.stock) {
    const rect = resolveStockRect(boardBounds, input.stock);
    const holeR = Math.max(0.001, centeringRequest.params.holeDiameterMm / 2);
    const outside = centeringHoleCenters(boardBounds, centeringRequest.params).some(
      (c) =>
        c.x - holeR < rect.minX ||
        c.x + holeR > rect.minX + rect.width ||
        c.y - holeR < rect.minY ||
        c.y + holeR > rect.minY + rect.height,
    );
    if (outside) {
      warnings.push(
        'Centering holes fall outside the stock panel — increase the stock size or reduce the outline-to-hole distance.',
      );
    }
  }

  report('Building 3D model', 0.85);
  const board3d = buildBoard3DModel({
    layers: input.layers,
    opResults: operations,
    stock: input.stock,
  });

  report('Measuring copper clearance', 0.95);
  let minGap: number | null = null;
  for (const rings of copperByLayer.values()) {
    const gap = rings.length > 0 ? minimumCopperGap(rings) : null;
    if (gap != null && (minGap == null || gap < minGap)) minGap = gap;
  }

  report('Done', 1);
  return { operations, board3d, minimumCopperGapMm: minGap, mirrorAxis, warnings };
}

function computeBoardBounds(input: KernelJobInput): [number, number, number, number] | null {
  const outlineLayer = input.layers.find((l) => l.role === 'board-outline');
  if (outlineLayer) {
    try {
      const loops = extractCutoutLoops(outlineLayer.primitives);
      let out: [number, number, number, number] | null = null;
      for (const loop of loops) out = mergeBounds(out, ringBounds(loop));
      if (out) return out;
    } catch {
      // fall through to union bounds
    }
  }
  let out: [number, number, number, number] | null = null;
  for (const layer of input.layers) out = mergeBounds(out, layer.bounds);
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
