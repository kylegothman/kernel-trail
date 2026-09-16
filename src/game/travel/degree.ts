import type { createKernel, Pid, Tick } from '@kernel/index';

type DegreeKernel = ReturnType<typeof createKernel>;
export interface DegreeMovements {
  readonly admitted: readonly Pid[];
  readonly suspended: readonly Pid[];
}
export interface DegreeChange extends DegreeMovements {
  readonly from: number;
  readonly to: number;
  /** R7: admission is global; report movement outside the workload too. */
  readonly groups: { readonly workload: DegreeMovements; readonly convoy: DegreeMovements; readonly other: DegreeMovements };
}
export class DegreeController {
  readonly ceiling: number;
  private degree: number;
  private readonly workload: ReadonlySet<Pid>;
  private readonly convoy: ReadonlySet<Pid>;
  constructor(private readonly kernel: DegreeKernel, workloadPids: readonly Pid[], initial: number, convoyPids: readonly Pid[] = []) {
    this.ceiling = kernel.memorySubsystem.pager.control.maximumDegree;
    this.degree = this.clamp(initial);
    this.workload = new Set(workloadPids);
    this.convoy = new Set(convoyPids);
    for (const pid of workloadPids) {
      if (this.convoy.has(pid) || kernel.process(pid)?.convoyMemberId != null) throw new Error('A convoy pid cannot be classified as workload');
    }
  }
  get current(): number {
    this.degree = this.kernel.memorySubsystem.pager.control.degreeOfMultiprogramming;
    return this.degree;
  }
  private clamp(target: number): number {
    if (!Number.isFinite(target)) throw new RangeError('Degree must be finite');
    return Math.max(1, Math.min(this.ceiling, Math.trunc(target)));
  }
  set(target: number, _at: Tick): DegreeChange {
    const from = this.current;
    const to = this.clamp(target);
    const before = this.kernel.invariantState();
    const states = new Map(before.processes.filter(p => p.pid > 1).map(p => [p.pid, before.suspended(p.pid)]));
    this.kernel.setDegreeOfMultiprogramming(to);
    this.degree = to;
    const after = this.kernel.invariantState();
    const groups = {
      workload: { admitted: [] as Pid[], suspended: [] as Pid[] },
      convoy: { admitted: [] as Pid[], suspended: [] as Pid[] },
      other: { admitted: [] as Pid[], suspended: [] as Pid[] },
    };
    for (const [pid, wasSuspended] of [...states].sort(([a], [b]) => a - b)) {
      const suspended = after.suspended(pid);
      if (wasSuspended === suspended) continue;
      const process = this.kernel.process(pid);
      const group = this.workload.has(pid) ? groups.workload
        : this.convoy.has(pid) || process?.convoyMemberId != null ? groups.convoy : groups.other;
      group[suspended ? 'suspended' : 'admitted'].push(pid);
    }
    return { from, to, ...groups.workload, groups };
  }
  framesAvailableToConvoy(totalFrames: number): number {
    const view = this.kernel.invariantState();
    let demand = 0;
    for (const pid of [...this.workload].sort((a, b) => a - b)) {
      const process = this.kernel.process(pid);
      if (process !== undefined && !['new', 'zombie', 'terminated'].includes(process.state) && !view.suspended(pid)) {
        demand += view.metrics.memory.workingSets.get(pid) ?? 0;
      }
    }
    return totalFrames - demand;
  }
}
