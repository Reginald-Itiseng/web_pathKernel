import React, { useCallback, useMemo, useRef, useState } from 'react';
import { acceptedFileExtensions } from '../utils/layerUtils';
import {
  listSampleProjects,
  loadSampleProjectFiles,
  type SampleProject,
} from '../utils/sampleProjects';

const DISPLAY_EXTS = ['.gbr', '.gtl', '.gbl', '.gko', '.drl', '.xln'];

interface Props {
  onFiles: (files: File[]) => void;
}

export function GerberDropzone({ onFiles }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const samples = useMemo(listSampleProjects, []);

  const loadSample = useCallback(async (project: SampleProject) => {
    setLoadingSample(project.name);
    try {
      onFiles(await loadSampleProjectFiles(project));
    } finally {
      setLoadingSample(null);
      setSamplesOpen(false);
    }
  }, [onFiles]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onFiles(files);
    },
    [onFiles],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length) onFiles(files);
      e.target.value = '';
    },
    [onFiles],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Drop Gerber files or click to browse"
      className={[
        'flex flex-col items-center justify-center h-full rounded-xl border-2 border-dashed',
        'transition-colors duration-150 cursor-pointer select-none outline-none',
        'focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
        dragOver
          ? 'border-green-400 bg-green-400/5'
          : 'border-zinc-700 hover:border-zinc-500',
      ].join(' ')}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={acceptedFileExtensions()}
        multiple
        className="hidden"
        onChange={handleChange}
      />

      <div className="text-center px-8 py-16 pointer-events-none">
        <UploadIcon
          className={[
            'mx-auto mb-5 w-14 h-14 transition-colors duration-150',
            dragOver ? 'text-green-400' : 'text-zinc-500',
          ].join(' ')}
        />
        <p className="text-zinc-200 text-lg font-semibold mb-2">
          Drop Gerber files here
        </p>
        <p className="text-zinc-400 text-sm mb-1">or click to browse</p>
        <p className="text-zinc-600 text-xs mb-6">You can select multiple files at once</p>
        <div className="flex flex-wrap gap-2 justify-center">
          {DISPLAY_EXTS.map((ext) => (
            <span
              key={ext}
              className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 text-xs font-mono"
            >
              {ext}
            </span>
          ))}
        </div>

        {samples.length > 0 && (
          <div className="mt-8 pointer-events-auto" onClick={(e) => e.stopPropagation()}>
            {!samplesOpen ? (
              <button
                onClick={() => setSamplesOpen(true)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700 transition-colors"
              >
                Load samples
              </button>
            ) : (
              <div className="mx-auto w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-left">
                <div className="flex items-center justify-between px-1 mb-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                    Sample projects
                  </p>
                  <button
                    onClick={() => setSamplesOpen(false)}
                    className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
                  >
                    ×
                  </button>
                </div>
                {samples.map((project) => (
                  <button
                    key={project.name}
                    disabled={loadingSample != null}
                    onClick={() => loadSample(project)}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
                  >
                    <span>{loadingSample === project.name ? 'Loading…' : project.name}</span>
                    <span className="text-xs text-zinc-500">{project.files.length} files</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="6" width="36" height="36" rx="4" />
      <path d="M24 14v16" />
      <path d="M16 22l8-8 8 8" />
      <path d="M14 34h20" />
    </svg>
  );
}
