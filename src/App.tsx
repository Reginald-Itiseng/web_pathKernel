import { useState, useCallback } from 'react';
import { GerberDropzone } from './components/GerberDropzone';
import { GerberPreview } from './components/GerberPreview';
import { LayerInfo } from './components/LayerInfo';
import { parseGerber, type ParseResult } from './utils/gerberUtils';
import { LAYER_COLORS, detectLayerType } from './utils/layerUtils';

interface AppState {
  file: File | null;
  result: ParseResult | null;
  error: string | null;
  loading: boolean;
}

const INITIAL: AppState = {
  file: null,
  result: null,
  error: null,
  loading: false,
};

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);

  const handleFile = useCallback(async (file: File) => {
    setState({ file, result: null, error: null, loading: true });

    try {
      const content = await readFileAsText(file);
      const layerType = detectLayerType(file.name);
      const color = LAYER_COLORS[layerType];
      const result = await parseGerber(content, color);
      setState({ file, result, error: null, loading: false });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown parse error';
      setState({ file, result: null, error: message, loading: false });
    }
  }, []);

  const handleClear = useCallback(() => {
    setState(INITIAL);
  }, []);

  const { file, result, error, loading } = state;
  const hasFile = file !== null;

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-5 h-12 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-2">
          <PcbIcon className="w-5 h-5 text-green-400" />
          <span className="font-semibold text-zinc-100 tracking-tight">
            PCB Mill CAM
          </span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-400">
          Phase 1 — Preview
        </span>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — only shown once a file is loaded */}
        {hasFile && result && (
          <div className="shrink-0 w-60 border-r border-zinc-800 bg-zinc-950 p-4 overflow-y-auto">
            <LayerInfo file={file} result={result} />
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 p-4 overflow-hidden">
          {loading && <LoadingState />}

          {!loading && error && (
            <ErrorState message={error} onClear={handleClear} />
          )}

          {!loading && !error && result && (
            <GerberPreview result={result} onClear={handleClear} />
          )}

          {!loading && !error && !result && (
            <GerberDropzone onFile={handleFile} />
          )}
        </main>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="w-9 h-9 rounded-full border-2 border-green-400 border-t-transparent animate-spin" />
      <p className="text-zinc-400 text-sm">Parsing Gerber file…</p>
    </div>
  );
}

function ErrorState({
  message,
  onClear,
}: {
  message: string;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-center px-8">
      <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
        <span className="text-red-400 text-xl">!</span>
      </div>
      <div>
        <p className="text-zinc-200 font-semibold mb-2">Failed to parse file</p>
        <p className="text-zinc-400 text-sm font-mono bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 max-w-md break-all">
          {message}
        </p>
      </div>
      <button
        onClick={onClear}
        className="px-5 py-2 text-sm font-medium text-zinc-900 bg-green-400 hover:bg-green-300 rounded-lg transition-colors"
      >
        Try another file
      </button>
    </div>
  );
}

function PcbIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="16" height="16" rx="2" />
      <path d="M6 6h2v2H6zM12 6h2v2h-2zM6 12h2v2H6zM12 12h2v2h-2z" />
      <path d="M8 7h4M7 8v4M13 8v4M8 13h4" />
    </svg>
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
