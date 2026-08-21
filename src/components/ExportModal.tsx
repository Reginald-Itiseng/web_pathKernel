import { useEffect, useState } from 'react';
import JSZip from 'jszip';

export interface ExportFile {
  name: string;
  content: string;
}

export interface ExportFormatOption {
  id: string;
  label: string;
  /** Short description shown under the format's radio row. */
  description: string;
  /** File extension used in the zip's own name (no dot), e.g. "hpgl". */
  extension: string;
  /**
   * Builds the files for this format. Absent = not implemented yet (shown
   * disabled with a "coming soon" tag) — the growth point for G-code etc.
   */
  buildFiles?: () => ExportFile[];
}

interface Props {
  formats: ExportFormatOption[];
  /** Sanitized project name (derived from the loaded layer filenames), used as the zip's base name. */
  projectName: string;
  onClose: () => void;
  /** Called after a successful zip download, e.g. to show a toast. */
  onExported?: (formatLabel: string, fileCount: number) => void;
  onError?: (message: string) => void;
}

export function ExportModal({ formats, projectName, onClose, onExported, onError }: Props) {
  const [selectedId, setSelectedId] = useState(() => formats.find((f) => f.buildFiles)?.id ?? formats[0]?.id);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const selected = formats.find((f) => f.id === selectedId);

  const handleExport = async () => {
    if (!selected?.buildFiles) return;
    setExporting(true);
    try {
      const files = selected.buildFiles();
      if (files.length === 0) {
        onError?.('Nothing to export yet — generate toolpaths first.');
        return;
      }
      const zip = new JSZip();
      for (const file of files) zip.file(file.name, file.content);
      const blob = await zip.generateAsync({ type: 'blob' });

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const base = projectName.trim() || 'pathkernel';
      link.download = `${base}-${selected.extension}.zip`;
      link.click();
      URL.revokeObjectURL(url);

      onExported?.(selected.label, files.length);
      onClose();
    } catch (err) {
      onError?.(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[1px]" onClick={onClose} />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-modal-title"
          className="w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl shadow-black/60 p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 id="export-modal-title" className="text-sm font-semibold text-zinc-100">
              Export
            </h2>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-colors"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>

          <p className="text-xs text-zinc-500 mb-3">Choose a file format for the exported toolpaths.</p>

          <div className="flex flex-col gap-2 mb-4">
            {formats.map((format) => {
              const available = format.buildFiles != null;
              const active = format.id === selectedId;
              return (
                <button
                  key={format.id}
                  type="button"
                  disabled={!available}
                  onClick={() => setSelectedId(format.id)}
                  className={[
                    'text-left rounded-lg border px-3 py-2.5 transition-colors',
                    !available
                      ? 'border-zinc-800 bg-zinc-950/50 opacity-50 cursor-not-allowed'
                      : active
                        ? 'border-green-500 bg-green-500/10'
                        : 'border-zinc-700 bg-zinc-950/70 hover:border-zinc-600',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                      <span
                        className={[
                          'inline-block w-3.5 h-3.5 rounded-full border-2 shrink-0',
                          active && available ? 'border-green-400 bg-green-400' : 'border-zinc-600',
                        ].join(' ')}
                      />
                      {format.label}
                    </span>
                    {!available && (
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1 ml-5.5 pl-0">{format.description}</p>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={!selected?.buildFiles || exporting}
              className="px-4 py-1.5 text-sm font-medium text-zinc-900 bg-green-400 hover:bg-green-300 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 2l8 8M10 2 2 10" />
    </svg>
  );
}
