import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GerberDropzone } from './components/GerberDropzone';
import { GerberPreview } from './components/GerberPreview';
import { LayerInfo } from './components/LayerInfo';
import { ToastStack, type Toast } from './components/ToastStack';
import { ValidationBadge } from './components/ValidationBadge';
import {
  buildOperationRequests,
  CENTERING_KEY,
  DEFAULT_STOCK_CONFIG,
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
import { buildKernelLayers, ingestLayerPrimitives } from './utils/kernelBridge';
import { runKernelJobInWorker } from './workers/kernelClient';
import { exportHpgl } from './kernel/hpgl';
import type { Board3DModel, KernelJobResult, KernelProgress } from './kernel/types';
import {
  addPathIds,
  editHoleDiameter,
  editPadSize,
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
    // NOTE: SVG edits (pad resize etc.) do not flow into kernel primitives —
    // the kernel keeps working from the original file geometry. The stale
    // badge tells the user toolpaths no longer match the edited preview.
    return { ...layer, result, geometry, importReport };
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
      l.id === layerId ? rebuildEditedLayer(l, editPadSize(l.result.svgString, defId, newDiameterMm)) : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateTraceWidth = useCallback((layerId: string, oldRaw: number, newWidthMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId ? rebuildEditedLayer(l, editTraceWidth(l.result.svgString, oldRaw, newWidthMm)) : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateSingleTrace = useCallback((layerId: string, pathId: string, newWidthMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId ? rebuildEditedLayer(l, editSingleTraceWidth(l.result.svgString, pathId, newWidthMm)) : l
    )));
  }, [commitLayers, rebuildEditedLayer]);

  const updateHoleDiameter = useCallback((layerId: string, defId: string, newDiameterMm: number) => {
    commitLayers((layers) => layers.map((l) => (
      l.id === layerId ? rebuildEditedLayer(l, editHoleDiameter(l.result.svgString, defId, newDiameterMm)) : l
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
        }
      }
      return next;
    });
    setCamStale(true);
  }, [state.layers]);

  // Toolpath overlays hidden via each operation card's eye toggle.
  const hiddenOpIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const [key, config] of Object.entries(opConfigs)) {
      if (!config.overlayVisible) hidden.add(opIdFor(key, config));
    }
    return hidden;
  }, [opConfigs]);

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

  const exportKernelHpgl = useCallback(async () => {
    if (!camResult || camResult.operations.length === 0) return;
    try {
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

      // One file per operation, numbered in machining order.
      const layerTypeById = new Map(state.layers.map((l) => [l.id, l.layerType]));
      const layerFileById = new Map(state.layers.map((l) => [l.id, l.file.name]));
      const orderOf = (op: (typeof camResult.operations)[number]): number => {
        if (op.kind === 'centering') return 0;
        if (op.kind === 'isolation') {
          return layerTypeById.get(op.layerId) === 'bottom-copper' ? 2 : 1;
        }
        return op.kind === 'drill' ? 3 : 4;
      };
      const ordered = [...camResult.operations].sort((a, b) => orderOf(a) - orderOf(b));

      for (let i = 0; i < ordered.length; i++) {
        const op = ordered[i];
        const { text } = exportHpgl([op], exportOpts);
        const base =
          op.kind === 'centering'
            ? 'centering'
            : `${op.kind}-${sanitizeName(layerFileById.get(op.layerId) ?? op.layerId)}`;
        const name = `${String(i + 1).padStart(2, '0')}-${base}${op.mirror ? '-mirrored' : ''}.hpgl`;
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        URL.revokeObjectURL(url);
        // Give the browser breathing room between programmatic downloads.
        if (i < ordered.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
      pushToast('info', `Exported ${ordered.length} HPGL file(s) in machining order.`);
    } catch (err) {
      pushToast('error', `HPGL export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [camResult, stockConfig, camJob.boardBounds, state.layers, pushToast]);

  const { layers, parsing, errors } = state;
  const hasLayers = layers.length > 0 || parsing || errors.length > 0;

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-200">
      <header className="shrink-0 flex items-center gap-3 px-5 h-12 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-2">
          <PcbIcon className="w-5 h-5 text-green-400" />
          <span className="font-semibold text-zinc-100 tracking-tight">PCB Mill CAM</span>
        </div>
        {hasLayers && <ValidationBadge issues={camJob.validationIssues} />}
        <div className="ml-auto flex items-center gap-1">
          <HeaderButton onClick={undo} disabled={state.past.length === 0}>Undo</HeaderButton>
          <HeaderButton onClick={redo} disabled={state.future.length === 0}>Redo</HeaderButton>
          <HeaderButton
            onClick={exportKernelHpgl}
            disabled={!camResult || camResult.operations.length === 0 || camStale}
          >
            Export HPGL
          </HeaderButton>
        </div>
      </header>

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
              onExport={exportKernelHpgl}
              kernelBusy={kernelBusy}
              camResult={camResult}
              camStale={camStale}
              stock={stockConfig}
              onStockChange={updateStockConfig}
              circuitSizeMm={circuitSizeMm}
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

function PcbIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="16" height="16" rx="2" />
      <path d="M6 6h2v2H6zM12 6h2v2h-2zM6 12h2v2H6zM12 12h2v2h-2z" />
      <path d="M8 7h4M7 8v4M13 8v4M8 13h4" />
    </svg>
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

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file, 'utf-8');
  });
}
