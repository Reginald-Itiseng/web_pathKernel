import React, { useCallback, useRef, useState } from 'react';

const ACCEPTED = '.gbr,.gtl,.gbl,.gts,.gbs,.ger,.art,.gto,.gbo,.gko,.drl';
const DISPLAY_EXTS = ['.gbr', '.gtl', '.gbl', '.gts', '.gbs', '.ger', '.art'];

interface Props {
  onFile: (file: File) => void;
}

export function GerberDropzone({ onFile }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFile(file);
      e.target.value = '';
    },
    [onFile],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Drop Gerber file or click to browse"
      className={[
        'flex flex-col items-center justify-center h-full rounded-xl border-2 border-dashed',
        'transition-colors duration-150 cursor-pointer select-none outline-none',
        'focus-visible:ring-2 focus-visible:ring-green-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
        dragOver
          ? 'border-green-400 bg-green-400/5'
          : 'border-zinc-700 hover:border-zinc-500',
      ].join(' ')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
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
          Drop a Gerber file here
        </p>
        <p className="text-zinc-400 text-sm mb-6">or click to browse</p>
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
