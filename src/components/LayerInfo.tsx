import React, { useRef } from 'react';
import type { LayerEntry } from '../utils/gerberUtils';
import { LAYER_LABELS, LAYER_COLORS } from '../utils/layerUtils';
import { computeUnionViewBox } from '../utils/gerberUtils';

const ACCEPTED = '.gbr,.gtl,.gbl,.gts,.gbs,.ger,.art,.gto,.gbo,.gko,.drl';

interface Props {
  layers: LayerEntry[];
  parsing: boolean;
  errors: Array<{ filename: string; message: string }>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onDismissError: (filename: string) => void;
  onClearAll: () => void;
}

export function LayerInfo({
  layers, parsing, errors,
  onToggle, onRemove, onAddFiles, onDismissError, onClearAll,
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

      <div className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
        {layers.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            onToggle={() => onToggle(layer.id)}
            onRemove={() => onRemove(layer.id)}
          />
        ))}
        {parsing && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 text-zinc-400 text-xs">
            <div className="w-3.5 h-3.5 rounded-full border border-zinc-500 border-t-transparent animate-spin shrink-0" />
            Parsing…
          </div>
        )}
      </div>

      {boardW && boardH && (
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
          <p className="text-xs text-zinc-500 mb-1">Board size</p>
          <p className="text-xs font-mono text-zinc-200">
            {boardW} × {boardH} <span className="text-zinc-500">{firstUnits}</span>
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <input ref={inputRef} type="file" accept={ACCEPTED} multiple className="hidden" onChange={handleChange} />
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

function LayerRow({ layer, onToggle, onRemove }: {
  layer: LayerEntry;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const color = LAYER_COLORS[layer.layerType];
  const label = LAYER_LABELS[layer.layerType];

  return (
    <div className={[
      'flex items-center gap-2 px-2 py-1.5 rounded-lg group',
      layer.visible ? 'bg-zinc-800/60' : 'bg-zinc-900/40 opacity-50',
    ].join(' ')}>
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: layer.visible ? color : '#52525b' }}
      />

      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-200 truncate leading-tight">{layer.file.name}</p>
        <p className="text-xs text-zinc-500 leading-tight">{label}</p>
      </div>

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onToggle}
          title={layer.visible ? 'Hide' : 'Show'}
          className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
        >
          {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
        </button>
        <button
          onClick={onRemove}
          title="Remove"
          className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-700 transition-colors"
        >
          <XIcon />
        </button>
      </div>
    </div>
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
