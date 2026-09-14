import type { EmittableEvent } from '../EventBus';
import type { DeviceId, InodeId, IoSnapshotState, Pid, Tick } from '../types';
import { check, compareText, validInteger } from './drivers/DeviceDriver';
import type { Mutable } from './drivers/DeviceDriver';

type State = IoSnapshotState['payload']['spools'][number];
export type SpoolJob = State['jobs'][number];
export interface SpoolHost {
  tick(): Tick;
  nextJob(): number;
  emit(event: EmittableEvent): void;
  output(device: DeviceId, bytes: readonly number[]): void;
  complete(job: SpoolJob): void;
}
export class Spooler {
  private states: Mutable<State>[] = [];
  constructor(private readonly host: SpoolHost) {}
  configure(device: DeviceId, enabled: boolean): void {
    const found = this.states.find(row => row.device === device);
    if (found !== undefined) { found.enabled = enabled; return; }
    this.states.push({ device, enabled, jobs: [], activeJobId: null, lastWriterJobId: null });
    this.states.sort((a, b) => compareText(a.device, b.device));
  }
  submit(device: DeviceId, owner: SpoolJob['owner'], outputInode: InodeId, contents: readonly number[], requestId: number | null = null): number {
    const state = this.require(device); const id = this.host.nextJob();
    check(contents.length > 0 && contents.every(byte => validInteger(byte) && byte <= 255), 'spool bytes');
    state.jobs.push({ id, owner: structuredClone(owner), outputInode, submittedAtTick: this.host.tick(), contents: [...contents], offset: 0, requestId, corruptionEmitted: false });
    return id;
  }
  step(): void {
    for (const state of this.states) {
      if (state.jobs.length === 0) { state.activeJobId = null; continue; }
      const previous = state.jobs.findIndex(job => job.id === state.activeJobId);
      const job = state.jobs[state.enabled ? 0 : (previous + 1) % state.jobs.length]; check(job !== undefined, 'spool head');
      state.activeJobId = job.id;
      if (!state.enabled && state.lastWriterJobId !== null && state.lastWriterJobId !== job.id) {
        const prior = state.jobs.find(row => row.id === state.lastWriterJobId);
        if (prior !== undefined && prior.offset < prior.contents.length) {
          for (const ruined of [prior, job]) if (!ruined.corruptionEmitted) {
            ruined.corruptionEmitted = true; this.host.emit({ type: 'fs.corruption', inode: ruined.outputInode, recoverable: false });
          }
        }
      }
      const byte = job.contents[job.offset]; check(byte !== undefined, 'spool offset');
      this.host.output(state.device, [byte]); job.offset += 1; state.lastWriterJobId = job.id;
      if (job.offset === job.contents.length) { this.host.complete(structuredClone(job)); state.jobs = state.jobs.filter(row => row.id !== job.id); state.activeJobId = null; }
    }
  }
  removeWaiter(pid: Pid): void {
    for (const state of this.states) {
      state.jobs = state.jobs.filter(job => job.owner.kind !== 'actor' || job.owner.actor.pid !== pid);
      if (!state.jobs.some(job => job.id === state.activeJobId)) state.activeJobId = null;
    }
  }
  reset(device: DeviceId): void {
    const state = this.states.find(row => row.device === device);
    if (state !== undefined) { state.jobs.length = 0; state.activeJobId = null; state.lastWriterJobId = null; }
  }
  snapshot(): readonly State[] { return structuredClone(this.states); }
  restore(states: readonly State[]): void {
    check(new Set(states.map(state => state.device)).size === states.length, 'duplicate spool');
    const ids = new Set<number>();
    for (const state of states) {
      check(typeof state.enabled === 'boolean' && (state.activeJobId === null || state.jobs.some(job => job.id === state.activeJobId)), 'spool active job');
      for (const job of state.jobs) {
      check(validInteger(job.id, 1) && !ids.has(job.id) && validInteger(job.offset) && job.offset < job.contents.length, 'spool continuation'); ids.add(job.id);
      check(job.contents.every(byte => validInteger(byte) && byte <= 255) && validInteger(job.outputInode) && typeof job.corruptionEmitted === 'boolean', 'spool contents');
      }
    }
    this.states = structuredClone(states) as Mutable<State>[];
  }
  private require(device: DeviceId): Mutable<State> { const state = this.states.find(row => row.device === device); check(state !== undefined, 'missing spool'); return state; }
}
