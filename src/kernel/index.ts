/**
 * Kernel job orchestrator — worker-agnostic so it runs in vitest (node) and
 * inside the web worker identically. `initClipper()` must be awaited first
 * (runKernelJob does it defensively).
 */
import { buildBoard3DModel } from './board3d';
import { initClipper } from './clip';
import { buildCopperGeometry, collectDrillHoles, minimumCopperGap } from './copper';
import { buildCutout } from './cutout';
import { buildDrillToolpaths } from './drilling';
import { buildIsolation } from './isolation';
import type {
  KernelJobInput,
  KernelJobResult,
  KernelOpResult,
  KernelProgress,
  KPoint,
} from './types';

export type { KernelJobInput, KernelJobResult } from './types';

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

  const operations: KernelOpResult[] = [];
  const total = Math.max(1, input.operations.length);
  for (let i = 0; i < input.operations.length; i++) {
    const request = input.operations[i];
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
    } catch (err) {
      warnings.push(`${request.kind} on ${request.layerId} failed: ${message(err)}`);
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
  return { operations, board3d, minimumCopperGapMm: minGap, warnings };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
