import React, { useEffect, useRef, useState } from 'react';
import type { LayerEntry } from '../utils/gerberUtils';
import type { PadDefinition, PadHoleMatch, TraceClass } from '../types/geometry';

export interface ElementSelection {
  type: 'pad' | 'trace';
  layerId: string;
  defId: string;
  strokeWidthRaw: number;
  pathId: string | undefined;
  instanceId: string | undefined;
  xMm: number | undefined;
  yMm: number | undefined;
  clientX: number;
  clientY: number;
}

interface Props {
  selection: ElementSelection;
  layers: LayerEntry[];
  padHoleMatches: PadHoleMatch[];
  onPadSizeChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onSinglePadSizeChange: (layerId: string, defId: string, instanceId: string, newDiameterMm: number) => void;
  onTraceWidthChange: (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onSingleTraceWidthChange: (layerId: string, pathId: string, newWidthMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onClose: () => void;
}

export function SelectionPopup({
  selection,
  layers,
  padHoleMatches,
  onPadSizeChange,
  onSinglePadSizeChange,
  onTraceWidthChange,
  onSingleTraceWidthChange,
  onHoleDiameterChange,
  onClose,
}: Props) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: selection.clientX + 14, y: selection.clientY + 14 });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(selection.clientX + 14, window.innerWidth - rect.width - 8),
      y: Math.min(selection.clientY + 14, window.innerHeight - rect.height - 8),
    });
  }, [selection.clientX, selection.clientY]);

  const layer = layers.find((l) => l.id === selection.layerId);
  const geo = layer?.geometry;
  const padDef = selection.type === 'pad'
    ? geo?.padDefs.find((d) => d.defId === selection.defId)
    : undefined;
  const traceClass = selection.type === 'trace'
    ? geo?.traceClasses.find((t) => Math.abs(t.strokeWidthRaw - selection.strokeWidthRaw) < 0.000001)
    : undefined;
  const linkedMatch = selection.type === 'pad' && padDef
    ? findLinkedMatch(selection, layer, padHoleMatches)
    : undefined;

  if (!layer || (!padDef && !traceClass)) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={popupRef}
        className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl shadow-black/60 p-3 w-72"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            {selection.type === 'pad' ? <PadIcon /> : <TraceIcon />}
            <span className="text-sm font-medium text-zinc-200">
              {selection.type === 'pad' ? (layer.layerType === 'drill' ? 'Drill Hole' : 'Pad') : 'Trace'}
            </span>
            {padDef && <ShapeTag shape={padDef.shape} />}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-colors">
            <CloseIcon />
          </button>
        </div>

        {padDef && (
          <PadEditor
            padDef={padDef}
            layerId={selection.layerId}
            layer={layer}
            padInstances={geo?.padInstances.filter((p) => p.defId === selection.defId) ?? []}
            selectedInstanceId={selection.instanceId}
            selectedXmm={selection.xMm}
            selectedYmm={selection.yMm}
            linkedMatch={linkedMatch}
            onPadSizeChange={onPadSizeChange}
            onSinglePadSizeChange={onSinglePadSizeChange}
            onHoleDiameterChange={onHoleDiameterChange}
          />
        )}

        {traceClass && (
          <TraceEditor
            traceClass={traceClass}
            layerId={selection.layerId}
            pathId={selection.pathId}
            onTraceWidthChange={onTraceWidthChange}
            onSingleTraceWidthChange={onSingleTraceWidthChange}
          />
        )}
      </div>
    </>
  );
}

function findLinkedMatch(
  selection: ElementSelection,
  layer: LayerEntry | undefined,
  matches: PadHoleMatch[],
): PadHoleMatch | undefined {
  if (!layer) return undefined;
  if (layer.layerType === 'drill') {
    const holeId = selection.instanceId?.replace(':pad:', ':hole:');
    return matches.find((m) => m.hole.layerId === selection.layerId && (holeId ? m.hole.instanceId === holeId : m.hole.defId === selection.defId));
  }
  return matches.find((m) => m.pad.layerId === selection.layerId && (selection.instanceId ? m.pad.instanceId === selection.instanceId : m.pad.defId === selection.defId));
}

function PadEditor({
  padDef,
  layerId,
  layer,
  padInstances,
  selectedInstanceId,
  selectedXmm,
  selectedYmm,
  linkedMatch,
  onPadSizeChange,
  onSinglePadSizeChange,
  onHoleDiameterChange,
}: {
  padDef: PadDefinition;
  layerId: string;
  layer: LayerEntry;
  padInstances: import('../types/geometry').PadInstance[];
  selectedInstanceId: string | undefined;
  selectedXmm: number | undefined;
  selectedYmm: number | undefined;
  linkedMatch: PadHoleMatch | undefined;
  onPadSizeChange: (layerId: string, defId: string, newMm: number) => void;
  onSinglePadSizeChange: (layerId: string, defId: string, instanceId: string, newMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newMm: number) => void;
}) {
  const isDrill = layer.layerType === 'drill';
  const isCopper = layer.layerType === 'top-copper' || layer.layerType === 'bottom-copper';
  const isEditable = padDef.shape === 'circle' || padDef.shape === 'ring' || padDef.shape === 'rect';
  const currentValue = padDef.diameterMm ?? (padDef.widthMm != null ? Math.max(padDef.widthMm, padDef.heightMm ?? 0) : null);
  const instanceCount = padInstances.length;
  // Default to touching just the clicked pad; "same tool" edits the whole def.
  const canSingle = selectedInstanceId != null && !isDrill;
  const [scope, setScope] = useState<'single' | 'group'>(canSingle ? 'single' : 'group');
  const editingSingle = scope === 'single' && canSingle;

  return (
    <div className="flex flex-col gap-2">
      <InfoRow label="Tool">{padDef.toolCode}</InfoRow>
      <InfoRow label="Shape">{padDef.shape}</InfoRow>
      {currentValue != null && <InfoRow label={isDrill ? 'Diameter' : 'Size'}>{currentValue.toFixed(3)} mm</InfoRow>}
      <InfoRow label="Scope">{instanceCount} placed</InfoRow>
      {selectedInstanceId && selectedXmm != null && selectedYmm != null && (
        <InfoRow label="Selected">{selectedXmm.toFixed(3)}, {selectedYmm.toFixed(3)}</InfoRow>
      )}

      {isCopper && linkedMatch && (
        <InfoRow label="Matched hole">
          {linkedMatch.hole.diameterMm.toFixed(3)} mm / {linkedMatch.distanceMm.toFixed(3)} mm
        </InfoRow>
      )}

      {isEditable && currentValue != null ? (
        <>
          <div className="border-t border-zinc-800 my-0.5" />
          {canSingle && (
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950/70 p-1">
              <ScopeButton active={scope === 'single'} onClick={() => setScope('single')}>This pad</ScopeButton>
              <ScopeButton active={scope === 'group'} onClick={() => setScope('group')}>Same tool</ScopeButton>
            </div>
          )}
          <label className="text-xs text-zinc-500">{isDrill ? 'New diameter' : 'New size'} (mm)</label>
          <InlineEdit
            initialMm={currentValue}
            onApply={(v) => {
              if (isDrill) onHoleDiameterChange(layerId, padDef.defId, v);
              else if (editingSingle) onSinglePadSizeChange(layerId, padDef.defId, selectedInstanceId!, v);
              else onPadSizeChange(layerId, padDef.defId, v);
            }}
            applyLabel={editingSingle ? 'Apply pad' : `Apply to all ${instanceCount}`}
          />
        </>
      ) : (
        <p className="text-xs text-zinc-600 italic">Complex macro - not editable</p>
      )}

      {isCopper && linkedMatch && (
        <>
          <div className="border-t border-zinc-800 my-0.5" />
          <label className="text-xs text-zinc-500">Matched drill tool diameter (mm)</label>
          <InlineEdit
            initialMm={linkedMatch.hole.diameterMm}
            onApply={(v) => onHoleDiameterChange(linkedMatch.hole.layerId, linkedMatch.hole.defId, v)}
            applyLabel="Apply hole tool"
          />
        </>
      )}
    </div>
  );
}

function TraceEditor({ traceClass, layerId, pathId, onTraceWidthChange, onSingleTraceWidthChange }: {
  traceClass: TraceClass;
  layerId: string;
  pathId: string | undefined;
  onTraceWidthChange: (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onSingleTraceWidthChange: (layerId: string, pathId: string, newWidthMm: number) => void;
}) {
  const [scope, setScope] = useState<'single' | 'group'>(pathId ? 'single' : 'group');
  const editingSingle = scope === 'single' && pathId;

  return (
    <div className="flex flex-col gap-2">
      <InfoRow label="Width">{traceClass.widthMm.toFixed(3)} mm</InfoRow>
      <InfoRow label="Count">{traceClass.instanceCount} traces</InfoRow>
      {pathId && (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-950/70 p-1">
          <ScopeButton active={scope === 'single'} onClick={() => setScope('single')}>This trace</ScopeButton>
          <ScopeButton active={scope === 'group'} onClick={() => setScope('group')}>Same width</ScopeButton>
        </div>
      )}
      <div className="border-t border-zinc-800 my-0.5" />
      <label className="text-xs text-zinc-500">New width (mm)</label>
      <InlineEdit
        initialMm={traceClass.widthMm}
        onApply={(v) => {
          if (editingSingle) onSingleTraceWidthChange(layerId, pathId, v);
          else onTraceWidthChange(layerId, traceClass.strokeWidthRaw, v);
        }}
        applyLabel={editingSingle ? 'Apply trace' : `Apply all ${traceClass.instanceCount}`}
      />
    </div>
  );
}

function ScopeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded px-2 py-1 text-xs transition-colors',
        active ? 'bg-green-500 text-zinc-950 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function InlineEdit({ initialMm, onApply, applyLabel }: {
  initialMm: number;
  onApply: (v: number) => void;
  applyLabel: string;
}) {
  const [value, setValue] = useState(initialMm.toFixed(3));
  const [flash, setFlash] = useState(false);
  const prev = useRef(initialMm);
  if (prev.current !== initialMm) {
    prev.current = initialMm;
    setValue(initialMm.toFixed(3));
  }

  const parsed = parseFloat(value);
  const dirty = Number.isFinite(parsed) && parsed.toFixed(3) !== initialMm.toFixed(3);

  const apply = () => {
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onApply(Math.max(0.001, Math.min(99.999, parsed)));
    setFlash(true);
    setTimeout(() => setFlash(false), 600);
  };

  return (
    <div className="flex gap-1.5">
      <input
        type="number"
        min="0.001"
        max="99.999"
        step="0.001"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const v = parseFloat(value);
          setValue(!Number.isFinite(v) || v <= 0 ? initialMm.toFixed(3) : Math.max(0.001, Math.min(99.999, v)).toFixed(3));
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

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300 font-mono text-right">{children}</span>
    </div>
  );
}

function ShapeTag({ shape }: { shape: string }) {
  const cls: Record<string, string> = {
    circle: 'bg-blue-900/60 text-blue-300',
    ring: 'bg-purple-900/60 text-purple-300',
    rect: 'bg-amber-900/60 text-amber-300',
    complex: 'bg-zinc-800 text-zinc-500',
  };
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${cls[shape] ?? cls.complex}`}>{shape === 'complex' ? 'macro' : shape}</span>;
}

function PadIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="5" /><circle cx="7" cy="7" r="2" fill="currentColor" /></svg>;
}
function TraceIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 7h10" /></svg>;
}
function CloseIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2l8 8M10 2 2 10" /></svg>;
}
