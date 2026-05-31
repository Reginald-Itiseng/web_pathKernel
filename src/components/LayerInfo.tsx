import React, { useRef, useState, useEffect } from 'react';
import type { LayerEntry, DrillFormatOptions } from '../utils/gerberUtils';
import { LAYER_LABELS, LAYER_COLORS } from '../utils/layerUtils';
import { computeUnionViewBox } from '../utils/gerberUtils';

const ACCEPTED = '.gbr,.gtl,.gbl,.gts,.gbs,.ger,.art,.gto,.gbo,.gko,.drl';

// ─── Drill format presets ────────────────────────────────────────────────────

const ZERO_OPTIONS = [
  { value: '',  label: 'Auto-detect' },
  { value: 'L', label: 'L — leading zeros omitted' },
  { value: 'T', label: 'T — trailing zeros omitted' },
] as const;

const PLACES_OPTIONS = [
  { value: '',    label: 'Auto-detect', places: undefined },
  { value: '2:4', label: '2:4  (0.0001 mm)',  places: [2, 4] as [number, number] },
  { value: '2:5', label: '2:5  (0.00001 mm)', places: [2, 5] as [number, number] },
  { value: '2:6', label: '2:6  (0.000001 mm)', places: [2, 6] as [number, number] },
  { value: '3:3', label: '3:3  (0.001 mm)',   places: [3, 3] as [number, number] },
  { value: '3:4', label: '3:4  (0.0001 mm)',  places: [3, 4] as [number, number] },
  { value: '4:2', label: '4:2  (0.01 mm)',    places: [4, 2] as [number, number] },
] as const;

const UNITS_OPTIONS = [
  { value: '',   label: 'Auto-detect' },
  { value: 'mm', label: 'mm  (metric)' },
  { value: 'in', label: 'in  (imperial)' },
] as const;

function placesToKey(p?: [number, number]): string {
  return p ? `${p[0]}:${p[1]}` : '';
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  layers: LayerEntry[];
  parsing: boolean;
  /** IDs of drill layers currently being re-parsed. */
  reparsing: Set<string>;
  errors: Array<{ filename: string; message: string }>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onDismissError: (filename: string) => void;
  onClearAll: () => void;
  onReparseLayer: (id: string, format: DrillFormatOptions) => void;
}

// ─── Root component ──────────────────────────────────────────────────────────

export function LayerInfo({
  layers, parsing, reparsing, errors,
  onToggle, onRemove, onAddFiles, onDismissError, onClearAll, onReparseLayer,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onAddFiles(files);
    e.target.value = '';
  };

  const unionViewBox = computeUnionViewBox(layers.map((l) => l.result));
  const firstUnits   = layers.find((l) => l.result.units)?.result.units ?? 'mm';
  const boardW = unionViewBox ? (unionViewBox[2] / 1000).toFixed(2) : null;
  const boardH = unionViewBox ? (unionViewBox[3] / 1000).toFixed(2) : null;

  return (
    <aside className="flex flex-col gap-3 h-full">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Layers</h2>

      {/* Error toasts */}
      {errors.map((err) => (
        <div key={err.filename} className="flex items-start gap-2 rounded-lg bg-red-950/50 border border-red-800 px-3 py-2 text-xs">
          <span className="text-red-400 shrink-0 mt-0.5">!</span>
          <div className="flex-1 min-w-0">
            <p className="text-red-300 font-medium truncate">{err.filename}</p>
            <p className="text-red-400 truncate">{err.message}</p>
          </div>
          <button onClick={() => onDismissError(err.filename)} className="text-red-500 hover:text-red-300 shrink-0">×</button>
        </div>
      ))}

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
        {layers.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            isReparsing={reparsing.has(layer.id)}
            onToggle={() => onToggle(layer.id)}
            onRemove={() => onRemove(layer.id)}
            onReparse={(fmt) => onReparseLayer(layer.id, fmt)}
          />
        ))}
        {parsing && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 text-zinc-400 text-xs">
            <div className="w-3.5 h-3.5 rounded-full border border-zinc-500 border-t-transparent animate-spin shrink-0" />
            Parsing…
          </div>
        )}
      </div>

      {/* Board dimensions */}
      {boardW && boardH && (
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
          <p className="text-xs text-zinc-500 mb-1">Board size</p>
          <p className="text-xs font-mono text-zinc-200">
            {boardW} × {boardH} <span className="text-zinc-500">{firstUnits}</span>
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <input ref={inputRef} type="file" accept={ACCEPTED} multiple className="hidden" onChange={handleChange} />
        <button onClick={() => inputRef.current?.click()}
          className="w-full px-3 py-2 text-sm font-medium text-zinc-900 bg-green-400 hover:bg-green-300 rounded-lg transition-colors">
          + Add layer
        </button>
        <button onClick={onClearAll}
          className="w-full px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors">
          Clear all
        </button>
      </div>
    </aside>
  );
}

// ─── Layer row ───────────────────────────────────────────────────────────────

function LayerRow({ layer, isReparsing, onToggle, onRemove, onReparse }: {
  layer: LayerEntry;
  isReparsing: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onReparse: (fmt: DrillFormatOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const isDrill = layer.layerType === 'drill';
  const color   = LAYER_COLORS[layer.layerType];
  const label   = LAYER_LABELS[layer.layerType];

  // Auto-close the panel once a re-parse completes successfully
  const prevReparsing = useRef(isReparsing);
  useEffect(() => {
    if (prevReparsing.current && !isReparsing) {
      setOpen(false);
    }
    prevReparsing.current = isReparsing;
  }, [isReparsing]);

  return (
    <div className="rounded-lg overflow-hidden">
      {/* Header row */}
      <div className={[
        'flex items-center gap-2 px-2 py-1.5 group',
        layer.visible ? 'bg-zinc-800/60' : 'bg-zinc-900/40 opacity-50',
      ].join(' ')}>
        <span className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: layer.visible ? color : '#52525b' }} />

        <div className="flex-1 min-w-0">
          <p className="text-xs text-zinc-200 truncate leading-tight">{layer.file.name}</p>
          <p className="text-xs text-zinc-500 leading-tight">{label}</p>
        </div>

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {isDrill && (
            <button onClick={() => setOpen((o) => !o)} title="Drill format options"
              className={[
                'p-1 rounded transition-colors',
                open
                  ? 'text-green-400 bg-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700',
              ].join(' ')}>
              <GearIcon />
            </button>
          )}
          <button onClick={onToggle} title={layer.visible ? 'Hide' : 'Show'}
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors">
            {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
          </button>
          <button onClick={onRemove} title="Remove"
            className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-700 transition-colors">
            <XIcon />
          </button>
        </div>
      </div>

      {/* Drill format panel — stays open while re-parsing so the user
          can see it's working and isn't left wondering if anything happened */}
      {isDrill && open && (
        <DrillFormatPanel
          committed={layer.drillFormat ?? {}}
          isReparsing={isReparsing}
          onReparse={onReparse}
        />
      )}
    </div>
  );
}

// ─── Drill format panel ──────────────────────────────────────────────────────

function DrillFormatPanel({ committed, isReparsing, onReparse }: {
  committed: DrillFormatOptions;
  isReparsing: boolean;
  onReparse: (fmt: DrillFormatOptions) => void;
}) {
  const [fmt, setFmt] = useState<DrillFormatOptions>(committed);

  const dirty =
    fmt.zero   !== committed.zero   ||
    fmt.units  !== committed.units  ||
    placesToKey(fmt.places) !== placesToKey(committed.places);

  function set(key: 'zero' | 'units', raw: string) {
    setFmt((f) => ({ ...f, [key]: (raw as 'L' | 'T' | 'mm' | 'in') || undefined }));
  }
  function setPlaces(raw: string) {
    const preset = PLACES_OPTIONS.find((o) => o.value === raw);
    setFmt((f) => ({ ...f, places: preset?.places }));
  }

  return (
    <div className="bg-zinc-900 border-t border-zinc-700 px-3 py-2.5 flex flex-col gap-2">
      <p className="text-xs text-zinc-400 font-medium">Drill format overrides</p>

      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-zinc-500">Zero suppression</span>
        <select
          value={fmt.zero ?? ''}
          onChange={(e) => set('zero', e.target.value)}
          disabled={isReparsing}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200
            focus:outline-none focus:border-green-500 disabled:opacity-50"
        >
          {ZERO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-zinc-500">Decimal format</span>
        <select
          value={placesToKey(fmt.places)}
          onChange={(e) => setPlaces(e.target.value)}
          disabled={isReparsing}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200
            focus:outline-none focus:border-green-500 disabled:opacity-50"
        >
          {PLACES_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-zinc-500">Units</span>
        <select
          value={fmt.units ?? ''}
          onChange={(e) => set('units', e.target.value)}
          disabled={isReparsing}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200
            focus:outline-none focus:border-green-500 disabled:opacity-50"
        >
          {UNITS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      <button
        onClick={() => onReparse(fmt)}
        disabled={!dirty || isReparsing}
        className="w-full mt-0.5 py-1.5 text-xs font-medium rounded transition-colors
          bg-green-500 hover:bg-green-400 text-zinc-900
          disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isReparsing ? (
          <>
            <span className="w-3 h-3 rounded-full border border-zinc-900 border-t-transparent animate-spin" />
            Parsing…
          </>
        ) : 'Re-parse'}
      </button>

      {dirty && !isReparsing && (
        <p className="text-xs text-amber-400 text-center">Unsaved changes</p>
      )}
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" /><circle cx="8" cy="8" r="2" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5" />
      <path d="M4.2 4.3C2.5 5.4 1 8 1 8s2.5 5 7 5c1.3 0 2.5-.4 3.5-1M7 3.1C7.3 3 7.7 3 8 3c4.5 0 7 5 7 5s-.6 1.2-1.7 2.4" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 3l10 10M13 3 3 13" />
    </svg>
  );
}
