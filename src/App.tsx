import { useState, useCallback, useMemo } from 'react';
import { GerberDropzone } from './components/GerberDropzone';
import { GerberPreview } from './components/GerberPreview';
import { LayerInfo } from './components/LayerInfo';
import { parseGerber, type LayerEntry } from './utils/gerberUtils';
import { LAYER_COLORS, detectLayerType } from './utils/layerUtils';
import {
  extractLayerGeometry,
  editPadSize,
  editTraceWidth,
  editHoleDiameter,
  matchPadsToHoles,
} from './utils/geometryUtils';
import type { PadHoleMatch } from './types/geometry';

interface ParseError {
  filename: string;
  message: string;
}

interface AppState {
  layers: LayerEntry[];
  parsing: boolean;
  errors: ParseError[];
}

const INITIAL: AppState = { layers: [], parsing: false, errors: [] };

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);

  const handleFiles = useCallback(async (files: File[]) => {
    setState((s) => ({ ...s, parsing: true }));

    const newLayers: LayerEntry[] = [];
    const newErrors: ParseError[] = [];

    for (const file of files) {
      try {
        const content   = await readFileAsText(file);
        const layerType = detectLayerType(file.name);
        const color     = LAYER_COLORS[layerType];
        const result    = await parseGerber(content, color, layerType === 'drill' ? 'drill' : 'gerber');
        const id        = crypto.randomUUID();
        const geometry  = extractLayerGeometry(result.svgString, id, layerType, result.units);
        newLayers.push({ id, file, result, layerType, color, visible: true, geometry });
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
    }));
  }, []);

  const toggleLayer = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      layers: s.layers.map((l) => l.id === id ? { ...l, visible: !l.visible } : l),
    }));
  }, []);

  const removeLayer = useCallback((id: string) => {
    setState((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== id) }));
  }, []);

  const dismissError = useCallback((filename: string) => {
    setState((s) => ({ ...s, errors: s.errors.filter((e) => e.filename !== filename) }));
  }, []);

  const clearAll = useCallback(() => setState(INITIAL), []);

  // ── Geometry edit callbacks ───────────────────────────────────────────────

  const updatePadSize = useCallback((layerId: string, defId: string, newDiameterMm: number) => {
    setState((s) => ({
      ...s,
      layers: s.layers.map((l) => {
        if (l.id !== layerId) return l;
        const newSvg    = editPadSize(l.result.svgString, defId, newDiameterMm);
        const newResult = { ...l.result, svgString: newSvg };
        const geometry  = extractLayerGeometry(newSvg, l.id, l.layerType, l.result.units);
        return { ...l, result: newResult, geometry };
      }),
    }));
  }, []);

  const updateTraceWidth = useCallback((layerId: string, oldRaw: number, newWidthMm: number) => {
    setState((s) => ({
      ...s,
      layers: s.layers.map((l) => {
        if (l.id !== layerId) return l;
        const newSvg    = editTraceWidth(l.result.svgString, oldRaw, newWidthMm);
        const newResult = { ...l.result, svgString: newSvg };
        const geometry  = extractLayerGeometry(newSvg, l.id, l.layerType, l.result.units);
        return { ...l, result: newResult, geometry };
      }),
    }));
  }, []);

  const updateHoleDiameter = useCallback((layerId: string, defId: string, newDiameterMm: number) => {
    setState((s) => ({
      ...s,
      layers: s.layers.map((l) => {
        if (l.id !== layerId) return l;
        const newSvg    = editHoleDiameter(l.result.svgString, defId, newDiameterMm);
        const newResult = { ...l.result, svgString: newSvg };
        const geometry  = extractLayerGeometry(newSvg, l.id, l.layerType, l.result.units);
        return { ...l, result: newResult, geometry };
      }),
    }));
  }, []);

  // ── Derived: cross-layer pad→hole matching ────────────────────────────────

  const padHoleMatches: PadHoleMatch[] = useMemo(
    () => matchPadsToHoles(state.layers),
    [state.layers],
  );

  // ─────────────────────────────────────────────────────────────────────────

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
          Phase 1 — Preview
        </span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {hasLayers && (
          <div className="shrink-0 w-72 border-r border-zinc-800 bg-zinc-950 p-4 overflow-hidden flex flex-col">
            <LayerInfo
              layers={layers}
              parsing={parsing}
              errors={errors}
              padHoleMatches={padHoleMatches}
              onToggle={toggleLayer}
              onRemove={removeLayer}
              onAddFiles={handleFiles}
              onDismissError={dismissError}
              onClearAll={clearAll}
              onPadSizeChange={updatePadSize}
              onTraceWidthChange={updateTraceWidth}
              onHoleDiameterChange={updateHoleDiameter}
            />
          </div>
        )}

        <main className="flex-1 p-4 overflow-hidden">
          {hasLayers ? (
            <GerberPreview
              layers={layers}
              onAddFiles={handleFiles}
              padHoleMatches={padHoleMatches}
              onPadSizeChange={updatePadSize}
              onTraceWidthChange={updateTraceWidth}
              onHoleDiameterChange={updateHoleDiameter}
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

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file, 'utf-8');
  });
}
