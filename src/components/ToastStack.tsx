import { useEffect } from 'react';

export interface Toast {
  id: number;
  tone: 'info' | 'warn' | 'error';
  message: string;
}

const AUTO_DISMISS_MS = 8000;

/** Transient notifications for kernel warnings (min-gap, skipped holes, …). */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      window.setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-96 max-w-[90vw]">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-sm',
            toast.tone === 'error'
              ? 'bg-red-950/90 border-red-800 text-red-200'
              : toast.tone === 'warn'
                ? 'bg-amber-950/90 border-amber-800 text-amber-200'
                : 'bg-zinc-900/90 border-zinc-700 text-zinc-300',
          ].join(' ')}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
