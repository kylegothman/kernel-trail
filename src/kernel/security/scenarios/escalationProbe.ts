import type { Program, Instruction } from '../../process/Program';
import type { FileDescriptor, SecuritySnapshotState, SyscallName, SyscallResult, Tick, Pid, FsOperationSnapshot } from '../../types';
import type { EmittableEvent } from '../../EventBus';
import type { MutableSecurityPayload } from '../accessMatrix';
export type Probe = MutableSecurityPayload['probes'][number];
export interface ProbeHost {
  probeTick(): Tick;
  probeOperation(id: number): FsOperationSnapshot | undefined;
  probeConsume(pid: Pid): void;
  probeTerminate(pid: Pid): void;
  probeCompromised(pid: Pid): boolean;
  emit(event: EmittableEvent): void;
}
/** WP-11 decoder recreates this closure from the persisted probe id and stage. at() has no side effects. */
export function probeProgram(probe: SecuritySnapshotState['payload']['probes'][number]): Program {
  return { length: 10000, referenceString: null, at: (): Instruction => {
    const call = (name: SyscallName, args: readonly (number | string | boolean)[]): Instruction => ({ kind: 'syscall', call: { pid: probe.pid, name, args } });
    if (probe.pendingOperation?.kind === 'io' || probe.status !== 'active') return { kind: 'compute' };
    switch (probe.stage) {
      case 'ring_write': return call('ioctl', ['kernel', 'set_ring', 0]);
      case 'argument_bounds': return call('read', [probe.descriptor, probe.outOfRangeLength]);
      case 'deputy_write': return call('ioctl', ['disk0', 'write_region', probe.driverPid, probe.region, probe.delegatedValue]);
      case 'binary_open': return call('open', [probe.binaryPath, 'w']);
      case 'binary_write': return call('write', [probe.overwriteDescriptor!, probe.overwriteBytes]);
      case 'binary_exec': return call('exec', [probe.binaryPath]);
      case 'capability_forgery': return call('ioctl', ['kernel', 'capability_access', probe.presentedCapability.object, probe.presentedCapability.rights.join(','), probe.presentedCapability.seal, 'write']);
      case 'finished': return { kind: 'compute' };
    }
  } };
}
export function observeProbeResult(host: ProbeHost, probe: Probe, result: SyscallResult, completion: boolean): void {
  if (probe.status !== 'active') return;
  const stage = probe.stage;
  if (stage === 'deputy_write' && !completion && result.ok) return;
  if (stage === 'binary_open' && result.ok) { if (typeof result.value !== 'number') throw new Error('file open did not return a descriptor'); probe.overwriteDescriptor = result.value as FileDescriptor; probe.stage = 'binary_write'; return; }
  if (stage === 'binary_write' && result.ok) { probe.stage = 'binary_exec'; return; }
  const attempt = stage === 'ring_write' ? 1 : stage === 'argument_bounds' ? 2 : stage === 'deputy_write' ? 3
    : stage === 'capability_forgery' ? 5 : 4;
  if (probe.outcomes.some(row => row.attempt === attempt)) return;
  const blocked = !result.ok;
  // Ring writes and presented-capability checks already emit their own decision.
  const emitted = stage === 'ring_write' || stage === 'capability_forgery';
  if (!emitted) host.emit({ type: 'security.escalation_attempt', pid: probe.pid, fromRing: 3, toRing: 0, blocked });
  probe.outcomes.push({ attempt, tick: host.probeTick(), result: structuredClone(result), blocked, decisionEmitted: true });
  probe.stage = attempt === 1 ? 'argument_bounds' : attempt === 2 ? 'deputy_write' : attempt === 3 ? 'binary_open' : attempt === 4 ? 'capability_forgery' : 'finished';
  if (attempt === 4 && result.ok && host.probeCompromised(probe.pid)) probe.status = 'compromised';
}
export function advanceProbe(host: ProbeHost, probe: Probe): void {
  if (probe.pendingOperation?.kind === 'fs') {
    const op = host.probeOperation(probe.pendingOperation.operationId);
    if (op?.stage !== 'complete' || op.result === null || !op.instructionRetired) return;
    probe.pendingOperation = null; observeProbeResult(host, probe, op.result, true);
    // The original call stays visible until Kernel has consumed and retired it.
  }
  if (probe.stage === 'finished' && probe.status === 'active') { probe.status = 'completed'; host.probeTerminate(probe.pid); }
}
