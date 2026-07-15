import React, { useRef, useState } from 'react';
import type { LayerEntry } from '../utils/gerberUtils';
import type { DrillParseSettings, GeometryHighlightTarget } from '../types/geometry';
import type { KernelJobResult, KernelProgress } from '../kernel/types';
import { acceptedFileExtensions, LAYER_COLORS, LAYER_LABELS } from '../utils/layerUtils';
import { computeUnionViewBox } from '../utils/gerberUtils';
import { GeometryPanel } from './GeometryPanel';
import {
  CamWorkflowPanel,
  type OpConfig,
  type OpConfigMap,
  type StockConfig,
} from './cam/CamWorkflowPanel';

interface Props {
  layers: LayerEntry[];
  parsing: boolean;
  errors: Array<{ filename: string; message: string }>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onDismissError: (filename: string) => void;
  onClearAll: () => void;
  onPadSizeChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onTraceWidthChange: (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onGeometryHighlight: (target: GeometryHighlightTarget | null) => void;
  onDrillSettingsChange: (layerId: string, settings: DrillParseSettings) => void;
  opConfigs: OpConfigMap;
  onOpConfigChange: (layerId: string, config: OpConfig) => void;
  onGenerate: () => void;
  onExport: () => void;
  kernelBusy: KernelProgress | null;
  camResult: KernelJobResult | null;
  camStale: boolean;
  stock: StockConfig;
  onStockChange: (stock: StockConfig) => void;
  circuitSizeMm: { width: number; height: number } | null;
}

export function LayerInfo({
  layers,
  parsing,
  errors,
  onToggle,
  onRemove,
  onAddFiles,
  onDismissError,
  onClearAll,
  onPadSizeChange,
  onTraceWidthChange,
  onHoleDiameterChange,
  onGeometryHighlight,
  onDrillSettingsChange,
  opConfigs,
  onOpConfigChange,
  onGenerate,
  onExport,
  kernelBusy,
  camResult,
  camStale,
  stock,
  onStockChange,
  circuitSizeMm,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onAddFiles(files);
    e.target.value = '';
  };

  const unionViewBox = computeUnionViewBox(layers.map((l) => l.result));
  const boardW = unionViewBox ? (unionViewBox[2] / 1000).toFixed(2) : null;
  const boardH = unionViewBox ? (unionViewBox[3] / 1000).toFixed(2) : null;
  const selectedLayer = layers.find((l) => l.id === selectedId) ?? null;

  return (
    <aside className="flex flex-col gap-3 h-full overflow-hidden">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 shrink-0">Layers</h2>

      {errors.map((err) => (
        <div key={err.filename} className="shrink-0 flex items-start gap-2 rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-xs">
          <span className="text-red-400 shrink-0 mt-0.5">!</span>
          <div className="flex-1 min-w-0">
            <p className="text-red-300 font-medium truncate">{err.filename}</p>
            <p className="text-red-400 truncate">{err.message}</p>
          </div>
          <button onClick={() => onDismissError(err.filename)} className="text-red-500 hover:text-red-300 shrink-0">x</button>
        </div>
      ))}

      <div className="flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
        <div className="flex flex-col gap-1">
          {layers.map((layer) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              selected={selectedId === layer.id}
              onSelect={() => setSelectedId(selectedId === layer.id ? null : layer.id)}
              onToggle={() => onToggle(layer.id)}
              onRemove={() => onRemove(layer.id)}
            />
          ))}
          {parsing && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 text-zinc-400 text-xs">
              <div className="w-3.5 h-3.5 rounded-full border border-zinc-500 border-t-transparent animate-spin shrink-0" />
              Parsing...
            </div>
          )}
        </div>

        {selectedLayer && (
          <InspectSection
            layer={selectedLayer}
            onPadSizeChange={onPadSizeChange}
            onTraceWidthChange={onTraceWidthChange}
            onHoleDiameterChange={onHoleDiameterChange}
            onGeometryHighlight={onGeometryHighlight}
            onDrillSettingsChange={onDrillSettingsChange}
          />
        )}

        <CamWorkflowPanel
          layers={layers}
          configs={opConfigs}
          onConfigChange={onOpConfigChange}
          onGenerate={onGenerate}
          onExport={onExport}
          busy={kernelBusy}
          camResult={camResult}
          camStale={camStale}
          stock={stock}
          onStockChange={onStockChange}
          circuitSizeMm={circuitSizeMm}
        />
      </div>

      {boardW && boardH && (
        <div className="shrink-0 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
          <p className="text-xs text-zinc-500 mb-1">Board size</p>
          <p className="text-xs font-mono text-zinc-200">
            {boardW} x {boardH} <span className="text-zinc-500">mm</span>
          </p>
        </div>
      )}

      <div className="shrink-0 flex flex-col gap-2">
        <input ref={inputRef} type="file" accept={acceptedFileExtensions()} multiple className="hidden" onChange={handleChange} />
        <button
          onClick={() => inputRef.current?.click()}
          className="w-full px-3 py-2 text-sm font-medium text-zinc-900 bg-green-400 hover:bg-green-300 rounded-lg transition-colors"
        >
          + Add layer
        </button>
        <button
          onClick={onClearAll}
          className="w-full px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors"
        >
          Clear all
        </button>
      </div>
    </aside>
  );
}

/** Collapsible per-layer inspection: pad/trace/hole editors + drill units. */
function InspectSection({
  layer,
  onPadSizeChange,
  onTraceWidthChange,
  onHoleDiameterChange,
  onGeometryHighlight,
  onDrillSettingsChange,
}: {
  layer: LayerEntry;
  onPadSizeChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onTraceWidthChange: (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onGeometryHighlight: (target: GeometryHighlightTarget | null) => void;
  onDrillSettingsChange: (layerId: string, settings: DrillParseSettings) => void;
}) {
  return (
    <>
      {layer.layerType === 'drill' && layer.drillSettings && (
        <DrillSettingsPanel
          layer={layer}
          onApply={(settings) => onDrillSettingsChange(layer.id, settings)}
        />
      )}
      <GeometryPanel
        layer={layer}
        onPadSizeChange={onPadSizeChange}
        onTraceWidthChange={onTraceWidthChange}
        onHoleDiameterChange={onHoleDiameterChange}
        onGeometryHighlight={onGeometryHighlight}
      />
    </>
  );
}

function DrillSettingsPanel({ layer, onApply }: { layer: LayerEntry; onApply: (settings: DrillParseSettings) => void }) {
  const [settings, setSettings] = useState(layer.drillSettings!);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
      <p className="font-medium text-zinc-300 mb-2">Drill Units</p>
      <label className="flex items-center justify-between gap-2 text-zinc-500">
        Units
        <select
          value={settings.units}
          onChange={(e) => setSettings({ ...settings, units: e.target.value as DrillParseSettings['units'] })}
          className="bg-zinc-800 border border-zinc-700 rounded px-1 py-1 text-zinc-200"
        >
          <option value="auto">Auto</option>
          <option value="mm">mm</option>
          <option value="in">inch</option>
        </select>
      </label>
      <button
        onClick={() => onApply(settings)}
        className="mt-2 w-full px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
      >
        Reparse drill
      </button>
    </div>
  );
}

function LayerRow({ layer, selected, onSelect, onToggle, onRemove }: {
  layer: LayerEntry;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const color = LAYER_COLORS[layer.layerType];
  const label = LAYER_LABELS[layer.layerType];
  const warnings = layer.importReport.warnings;
  const confidence = layer.importReport.confidence;
  const confidenceColor =
    confidence === 'high' ? 'bg-green-400' : confidence === 'medium' ? 'bg-amber-400' : 'bg-red-400';
  const sourceBadge = layer.primitives?.source === 'svg-fallback' ? 'fallback' : null;

  return (
    <div
      className={[
        'flex items-center gap-2 px-2 py-1.5 rounded-lg group cursor-pointer',
        layer.visible ? 'bg-zinc-800/60' : 'bg-zinc-900/40 opacity-50',
        selected ? 'ring-1 ring-green-500/40' : '',
      ].join(' ')}
      onClick={onSelect}
      title={warnings.length > 0 ? warnings.join('\n') : `Detection confidence: ${confidence}`}
    >
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: layer.visible ? color : '#52525b' }} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-200 truncate leading-tight">{layer.file.name}</p>
        <p className="text-xs text-zinc-500 leading-tight flex items-center gap-1">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${confidenceColor}`} />
          {label}
          {sourceBadge && (
            <span className="px-1 rounded bg-zinc-800 text-[10px] text-amber-300" title="Reduced-fidelity geometry source (parser fallback)">
              {sourceBadge}
            </span>
          )}
          {warnings.length > 0 && <span className="text-amber-300">({warnings.length})</span>}
        </p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        <IconButton onClick={onToggle} title={layer.visible ? 'Hide' : 'Show'}>{layer.visible ? <EyeIcon /> : <EyeOffIcon />}</IconButton>
        <IconButton onClick={onRemove} title="Remove"><XIcon /></IconButton>
      </div>
    </div>
  );
}

function IconButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors">
      {children}
    </button>
  );
}

function EyeIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" /><circle cx="8" cy="8" r="2" /></svg>;
}
function EyeOffIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5" /><path d="M4.2 4.3C2.5 5.4 1 8 1 8s2.5 5 7 5c1.3 0 2.5-.4 3.5-1M7 3.1C7.3 3 7.7 3 8 3c4.5 0 7 5 7 5s-.6 1.2-1.7 2.4" /></svg>;
}
function XIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3l10 10M13 3 3 13" /></svg>;
}
