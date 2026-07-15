/**
 * Web worker shell around the kernel orchestrator. All heavy Clipper work
 * happens here so the UI thread stays responsive.
 */
import { runKernelJob } from '../kernel/index';
import type { KernelJobInput } from '../kernel/types';

export interface KernelWorkerRequest {
  id: number;
  type: 'run-job';
  input: KernelJobInput;
}

export type KernelWorkerResponse =
  | { id: number; type: 'progress'; stage: string; pct: number }
  | { id: number; type: 'result'; result: Awaited<ReturnType<typeof runKernelJob>> }
  | { id: number; type: 'error'; message: string };

self.onmessage = (event: MessageEvent<KernelWorkerRequest>) => {
  const { id, type, input } = event.data;
  if (type !== 'run-job') return;
  void (async () => {
    try {
      const result = await runKernelJob(input, ({ stage, pct }) => {
        const progress: KernelWorkerResponse = { id, type: 'progress', stage, pct };
        self.postMessage(progress);
      });
      const response: KernelWorkerResponse = { id, type: 'result', result };
      self.postMessage(response);
    } catch (err) {
      const response: KernelWorkerResponse = {
        id,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  })();
};
