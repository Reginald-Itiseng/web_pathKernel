import React, { useEffect, useRef, useState } from 'react';
import type { LayerEntry } from '../utils/gerberUtils';
import type { PadDefinition, PadHoleMatch, TraceClass } from '../types/geometry';

export interface ElementSelection {
  type: 'pad' | 'trace';
  layerId: string;
  /** For pad: the full def id. For trace: empty. */
  defId: string;
  /** For trace: raw SVG stroke-width. For pad: 0. */
  strokeWidthRaw: number;
  /** Viewport coordinates of the click. */
  clientX: number;
  clientY: number;
}

interface Props {
  selection: ElementSelection;
  layers: LayerEntry[];
  padHoleMatches: PadHoleMatch[];
  onPadSizeChange:      (layerId: string, defId: string, newDiameterMm: number) => void;
  onTraceWidthChange:   (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onClose: () => void;
}

export function SelectionPopup({
  selection, layers, padHoleMatches,
  onPadSizeChange, onTraceWidthChange, onHoleDiameterChange,
  onClose,
}: Props) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Position: appear to the lower-right of click, clamped to viewport
  const [pos, setPos] = useState({ x: selection.clientX + 14, y: selection.clientY + 14 });
  useEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: Math.min(selection.clientX + 14, vw - rect.width  - 8),
      y: Math.min(selection.clientY + 14, vh - rect.height - 8),
    });
  }, [selection.clientX, selection.clientY]);

  const layer = layers.find((l) => l.id === selection.layerId);
  const geo   = layer?.geometry;

  let padDef: PadDefinition | undefined;
  let traceClass: TraceClass | undefined;
  let linkedMatch: PadHoleMatch | undefined;
  let linkedDrillMatch: PadHoleMatch | undefined; // for when a drill hole is clicked

  if (selection.type === 'pad') {
    padDef = geo?.padDefs.find((d) => d.defId === selection.defId);
    if (padDef) {
      // Find linked hole (any copper→hole match using this pad defId)
      linkedMatch = padHoleMatches.find(
        (m) => m.pad.layerId === selection.layerId && m.pad.defId === selection.defId,
      );
      // Could also be a drill layer — find if this pad def is on a drill layer
      if (layer?.layerType === 'drill') {
        linkedDrillMatch = padHoleMatches.find(
          (m) => m.hole.layerId === selection.layerId && m.hole.defId === selection.defId,
        );
      }
    }
  } else {
    traceClass = geo?.traceClasses.find((t) => t.strokeWidthRaw === selection.strokeWidthRaw);
  }

  if (!layer || (!padDef && !traceClass)) return null;

  return (
    <>
      {/* Invisible backdrop to catch outside clicks */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Popup */}
      <div
        ref={popupRef}
        className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl shadow-black/60 p-3 w-64"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            {selection.type === 'pad' ? <PadIcon /> : <TraceIcon />}
            <span className="text-sm font-medium text-zinc-200">
              {selection.type === 'pad'
                ? (layer.layerType === 'drill' ? 'Drill Hole' : 'Pad')
                : 'Trace'}
            </span>
            {padDef && (
              <ShapeTag shape={padDef.shape} />
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Pad editor */}
        {padDef && (
          <PadEditor
            padDef={padDef}
            layerId={selection.layerId}
            layer={layer}
            padInstances={geo?.padInstances.filter((p) => p.defId === selection.defId) ?? []}
            linkedMatch={linkedMatch}
            linkedDrillMatch={linkedDrillMatch}
            onPadSizeChange={onPadSizeChange}
            onHoleDiameterChange={onHoleDiameterChange}
          />
        )}

        {/* Trace editor */}
        {traceClass && (
          <TraceEditor
            traceClass={traceClass}
            layerId={selection.layerId}
            onTraceWidthChange={onTraceWidthChange}
          />
        )}
      </div>
    </>
  );
}

// ─── Pad editor ───────────────────────────────────────────────────────────────

function PadEditor({
  padDef, layerId, layer, padInstances, linkedMatch, linkedDrillMatch,
  onPadSizeChange, onHoleDiameterChange,
}: {
  padDef: PadDefinition;
  layerId: string;
  layer: LayerEntry;
  padInstances: import('../types/geometry').PadInstance[];
  linkedMatch: PadHoleMatch | undefined;
  linkedDrillMatch: PadHoleMatch | undefined;
  onPadSizeChange:      (layerId: string, defId: string, newMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newMm: number) => void;
}) {
  const isDrill  = layer.layerType === 'drill';
  const isCopper = layer.layerType === 'top-copper' || layer.layerType === 'bottom-copper';
  const isEditable = padDef.shape === 'circle' || padDef.shape === 'ring' || padDef.shape === 'rect';
  const currentValue = padDef.diameterMm ?? (padDef.widthMm != null ? Math.max(padDef.widthMm, padDef.heightMm ?? 0) : null);
  const instanceCount = padInstances.length;

  return (
    <div className="flex flex-col gap-2">
      <InfoRow label="Tool">{padDef.toolCode}</InfoRow>
      <InfoRow label="Shape">{padDef.shape}</InfoRow>
      {currentValue != null && (
        <InfoRow label={isDrill ? 'Diameter' : 'Size'}>
          {currentValue.toFixed(3)} mm
        </InfoRow>
      )}
      <InfoRow label="Count">{instanceCount} placed</InfoRow>

      {/* Linked info */}
      {isCopper && linkedMatch && (
        <InfoRow label="Hole">
          ⌀{linkedMatch.hole.diameterMm.toFixed(3)} mm
        </InfoRow>
      )}
      {isDrill && linkedDrillMatch && (
        <InfoRow label="Pad">
          {linkedDrillMatch.pad.defId.split('_pad-')[1] ?? '?'}
        </InfoRow>
      )}

      {/* Edit field */}
      {isEditable && currentValue != null ? (
        <>
          <div className="border-t border-zinc-800 my-0.5" />
          <label className="text-xs text-zinc-500">
            {isDrill ? 'New diameter' : 'New size'} (mm)
          </label>
          <InlineEdit
            initialMm={currentValue}
            onApply={(v) => {
              if (isDrill) {
                onHoleDiameterChange(layerId, padDef.defId, v);
              } else {
                onPadSizeChange(layerId, padDef.defId, v);
              }
            }}
            applyLabel={`Apply to all ${instanceCount}`}
          />
        </>
      ) : (
        <p className="text-xs text-zinc-600 italic">Complex macro — not editable</p>
      )}

      {/* Linked hole edit for copper pads */}
      {isCopper && linkedMatch && (
        <>
          <div className="border-t border-zinc-800 my-0.5" />
          <label className="text-xs text-zinc-500">Drill hole diameter (mm)</label>
          <InlineEdit
            initialMm={linkedMatch.hole.diameterMm}
            onApply={(v) => onHoleDiameterChange(linkedMatch.hole.layerId, linkedMatch.hole.defId, v)}
            applyLabel="Apply hole"
          />
        </>
      )}
    </div>
  );
}

// ─── Trace editor ─────────────────────────────────────────────────────────────

function TraceEditor({ traceClass, layerId, onTraceWidthChange }: {
  traceClass: TraceClass;
  layerId: string;
  onTraceWidthChange: (layerId: string, oldRaw: number, newWidthMm: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <InfoRow label="Width">{traceClass.widthMm.toFixed(3)} mm</InfoRow>
      <InfoRow label="Count">{traceClass.instanceCount} traces</InfoRow>
      <div className="border-t border-zinc-800 my-0.5" />
      <label className="text-xs text-zinc-500">New width (mm)</label>
      <InlineEdit
        initialMm={traceClass.widthMm}
        onApply={(v) => onTraceWidthChange(layerId, traceClass.strokeWidthRaw, v)}
        applyLabel={`Apply to all ${traceClass.instanceCount}`}
      />
    </div>
  );
}

// ─── Inline editable field ────────────────────────────────────────────────────

function InlineEdit({ initialMm, onApply, applyLabel }: {
  initialMm: number;
  onApply: (v: number) => void;
  applyLabel: string;
}) {
  const [value, setValue] = useState(initialMm.toFixed(3));
  const [flash, setFlash] = useState(false);

  // Sync if parent re-extracts and changes the initial value
  const prev = useRef(initialMm);
  if (prev.current !== initialMm) { prev.current = initialMm; setValue(initialMm.toFixed(3)); }

  const dirty = parseFloat(value).toFixed(3) !== initialMm.toFixed(3);

  const apply = () => {
    const v = Math.max(0.001, Math.min(99.999, parseFloat(value)));
    if (!isFinite(v)) return;
    onApply(v);
    setFlash(true);
    setTimeout(() => setFlash(false), 600);
  };

  return (
    <div className="flex gap-1.5">
      <input
        type="number"
        min="0.001" max="99.999" step="0.001"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const v = parseFloat(value);
          if (!isFinite(v) || v <= 0) setValue(initialMm.toFixed(3));
          else setValue(Math.max(0.001, Math.min(99.999, v)).toFixed(3));
        }}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        className={[
          'flex-1 min-w-0 bg-zinc-800 border rounded px-2 py-1 text-xs font-mono text-zinc-200',
          'focus:outline-none transition-colors',
          flash ? 'border-green-500' : dirty ? 'border-amber-600' : 'border-zinc-700 focus:border-zinc-500',
        ].join(' ')}
      />
      <button
        onClick={apply}
        disabled={!dirty}
        className="shrink-0 px-2.5 py-1 text-xs font-medium rounded bg-green-600 hover:bg-green-500 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      >
        {applyLabel}
      </button>
    </div>
  );
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300 font-mono">{children}</span>
    </div>
  );
}

function ShapeTag({ shape }: { shape: string }) {
  const cls: Record<string, string> = {
    circle: 'bg-blue-900/60 text-blue-300',
    ring:   'bg-purple-900/60 text-purple-300',
    rect:   'bg-amber-900/60 text-amber-300',
    complex:'bg-zinc-800 text-zinc-500',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${cls[shape] ?? cls.complex}`}>
      {shape === 'complex' ? 'macro' : shape}
    </span>
  );
}

function PadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="5" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </svg>
  );
}
function TraceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M2 7h10" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 2l8 8M10 2 2 10" />
    </svg>
  );
}
