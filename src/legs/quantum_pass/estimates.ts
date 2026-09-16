/**
 * KERNEL TRAIL: Quantum Pass, burst estimates by exponential averaging.
 *
 * Sim spec 5.3: tau[n+1] = alpha * t[n] + (1 - alpha) * tau[n], alpha 0.5,
 * tau[0] the declared burst. The kernel keeps the same average inside its
 * shortest-job policy (src/kernel/scheduler/sjf.ts, `recordBurst`), but a leg
 * has no accessor for it, so the depot computes the same series from the
 * event log: a process's observed bursts are the CPU intervals it actually
 * held, read from `context.switch` and `process.exited`. The prediction is
 * honest arithmetic over real history, which is exactly why it is wrong on a
 * Program whose behaviour changed.
 */
import type { KernelEvent, Pid } from '@kernel/types';

export const ALPHA = 0.5;

export interface BurstEstimate {
  readonly pid: Pid;
  readonly name: string;
  readonly declared: number;
  readonly observed: readonly number[];
  readonly estimate: number;
  /** The last observed burst, the one the estimate was supposed to predict. */
  readonly actual: number | null;
  /**
   * The worst the prediction ever was, as a fraction of the burst it was
   * predicting: the largest `|tau(n) - t(n)| / t(n)` over the history. This is
   * what the depot would have sold at the moment it was most wrong, which is
   * the only figure that says anything about a Program that changed behaviour.
   * Null with no history.
   */
  readonly error: number | null;
}

/** The series of estimates, one per observed burst, starting from the declared burst. */
export function exponentialAverage(declared: number, observed: readonly number[], alpha = ALPHA): readonly number[] {
  const series: number[] = [declared];
  let tau = declared;
  for (const actual of observed) {
    tau = alpha * actual + (1 - alpha) * tau;
    series.push(tau);
  }
  return series;
}

/** The CPU intervals each process held, in order, from the log. */
export function observedBursts(events: readonly KernelEvent[]): ReadonlyMap<Pid, readonly number[]> {
  const bursts = new Map<Pid, number[]>();
  let running: Pid | null = null;
  let since = 0;
  const close = (end: number): void => {
    if (running === null || end <= since) return;
    const list = bursts.get(running) ?? [];
    list.push(end - since);
    bursts.set(running, list);
  };
  for (const event of events) {
    if (event.type === 'context.switch') {
      close(event.tick - 1);
      running = event.to;
      since = event.tick - 1;
    } else if (event.type === 'process.exited' && running === event.pid) {
      close(event.tick);
      running = null;
    }
  }
  return bursts;
}

export function burstEstimates(events: readonly KernelEvent[], declared: ReadonlyMap<Pid, { readonly name: string; readonly burst: number }>): readonly BurstEstimate[] {
  const observed = observedBursts(events);
  const rows: BurstEstimate[] = [];
  for (const [pid, spec] of [...declared].sort((a, b) => a[0] - b[0])) {
    const history = observed.get(pid) ?? [];
    const series = exponentialAverage(spec.burst, history);
    const estimate = series[series.length - 1] ?? spec.burst;
    const actual = history.at(-1) ?? null;
    let error: number | null = null;
    history.forEach((observedBurst, index) => {
      if (observedBurst === 0) return;
      const predicted = series[index] ?? spec.burst;
      const relative = Math.abs(predicted - observedBurst) / observedBurst;
      if (error === null || relative > error) error = relative;
    });
    rows.push({ pid, name: spec.name, declared: spec.burst, observed: history, estimate, actual, error });
  }
  return rows;
}
