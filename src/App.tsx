import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExportModal, type ExportFile, type ExportFormatOption } from './components/ExportModal';
import { GerberDropzone } from './components/GerberDropzone';
import { GerberPreview } from './components/GerberPreview';
import { LayerInfo } from './components/LayerInfo';
import { ToastStack, type Toast } from './components/ToastStack';
import { ValidationBadge } from './components/ValidationBadge';
import {
  buildOperationRequests,
  CENTERING_KEY,
  DEFAULT_STOCK_CONFIG,
  hatchingKeyFor,
  layerIdForConfigKey,
  opIdFor,
  resolveStockSettings,
  seedOpConfigs,
  type OpConfig,
  type OpConfigMap,
  type StockConfig,
} from './components/cam/CamWorkflowPanel';
import { AUTO_STOCK_MARGIN_MM } from './kernel/board3d';
import { parseGerber, type LayerEntry } from './utils/gerberUtils';
import { LAYER_COLORS, detectLayerType } from './utils/layerUtils';
import { buildCamJob, buildImportReport, DEFAULT_DRILL_SETTINGS } from './utils/camUtils';
import {
  buildKernelLayers,
  editKernelHoleDiameter,
  editKernelPadSize,
  editKernelSinglePadSize,
  editKernelSingleTraceWidth,
  editKernelTraceWidth,
  ingestLayerPrimitives,
} from './utils/kernelBridge';
import { runKernelJobInWorker } from './workers/kernelClient';
import { exportHpgl } from './kernel/hpgl';
import type { Board3DModel, KernelJobResult, KernelProgress, LayerPrimitives } from './kernel/types';
import {
  addPathIds,
  editHoleDiameter,
  editPadSize,
  editSinglePadSize,
  editSingleTraceWidth,
  editTraceWidth,
  extractLayerGeometry,
} from './utils/geometryUtils';
import type { DrillParseSettings, GeometryHighlightTarget } from './types/geometry';

interface ParseError {
  filename: string;
  message: string;
}

interface AppState {
  layers: LayerEntry[];
  parsing: boolean;
  errors: ParseError[];
  past: LayerEntry[][];
  future: LayerEntry[][];
}

const INITIAL: AppState = { layers: [], parsing: false, errors: [], past: [], future: [] };

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);
  const [geometryHighlight, setGeometryHighlight] = useState<GeometryHighlightTarget | null>(null);
  const [soloLayerId, setSoloLayerId] = useState<string | null>(null);

  // ── CAM kernel state ───────────────────────────────────────────────────────
  const [opConfigs, setOpConfigs] = useState<OpConfigMap>({});
  const [stockConfig, setStockConfig] = useState<StockConfig>(DEFAULT_STOCK_CONFIG);
  const [camResult, setCamResult] = useState<KernelJobResult | null>(null);
  const [camStale, setCamStale] = useState(false);
  const [kernelBusy, setKernelBusy] = useState<KernelProgress | null>(null);
  const [boardModel, setBoardModel] = useState<Board3DModel | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(1);

  const pushToast = useCallback((tone: Toast['tone'], message: string) => {
    setToasts((prev) => [...prev.slice(-4), { id: toastIdRef.current++, tone, message }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const commitLayers = useCallback((updater: (layers: LayerEntry[]) => LayerEntry[]) => {
    setState((s) => ({
      ...s,
      layers: updater(s.layers),
      past: [...s.past, s.layers],
      future: [],
    }));
    setCamStale(true);
  }, []);

  const createLayer = useCallback(async (file: File, content: string): Promise<LayerEntry> => {
    const layerType = detectLayerType(file.name, content);
    const parserFiletype = layerType === 'drill' ? 'drill' : 'gerber';
    const color = LAYER_COLORS[layerType];
    const drillSettings = parserFiletype === 'drill' ? DEFAULT_DRILL_SETTINGS : undefined;
    const result = await parseGerber(content, color, parserFiletype);
    const id = crypto.randomUUID();
    const svgString = addPathIds(result.svgString, id);
    const enriched = { ...result, svgString };
    const geometry = extractLayerGeometry(svgString, id, layerType, result.units);
    const importReport = buildImportReport(file, content, layerType, parserFiletype, enriched, geometry, drillSettings);

    const ingest = ingestLayerPrimitives(content, id, layerType, geometry, svgString, result.units);
    importReport.warnings.push(...ingest.warnings);

    return {
      id,
      file,
      sourceContent: content,
      result: enriched,
      layerType,
      color,
      visible: true,
      geometry,
      importReport,
      drillSettings,
      primitives: ingest.primitives,
    };
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    setState((s) => ({ ...s, parsing: true }));
    const newLayers: LayerEntry[] = [];
    const newErrors: ParseError[] = [];

    for (const file of files) {
      // .gbrjob is a KiCad job manifest (JSON), not a Gerber file — skip it.
      if (file.name.toLowerCase().endsWith('.gbrjob')) continue;

      try {
        newLayers.push(await createLayer(file, await readFileAsText(file)));
      } catch (err) {
        newErrors.push({
          filename: file.name,
          message: err instanceof Error ? err.message : 'Parse failed',
        });
      }
    }

    setState((s) => ({
      ...s,
      layers: [...s.layers, ...newLayers],
      parsing: false,
      errors: [...s.errors, ...newErrors],
      past: newLayers.length ? [...s.past, s.layers] : s.past,
      future: newLayers.length ? [] : s.future,
    }));
    if (newLayers.length) setCamStale(true);
  }, [createLayer]);

  const rebuildEditedLayer = useCallback((
    layer: LayerEntry,
    svgString: string,
    editPrimitives?: (
      primitives: LayerPrimitives | undefined,
      geometry: ReturnType<typeof extractLayerGeometry>,
    ) => LayerPrimitives | undefined,
  ): LayerEntry => {
    const result = { ...layer.result, svgString };
    const geometry = extractLayerGeometry(svgString, layer.id, layer.layerType, layer.result.units);
    const importReport = buildImportReport(
      layer.file,
      layer.sourceContent,
      layer.layerType,
      layer.layerType === 'drill' ? 'drill' : 'gerber',
      result,
      geometry,
      layer.drillSettings,
    );
    // Kernel primitives are re-derived from the SAME edit, correlated back
    // by position/width class (kernelBridge.ts editKernel*) — not re-parsed
    // from the original file, which would silently discard the edit.
    const primitives = editPrimitives ? editPrimitives(layer.primitives, geometry) : layer.primitives;
    return { ...layer, result, geometry, importReport, primitives };
  }, []);

  const toggleLayer = useCallback((id: string) => {
    // Visibility only affects the preview — not CAM state.
    setState((s) => ({
      ...s,
      layers: s.layers.map((l) => l.id === id ? { ...l, visible: !l.visible } : l),
    }));
  }, []);

  const removeLayer = useCallback((id: string) => {
    commitLayers((layers) => layers.filter((l) => l.id !== id));
  }, [commitLayers]);

  const dismissError = useCallback((filename: string) => {
    setState((s) => ({ ...s, errors: s.errors.filter((e) => e.filename !== filename) }));
  }, []);

  const clearAll = useCallback(() => {
    setState((s) => ({
      ...INITIAL,
      past: s.layers.length ? [...s.past, s.layers] : s.past,
    }));
    setCamResult(null);
    setBoardModel(null);
    setOpConfigs({});
    setCamStale(false);
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const previous = s.past[s.past.length - 1];
      if (!previous) return s;
      return { ...s, layers: previous, past: s.past.slice(0, -1), future: [s.layers, ...s.future] };
    });
    setCamStale(true);
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const next = s.future[0];
      if (!next) return s;
      return { ...s, layers: next, past: [...s.past, s.layers], future: s.future.slice(1) };
    });
    setCamStale(true);
  }, []);

  const updatePadSize = useCallback((layerId: string, defId: string, newDiameterMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId
        ? rebuildEditedLayer(
            l,
            editPadSize(l.result.svgString, defId, newDiameterMm, l.result.units),
            (primitives, geometry) => editKernelPadSize(primitives, geometry, defId, newDiameterMm),
          )
        : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateTraceWidth = useCallback((layerId: string, oldRaw: number, newWidthMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId
        ? rebuildEditedLayer(
            l,
            editTraceWidth(l.result.svgString, oldRaw, newWidthMm, l.result.units),
            (primitives) => {
              const scale = l.result.units === 'in' ? 25.4 : 1;
              const oldWidthMm = (oldRaw / 1000) * scale;
              return editKernelTraceWidth(primitives, oldWidthMm, newWidthMm);
            },
          )
        : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateSinglePadSize = useCallback((layerId: string, defId: string, instanceId: string, newDiameterMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId
        ? rebuildEditedLayer(
            l,
            editSinglePadSize(l.result.svgString, defId, instanceId, newDiameterMm, l.result.units),
            (primitives, geometry) => editKernelSinglePadSize(primitives, geometry, instanceId, newDiameterMm),
          )
        : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateSingleTrace = useCallback((layerId: string, pathId: string, newWidthMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId
        ? rebuildEditedLayer(
            l,
            editSingleTraceWidth(l.result.svgString, pathId, newWidthMm, l.result.units),
            (primitives) => editKernelSingleTraceWidth(primitives, l.result.svgString, pathId, newWidthMm, l.result.units),
          )
        : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateHoleDiameter = useCallback((layerId: string, defId: string, newDiameterMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId
        ? rebuildEditedLayer(
            l,
            editHoleDiameter(l.result.svgString, defId, newDiameterMm, l.result.units),
            (primitives, geometry) => editKernelHoleDiameter(primitives, geometry, defId, newDiameterMm),
          )
        : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateDrillSettings = useCallback(async (layerId: string, settings: DrillParseSettings) => {
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer) return;

    try {
      const backupUnits = settings.units === 'in' ? 'in' : 'mm';
      const result = await parseGerber(layer.sourceContent, layer.color, 'drill', { backupUnits });
      const svgString = addPathIds(result.svgString, layer.id);
      const enriched = { ...result, svgString };
      const geometry = extractLayerGeometry(svgString, layer.id, layer.layerType, result.units);
      const importReport = buildImportReport(layer.file, layer.sourceContent, layer.layerType, 'drill', enriched, geometry, settings);
      const ingest = ingestLayerPrimitives(layer.sourceContent, layer.id, layer.layerType, geometry, svgString, result.units);
      importReport.warnings.push(...ingest.warnings);
      commitLayers((layers) => layers.map((l) => l.id === layerId
        ? { ...l, result: enriched, geometry, importReport, drillSettings: settings, primitives: ingest.primitives }
        : l));
    } catch (err) {
      setState((s) => ({
        ...s,
        errors: [...s.errors, { filename: layer.file.name, message: err instanceof Error ? err.message : 'Drill reparse failed' }],
      }));
    }
  }, [commitLayers, state.layers]);

  const camJob = useMemo(() => buildCamJob(state.layers), [state.layers]);

  // ── Kernel wiring ──────────────────────────────────────────────────────────

  // Keep op configs seeded for CAM-relevant layers.
  useEffect(() => {
    setOpConfigs((prev) => seedOpConfigs(state.layers, prev));
  }, [state.layers]);

  const setOpConfig = useCallback((key: string, config: OpConfig) => {
    setOpConfigs((prev) => {
      const next = { ...prev, [key]: config };
      // Enabling centering implies a double-sided flip workflow: default the
      // bottom-copper isolation to mirrored so previews match the machine.
      if (key === CENTERING_KEY && config.enabled && !prev[CENTERING_KEY]?.enabled) {
        for (const layer of state.layers) {
          const c = next[layer.id];
          if (layer.layerType === 'bottom-copper' && c?.kind === 'isolation' && !c.mirror) {
            next[layer.id] = { ...c, mirror: true };
          }
          const hatchKey = hatchingKeyFor(layer.id);
          const hc = next[hatchKey];
          if (layer.layerType === 'bottom-copper' && hc?.kind === 'hatching' && !hc.mirror) {
            next[hatchKey] = { ...hc, mirror: true };
          }
        }
      }
      return next;
    });
    setCamStale(true);
  }, [state.layers]);

  // Toolpath overlays hidden via each operation card's eye toggle; solo mode
  // additionally scopes overlays to the soloed layer's own operations.
  const hiddenOpIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const [key, config] of Object.entries(opConfigs)) {
      // opIdFor expects the real layer id, not hatching's compound map key
      // (`hatching:${layerId}`) — see hatchingKeyFor/layerIdForConfigKey.
      if (!config.overlayVisible) hidden.add(opIdFor(layerIdForConfigKey(key), config));
    }
    if (soloLayerId && camResult) {
      for (const op of camResult.operations) {
        if (op.layerId !== soloLayerId) hidden.add(op.id);
      }
    }
    return hidden;
  }, [opConfigs, soloLayerId, camResult]);

  const toggleSolo = useCallback((layerId: string) => {
    setSoloLayerId((prev) => (prev === layerId ? null : layerId));
  }, []);

  const updateStockConfig = useCallback((next: StockConfig) => {
    setStockConfig(next);
    setCamStale(true);
  }, []);

  const circuitSizeMm = useMemo(() => {
    if (!camJob.boardBounds) return null;
    return { width: camJob.boardBounds[2] / 1000, height: camJob.boardBounds[3] / 1000 };
  }, [camJob.boardBounds]);

  // Actual stock panel size from the 3D model (auto stock grows to cover
  // generated geometry like centering holes).
  const actualStockSizeMm = useMemo(() => {
    const outer = boardModel?.boardOutline[0]?.outer;
    if (!outer || outer.length < 3) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { width: maxX - minX, height: maxY - minY };
  }, [boardModel]);

  // Import-time 3D preview: run a no-operations job so the 3D tab shows real
  // copper on the real board outline before any toolpaths are generated.
  const layerPrimitivesKey = useMemo(
    () => state.layers.map((l) => `${l.id}:${l.primitives ? l.primitives.primitives.length : 0}`).join('|'),
    [state.layers],
  );
  useEffect(() => {
    const kernelLayers = buildKernelLayers(state.layers);
    if (kernelLayers.length === 0) {
      setBoardModel(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      runKernelJobInWorker({
        layers: kernelLayers,
        operations: [],
        stock: resolveStockSettings(stockConfig),
      })
        .then((result) => {
          if (!cancelled) setBoardModel(result.board3d);
        })
        .catch(() => {
          /* preview only — generation reports real errors */
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerPrimitivesKey, stockConfig]);

  const generateToolpaths = useCallback(async () => {
    const kernelLayers = buildKernelLayers(state.layers);
    const operations = buildOperationRequests(state.layers, opConfigs);
    if (kernelLayers.length === 0 || operations.length === 0) {
      pushToast('warn', 'No CAM-capable layers/operations available to generate.');
      return;
    }
    if (!stockConfig.auto && circuitSizeMm) {
      const fitsX = circuitSizeMm.width + stockConfig.offsetXMm <= stockConfig.widthMm + 1e-9;
      const fitsY = circuitSizeMm.height + stockConfig.offsetYMm <= stockConfig.heightMm + 1e-9;
      if (!fitsX || !fitsY) {
        pushToast('warn', 'Circuit does not fit on the configured stock at this offset — adjust the stock settings.');
      }
    }
    setKernelBusy({ stage: 'Starting', pct: 0 });
    try {
      const result = await runKernelJobInWorker(
        { layers: kernelLayers, operations, stock: resolveStockSettings(stockConfig) },
        (progress) => setKernelBusy(progress),
      );
      setCamResult(result);
      setBoardModel(result.board3d);
      setCamStale(false);
      const allWarnings = [
        ...result.warnings,
        ...result.operations.flatMap((op) => op.warnings.map((w) => `${op.label}: ${w}`)),
      ];
      for (const warning of allWarnings.slice(0, 5)) pushToast('warn', warning);
      if (allWarnings.length === 0) {
        pushToast('info', `Generated ${result.operations.length} toolpath operation(s).`);
      }
    } catch (err) {
      pushToast('error', `Toolpath generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKernelBusy(null);
    }
  }, [state.layers, opConfigs, stockConfig, circuitSizeMm, pushToast]);

  // Generate ONLY the centering holes (workflow step 1) — drilled first so
  // the stock can be pinned before any side is machined.
  const generateCentering = useCallback(async () => {
    const kernelLayers = buildKernelLayers(state.layers);
    if (kernelLayers.length === 0) return;
    // Enable centering so subsequent full generates keep including it.
    const centering = opConfigs[CENTERING_KEY];
    if (!centering) return;
    const enabledConfigs: OpConfigMap = {
      ...opConfigs,
      [CENTERING_KEY]: { ...centering, enabled: true } as OpConfig,
    };
    // Pin registration implies a flip workflow — default bottom isolation to
    // mirrored-at-export (user can untick it in the bottom layer settings).
    if (!centering.enabled) {
      for (const layer of state.layers) {
        const c = enabledConfigs[layer.id];
        if (layer.layerType === 'bottom-copper' && c?.kind === 'isolation' && !c.mirror) {
          enabledConfigs[layer.id] = { ...c, mirror: true };
        }
        const hatchKey = hatchingKeyFor(layer.id);
        const hc = enabledConfigs[hatchKey];
        if (layer.layerType === 'bottom-copper' && hc?.kind === 'hatching' && !hc.mirror) {
          enabledConfigs[hatchKey] = { ...hc, mirror: true };
        }
      }
    }
    setOpConfigs(enabledConfigs);
    const centeringOnly = buildOperationRequests(state.layers, enabledConfigs).filter(
      (op) => op.kind === 'centering',
    );
    if (centeringOnly.length === 0) {
      pushToast('warn', 'No centering operation could be built.');
      return;
    }
    setKernelBusy({ stage: 'Centering holes', pct: 0 });
    try {
      const result = await runKernelJobInWorker(
        { layers: kernelLayers, operations: centeringOnly, stock: resolveStockSettings(stockConfig) },
        (progress) => setKernelBusy(progress),
      );
      setCamResult(result);
      setBoardModel(result.board3d);
      setCamStale(false);
      for (const warning of result.warnings.slice(0, 3)) pushToast('warn', warning);
      pushToast('info', 'Centering holes generated — drill these first, then pin and machine.');
    } catch (err) {
      pushToast('error', `Centering generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKernelBusy(null);
    }
  }, [state.layers, opConfigs, stockConfig, pushToast]);

  // Pure builder — one file per operation, numbered in machining order.
  // The Export modal owns packaging (zip) and download; this only decides
  // WHAT the files are, so it stays reusable if formats besides HPGL need
  // the same op-ordering logic later.
  const buildHpglExportFiles = useCallback((): ExportFile[] => {
    if (!camResult || camResult.operations.length === 0) return [];
    // Machine origin = stock bottom-left corner (circuit coords minus the
    // configured placement offset).
    const offsetX = stockConfig.auto ? AUTO_STOCK_MARGIN_MM : stockConfig.offsetXMm;
    const offsetY = stockConfig.auto ? AUTO_STOCK_MARGIN_MM : stockConfig.offsetYMm;
    const circuitMin = camJob.boardBounds
      ? { x: camJob.boardBounds[0] / 1000, y: camJob.boardBounds[1] / 1000 }
      : { x: 0, y: 0 };
    const exportOpts = {
      absoluteOriginMm: { x: circuitMin.x - offsetX, y: circuitMin.y - offsetY },
      mirrorAxis: camResult.mirrorAxis,
    };

    const layerTypeById = new Map(state.layers.map((l) => [l.id, l.layerType]));
    const layerFileById = new Map(state.layers.map((l) => [l.id, l.file.name]));
    const orderOf = (op: (typeof camResult.operations)[number]): number => {
      if (op.kind === 'centering') return 0;
      const bottom = layerTypeById.get(op.layerId) === 'bottom-copper';
      if (op.kind === 'isolation') return bottom ? 2 : 1;
      // Right after isolation for the same side, ahead of drill/cutout.
      if (op.kind === 'hatching') return bottom ? 4 : 3;
      return op.kind === 'drill' ? 5 : 6;
    };
    const ordered = [...camResult.operations].sort((a, b) => orderOf(a) - orderOf(b));

    return ordered.map((op, i) => {
      const { text } = exportHpgl([op], exportOpts);
      const base =
        op.kind === 'centering'
          ? 'centering'
          : `${op.kind}-${sanitizeName(layerFileById.get(op.layerId) ?? op.layerId)}`;
      const name = `${String(i + 1).padStart(2, '0')}-${base}${op.mirror ? '-mirrored' : ''}.plt`;
      return { name, content: text };
    });
  }, [camResult, stockConfig, camJob.boardBounds, state.layers]);

  const exportProjectName = useMemo(
    () => sanitizeName(deriveProjectName(state.layers.map((l) => l.file.name))),
    [state.layers],
  );

  // Format list for the Export modal. Only HPGL is implemented today —
  // adding G-code (or anything else) later is just another entry here with
  // its own buildFiles; formats without one render disabled ("coming soon").
  const exportFormats: ExportFormatOption[] = useMemo(
    () => [
      {
        id: 'hpgl',
        label: 'HPGL / PLT',
        extension: 'plt',
        description: 'Bungard-compatible HPGL2 — one file per operation, in machining order.',
        buildFiles: buildHpglExportFiles,
      },
      {
        id: 'gcode',
        label: 'G-code',
        extension: 'nc',
        description: 'Not implemented yet.',
      },
    ],
    [buildHpglExportFiles],
  );

  const { layers, parsing, errors } = state;
  const hasLayers = layers.length > 0 || parsing || errors.length > 0;

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-200">
      <header className="shrink-0 flex items-center gap-3 px-5 h-16 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-2.5">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Path Kernel" className="h-12 w-auto object-contain shrink-0" />
          <span className="font-semibold text-zinc-100 tracking-tight text-lg">Path Kernel</span>
        </div>
        {hasLayers && <ValidationBadge issues={camJob.validationIssues} />}
        <div className="ml-auto flex items-center gap-1">
          <HeaderButton onClick={undo} disabled={state.past.length === 0}>Undo</HeaderButton>
          <HeaderButton onClick={redo} disabled={state.future.length === 0}>Redo</HeaderButton>
          <HeaderButton
            onClick={() => setExportModalOpen(true)}
            disabled={!camResult || camResult.operations.length === 0 || camStale}
          >
            Export
          </HeaderButton>
        </div>
      </header>

      {exportModalOpen && (
        <ExportModal
          formats={exportFormats}
          projectName={exportProjectName}
          onClose={() => setExportModalOpen(false)}
          onExported={(formatLabel, count) =>
            pushToast('info', `Exported ${count} ${formatLabel} file(s) as a zip.`)
          }
          onError={(message) => pushToast('error', message)}
        />
      )}

      <div className="flex flex-1 overflow-hidden">
        {hasLayers && (
          <div className="shrink-0 w-80 border-r border-zinc-800 bg-zinc-950 p-4 overflow-hidden flex flex-col">
            <LayerInfo
              layers={layers}
              parsing={parsing}
              errors={errors}
              onToggle={toggleLayer}
              onRemove={removeLayer}
              soloLayerId={soloLayerId}
              onToggleSolo={toggleSolo}
              onAddFiles={handleFiles}
              onDismissError={dismissError}
              onClearAll={clearAll}
              onPadSizeChange={updatePadSize}
              onTraceWidthChange={updateTraceWidth}
              onHoleDiameterChange={updateHoleDiameter}
              onGeometryHighlight={setGeometryHighlight}
              onDrillSettingsChange={updateDrillSettings}
              opConfigs={opConfigs}
              onOpConfigChange={setOpConfig}
              onGenerate={generateToolpaths}
              onGenerateCentering={generateCentering}
              kernelBusy={kernelBusy}
              camResult={camResult}
              camStale={camStale}
              stock={stockConfig}
              onStockChange={updateStockConfig}
              circuitSizeMm={circuitSizeMm}
              actualStockSizeMm={actualStockSizeMm}
            />
          </div>
        )}

        <main className="flex-1 p-4 overflow-hidden">
          {hasLayers ? (
            <GerberPreview
              layers={layers}
              onAddFiles={handleFiles}
              padHoleMatches={camJob.padHoleAnalysis.matches}
              onPadSizeChange={updatePadSize}
              onSinglePadSizeChange={updateSinglePadSize}
              onTraceWidthChange={updateTraceWidth}
              onSingleTraceWidthChange={updateSingleTrace}
              onHoleDiameterChange={updateHoleDiameter}
              geometryHighlight={geometryHighlight}
              camResult={camResult}
              boardModel={boardModel}
              soloLayerId={soloLayerId}
              hiddenOpIds={hiddenOpIds}
            />
          ) : (
            <GerberDropzone onFiles={handleFiles} />
          )}
        </main>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}


function HeaderButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function sanitizeName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 40);
}

/**
 * Best-effort project name from loaded layer filenames: the longest common
 * prefix across all basenames — KiCad/Altium/Eagle etc. all share one
 * project prefix before the per-layer suffix (e.g. "Board-F_Cu.gbr" /
 * "Board-B_Cu.gbr" / "Board.drl" → "Board"). With only one file loaded
 * there's nothing to compare against, so instead trim its own trailing
 * "-suffix" segment (KiCad's project/layer separator is the LAST dash).
 */
function deriveProjectName(fileNames: string[]): string {
  const bases = fileNames.map((f) => f.replace(/\.[a-z0-9]+$/i, '')).filter(Boolean);
  if (bases.length === 0) return 'pathkernel';
  if (bases.length === 1) {
    const stripped = bases[0].replace(/-[^-]+$/, '');
    return stripped || bases[0];
  }
  let prefix = bases[0];
  for (const base of bases.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < base.length && prefix[i] === base[i]) i++;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[-_.\s]+$/, '');
  return prefix || bases[0];
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file, 'utf-8');
  });
}
