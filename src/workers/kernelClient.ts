/**
 * Promise API over the kernel worker. Singleton worker, monotonically
 * increasing job ids; results for superseded jobs are dropped (regenerating
 * while a job is running cancels-by-ignoring the older one).
 */
import type { KernelJobInput, KernelJobResult, KernelProgress } from '../kernel/types';
import type { KernelWorkerRequest, KernelWorkerResponse } from './kernel.worker';

interface PendingJob {
  resolve: (result: KernelJobResult) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: KernelProgress) => void;
}

let worker: Worker | null = null;
let nextJobId = 1;
let latestJobId = 0;
const pending = new Map<number, PendingJob>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<KernelWorkerResponse>) => {
    const message = event.data;
    const job = pending.get(message.id);
    if (!job) return;
    if (message.type === 'progress') {
      if (message.id === latestJobId) job.onProgress?.({ stage: message.stage, pct: message.pct });
      return;
    }
    pending.delete(message.id);
    if (message.id !== latestJobId) return; // superseded — drop silently
    if (message.type === 'result') job.resolve(message.result);
    else job.reject(new Error(message.message));
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || 'Kernel worker crashed');
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function runKernelJobInWorker(
  input: KernelJobInput,
  onProgress?: (progress: KernelProgress) => void,
): Promise<KernelJobResult> {
  const id = nextJobId++;
  latestJobId = id;
  return new Promise<KernelJobResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const request: KernelWorkerRequest = { id, type: 'run-job', input };
    getWorker().postMessage(request);
  });
}

export function isKernelJobCurrent(id: number): boolean {
  return id === latestJobId;
}
