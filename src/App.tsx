import React, { useCallback, useMemo, useState } from 'react';
import { GerberDropzone } from './components/GerberDropzone';
import { GerberPreview } from './components/GerberPreview';
import { LayerInfo } from './components/LayerInfo';
import { parseGerber, type LayerEntry } from './utils/gerberUtils';
import { LAYER_COLORS, detectLayerType } from './utils/layerUtils';
import {
  buildCamJob,
  buildImportReport,
  DEFAULT_DRILL_SETTINGS,
  DEFAULT_HPGL_SETTINGS,
  exportHpgl,
} from './utils/camUtils';
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

  const commitLayers = useCallback((updater: (layers: LayerEntry[]) => LayerEntry[]) => {
    setState((s) => ({
      ...s,
      layers: updater(s.layers),
      past: [...s.past, s.layers],
      future: [],
    }));
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
    return { ...layer, result, geometry, importReport };
  }, []);

  const toggleLayer = useCallback((id: string) => {
    commitLayers((layers) => layers.map((l) => l.id === id ? { ...l, visible: !l.visible } : l));
  }, [commitLayers]);

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
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const previous = s.past[s.past.length - 1];
      if (!previous) return s;
      return { ...s, layers: previous, past: s.past.slice(0, -1), future: [s.layers, ...s.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const next = s.future[0];
      if (!next) return s;
      return { ...s, layers: next, past: [...s.past, s.layers], future: s.future.slice(1) };
    });
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
      commitLayers((layers) => layers.map((l) => l.id === layerId
        ? { ...l, result: enriched, geometry, importReport, drillSettings: settings }
        : l));
    } catch (err) {
      setState((s) => ({
        ...s,
        errors: [...s.errors, { filename: layer.file.name, message: err instanceof Error ? err.message : 'Drill reparse failed' }],
      }));
    }
  }, [commitLayers, state.layers]);

  const camJob = useMemo(() => buildCamJob(state.layers), [state.layers]);

  const exportGenericHpgl = useCallback(() => {
    const hpgl = exportHpgl(camJob.operations, camJob.boardBounds, DEFAULT_HPGL_SETTINGS);
    const blob = new Blob([hpgl], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pcb-cam-v1.hpgl';
    link.click();
    URL.revokeObjectURL(url);
  }, [camJob]);

  const { layers, parsing, errors } = state;
  const hasLayers = layers.length > 0 || parsing || errors.length > 0;

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-200">
      <header className="shrink-0 flex items-center gap-3 px-5 h-12 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-2">
          <PcbIcon className="w-5 h-5 text-green-400" />
          <span className="font-semibold text-zinc-100 tracking-tight">PCB Mill CAM</span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-400">
          Robust CAM V1
        </span>
        <div className="ml-auto flex items-center gap-1">
          <HeaderButton onClick={undo} disabled={state.past.length === 0}>Undo</HeaderButton>
          <HeaderButton onClick={redo} disabled={state.future.length === 0}>Redo</HeaderButton>
          <HeaderButton onClick={exportGenericHpgl} disabled={camJob.operations.length === 0}>Export HPGL</HeaderButton>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {hasLayers && (
          <div className="shrink-0 w-80 border-r border-zinc-800 bg-zinc-950 p-4 overflow-hidden flex flex-col">
            <LayerInfo
              layers={layers}
              parsing={parsing}
              errors={errors}
              camJob={camJob}
              onToggle={toggleLayer}
              onRemove={removeLayer}
              onAddFiles={handleFiles}
              onDismissError={dismissError}
              onClearAll={clearAll}
              onPadSizeChange={updatePadSize}
              onTraceWidthChange={updateTraceWidth}
              onHoleDiameterChange={updateHoleDiameter}
              onGeometryHighlight={setGeometryHighlight}
              onDrillSettingsChange={updateDrillSettings}
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
            />
          ) : (
            <GerberDropzone onFiles={handleFiles} />
          )}
        </main>
      </div>
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

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file, 'utf-8');
  });
}
