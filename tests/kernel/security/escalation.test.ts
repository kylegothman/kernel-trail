import { describe, expect, it } from 'vitest';
import { createKernel, type KernelImpl } from '../../../src/kernel/Kernel';
import { instructionProgram, type Program } from '../../../src/kernel/process/Program';
import { createStreamRegistry } from '../../../src/kernel/rng';
import { inodeObject } from '../../../src/kernel/security/SecuritySubsystem';
import { ACCESS_RIGHTS, effectiveRights } from '../../../src/kernel/security/acl';
import { FreeSpace } from '../../../src/kernel/fs/freeSpace';
import { asPageId, asPid, asResourceId, type DomainId, type FileDescriptor, type KernelEvent, type Pid, type SyscallName, type SyscallResult } from '../../../src/kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const user = 'domain:user_ro' as DomainId, kernelDomain = 'domain:kernel' as DomainId, driverDomain = 'domain:driver' as DomainId;
function until(kernel: KernelImpl, predicate: () => boolean, maximum = 10000): void {
  for (let i = 0; i < maximum && !predicate(); i++) kernel.step(); expect(predicate()).toBe(true);
}
function syscall(kernel: KernelImpl, pid: Pid, name: SyscallName, args: readonly (number | string | boolean)[]): SyscallResult {
  const result = kernel.syscall({ pid, name, args }), pcb = kernel.table.get(pid)!, fs = kernel.fileSystemSubsystem;
  const operation = fs.pending({ pid, tid: pcb.threads[0]! });
  if (operation === undefined) return result;
  until(kernel, () => operation.stage === 'complete'); return fs.consume(pid, pcb.threads[0]!)!;
}
function numberResult(result: SyscallResult): number {
  if (!result.ok || typeof result.value !== 'number') throw new Error(`expected integer syscall result: ${JSON.stringify(result)}`); return result.value;
}
function fixture(seed = REFERENCE_CONFIG.seed) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, seed, scheduler: 'fcfs' }, { contextSwitchTicks: 0, threadCreateTicks: 0 });
  const events: KernelEvent[] = []; kernel.events.onAny(event => events.push(event));
  const fs = kernel.fileSystemSubsystem, security = kernel.securitySubsystem;
  fs.format(); until(kernel, () => fs.mounted);
  kernel.registerProgram('privileged-binary', instructionProgram([{ kind: 'compute' }]));
  const binary = fs.createFile('/launcher', { programName: 'privileged-binary' }); until(kernel, () => !fs.busy);
  fs.bindProgram(binary, 'privileged-binary'); until(kernel, () => !fs.busy);
  const initial = numberResult(syscall(kernel, asPid(1), 'open', ['/launcher', 'rw'])) as FileDescriptor;
  fs.writeBytes(asPid(1), initial, [41, 42, 43, 44]); const initActor = { pid: asPid(1), tid: kernel.table.get(asPid(1))!.threads[0]! };
  until(kernel, () => fs.pending(initActor)?.stage === 'complete'); fs.consume(initActor.pid, initActor.tid);
  syscall(kernel, asPid(1), 'close', [initial]);
  security.setInodeDomain(fs.inodeTable.get(binary)!, kernelDomain);
  const driver = kernel.spawn({ name: 'privileged disk deputy', priority: 20, arrival: 1000000, burst: 20000, service: 20000, pages: 1 }, { program: instructionProgram([{ kind: 'compute' }]) });
  let activeProgram: Program = instructionProgram([{ kind: 'compute' }]);
  const wrapper: Program = { length: 20000, referenceString: null, at: index => activeProgram.at(index) };
  const pid = kernel.spawn({ name: 'escalation probe', priority: 10, arrival: kernel.tick + 1, burst: 20000, service: 20000, pages: 1 }, { program: wrapper });
  security.bindProcess(driver, driverDomain, ['driver']); security.bindProcess(pid, user, ['guest']);
  security.matrix.grant(user, inodeObject(fs.state().volume!.rootInode), ['read', 'execute']);
  security.matrix.grant(user, inodeObject(binary), ['read', 'execute']);
  const region = asResourceId('deputy-target'), driverPcb = kernel.table.get(driver)!;
  kernel.ipc.createSharedRegion({ id: region, space: driverPcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 7 });
  security.matrix.grant(driverDomain, region, ['owner']); security.matrix.grant(user, region, ['read']);
  expect(kernel.ipc.mmap(pid, region, false).ok).toBe(true);
  const descriptor = numberResult(syscall(kernel, pid, 'open', ['/launcher', 'r'])) as FileDescriptor;
  const start = (misPermissioned = false) => {
    if (misPermissioned) security.matrix.grant(user, inodeObject(binary), ['write']);
    activeProgram = security.createProbe({ id: 'SEC-ESCALATION-1', programName: 'escalation-probe', pid, driverPid: driver,
      region, descriptor, binaryPath: '/launcher', binaryInode: binary, binaryGeneration: fs.inodeTable.get(binary)!.generation,
      outOfRangeLength: 1000000000, delegatedValue: 99, overwriteBytes: 4,
      presentedCapability: { object: inodeObject(binary), rights: ['write'], seal: 0 } });
  };
  return { kernel, events, fs, security, pid, driver, binary, region, descriptor, start };
}

describe('security integration and the five-attempt probe', () => {
  it('SEC-ESCALATION-1 blocks five attack decisions within the unchanged 5000-tick window', () => {
    const f = fixture(); f.start(); const start = f.kernel.tick; f.kernel.run(5000);
    const probe = f.security.state().probes[0]!;
    expect(f.kernel.tick - start).toBe(5000); expect(probe.outcomes.map(row => row.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(probe.outcomes.every(row => row.blocked)).toBe(true); expect(probe.status).toBe('completed');
    expect(f.events.filter(event => event.type === 'security.escalation_attempt' && event.pid === f.pid && event.blocked)).toHaveLength(5);
    expect(f.events.some(event => event.type === 'security.escalation_attempt' && event.pid === f.pid && !event.blocked)).toBe(true);
    expect(f.kernel.table.get(f.pid)!.terminationReason).toBe('protection_fault');
    expect(f.kernel.ipc.sharedRegion(f.region)!.value).toBe(7);
    // The setuid refusal happens in open, so the probe never reaches an exec call.
    expect(f.events.some(event => event.type === 'syscall.invoked' && event.request.pid === f.pid && event.request.name === 'exec')).toBe(false);
    expect(probe.outcomes.map(row => row.result)).toMatchObject([{ errno: 'EINVAL' }, { errno: 'EINVAL' }, { errno: 'EACCES' }, { errno: 'EACCES' }, { errno: 'EPERM' }]);
    const detached = createStreamRegistry(REFERENCE_CONFIG.seed).stream('security'), material = detached.int(0, 0x100000000);
    expect(JSON.stringify(f.events)).not.toContain(String(material)); expect(JSON.stringify(f.security.saveState())).not.toContain('kernelSecret');
    expect(Object.keys(f.security)).not.toContain('kernelSecret');
  });
  it('an explicit erroneous grant permits the binary overwrite and lasting setuid exec', () => {
    const f = fixture(); f.start(true); f.kernel.run(5000);
    const probe = f.security.state().probes[0]!;
    expect(probe.outcomes.find(row => row.attempt === 4)).toMatchObject({ blocked: false, result: { ok: true } });
    expect(probe.status).toBe('compromised'); expect(f.kernel.table.get(f.pid)!.domain).toBe(kernelDomain);
    expect(f.events.some(event => event.type === 'syscall.invoked' && event.request.pid === f.pid && event.request.name === 'exec' && event.result.ok)).toBe(true);
  });
  it('SEC-ARG-1 rejects huge lengths before descriptor effects and restores caller state', () => {
    const f = fixture(), before = structuredClone(f.fs.saveState()), beforePcb = structuredClone(f.kernel.table.get(f.pid)!);
    const result = f.kernel.syscall({ pid: f.pid, name: 'read', args: [99999999, 1000000000] });
    expect(result).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(!result.ok && result.message.startsWith('address out of range: ')).toBe(true);
    expect(f.fs.saveState()).toEqual(before); expect(f.kernel.table.get(f.pid)).toEqual(beforePcb);
    expect(f.security.identity(f.pid)).toEqual({ domain: user, ring: 3 });
  });
  it('rejects page-ring access before COW, fault or frame allocation', () => {
    const kernel = createKernel(REFERENCE_CONFIG, { contextSwitchTicks: 0, threadCreateTicks: 0 });
    const pid = kernel.spawn({ name: 'protected page reader', priority: 1, arrival: 0, burst: 50, service: 50, pages: 1 },
      { program: instructionProgram([{ kind: 'access', page: asPageId(0), write: true }]) });
    kernel.securitySubsystem.bindProcess(pid, user, ['guest']); kernel.securitySubsystem.protectPage(kernel.table.get(pid)!.addressSpaceId, asPageId(0), 1);
    const events: KernelEvent[] = []; kernel.events.onAny(event => events.push(event)); kernel.run(10);
    expect(kernel.table.get(pid)!.terminationReason).toBe('protection_fault');
    expect(events.filter(event => event.type === 'memory.page_fault' || event.type === 'memory.page_loaded')).toEqual([]);
    expect(events.filter(event => event.type === 'security.access_denied')).toHaveLength(1);
  });
  it('uses captured requester authority after a later switch instead of the driver or transient kernel domain', () => {
    const f = fixture(); const result = f.kernel.syscall({ pid: f.pid, name: 'ioctl', args: ['disk0', 'write_region', f.driver, f.region, 99] });
    const requestId = numberResult(result);
    expect(f.security.state().requests.find(row => row.requestId === requestId)!.authority).toMatchObject({ domain: user, ring: 3 });
    f.security.bindProcess(f.pid, kernelDomain, ['kernel']); f.security.matrix.grant(kernelDomain, f.region, ['owner']);
    until(f.kernel, () => f.security.state().requests.find(row => row.requestId === requestId)?.delegatedWrite?.completion.kind !== 'pending');
    expect(f.kernel.ipc.sharedRegion(f.region)!.value).toBe(7);
    expect(f.events.filter(event => event.type === 'security.access_denied' && event.object === f.region)).toContainEqual(expect.objectContaining({ domain: user, right: 'write' }));
  });
  it('restores source-seed capability seals, roles and a nonempty trap stack without advancing live RNG', () => {
    const source = fixture(), trap = source.security.enterTrap(source.pid)!; source.security.use(source.pid, inodeObject(source.binary), 'read');
    // A workload-free destination keeps kernel.snapshot() available, which is the public view of every live stream.
    const saved = source.security.saveState(), destination = createKernel({ ...REFERENCE_CONFIG, seed: 999 }), rng = destination.snapshot().rng;
    const restored = destination.securitySubsystem;
    restored.prepareRestore(saved, REFERENCE_CONFIG.seed)();
    expect(destination.snapshot().rng).toEqual(rng);
    expect(restored.saveState().payload.processes).toEqual(saved.payload.processes);
    expect(restored.matrix.check(user, inodeObject(source.binary), 'read')).toBe(true);
    restored.returnTrap(source.pid, trap); source.security.returnTrap(source.pid, trap);
    expect(restored.identity(source.pid)).toEqual(source.security.identity(source.pid));
  });
  it('validates both owner payloads before restoring a pending read with nonzero offset and saved trap', () => {
    const source = fixture(), destination = fixture();
    expect(syscall(source.kernel, source.pid, 'seek', [source.descriptor, 1, 0])).toEqual({ ok: true, value: 1 });
    source.kernel.syscall({ pid: source.pid, name: 'read', args: [source.descriptor, 2] });
    const actor = { pid: source.pid, tid: source.kernel.table.get(source.pid)!.threads[0]! };
    const pending = source.fs.pending(actor)!; expect(pending.stage).not.toBe('complete');
    const trap = source.security.enterTrap(source.pid)!;
    const fs = source.fs.saveState(), security = source.security.saveState(), storage = source.kernel.storageSubsystem.saveState(), io = source.kernel.ioSubsystem.saveState().io;
    expect(fs.payload.descriptors.find(row => row.fd === source.descriptor)!.offset).toBe(1);
    const commits = [destination.kernel.storageSubsystem.prepareRestore(storage), destination.kernel.ioSubsystem.prepareRestore(io),
      destination.fs.prepareRestore(fs), destination.security.prepareRestore(security, REFERENCE_CONFIG.seed)];
    for (const commit of commits) commit();
    source.security.returnTrap(source.pid, trap); destination.security.returnTrap(destination.pid, trap);
    until(source.kernel, () => source.fs.pending(actor)?.stage === 'complete');
    until(destination.kernel, () => destination.fs.pending(actor)?.stage === 'complete');
    const copied = destination.fs.pending(actor)!;
    expect(copied.contents).toEqual([42, 43]); expect(copied.result).toEqual(pending.result);
    expect(destination.fs.state().descriptors.find(row => row.fd === source.descriptor)!.offset).toBe(3);
    expect(destination.security.identity(destination.pid)).toEqual({ domain: user, ring: 3 });
  });
  it('SEC-RING-1 answers ioctl set_ring with EINVAL and exactly one blocked ring 3 to ring 0 decision', () => {
    const f = fixture(), before = structuredClone(f.security.saveState().payload.processes), count = f.events.length;
    expect(f.kernel.syscall({ pid: f.pid, name: 'ioctl', args: ['kernel', 'set_ring', 0] })).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(f.events.slice(count).filter(event => event.type === 'security.escalation_attempt' && event.blocked))
      .toEqual([expect.objectContaining({ pid: f.pid, fromRing: 3, toRing: 0, blocked: true })]);
    expect(f.security.identity(f.pid)).toEqual({ domain: user, ring: 3 }); expect(f.security.saveState().payload.processes).toEqual(before);
  });
  it('an explicit same-ring domain switch through ioctl emits fromRing equal to toRing with blocked false', () => {
    const operator = 'domain:user' as DomainId, spool = 'domain:spool' as DomainId;
    const f = fixture(); f.security.bindProcess(f.pid, operator, ['operator']); f.security.matrix.grant(operator, spool, ['control']);
    const count = f.events.length;
    expect(f.kernel.syscall({ pid: f.pid, name: 'ioctl', args: ['kernel', 'domain_switch', spool] })).toEqual({ ok: true, value: null });
    expect(f.events.slice(count).filter(event => event.type === 'security.escalation_attempt' && event.pid === f.pid)).toEqual([
      expect.objectContaining({ fromRing: 3, toRing: 0, blocked: false }),
      expect.objectContaining({ fromRing: 3, toRing: 3, blocked: false }),
      expect.objectContaining({ fromRing: 0, toRing: 3, blocked: false })]);
    expect(f.security.identity(f.pid)).toEqual({ domain: spool, ring: 3 }); expect(f.kernel.table.get(f.pid)!.domain).toBe(spool);
    const g = fixture(); g.security.bindProcess(g.pid, operator, ['operator']);
    expect(g.kernel.syscall({ pid: g.pid, name: 'ioctl', args: ['kernel', 'domain_switch', spool] })).toMatchObject({ ok: false, errno: 'EACCES' });
    expect(g.security.identity(g.pid)).toEqual({ domain: operator, ring: 3 });
  });
  it('SEC-LEASTPRIV-1 charges a kernel-domain worker strictly more privilege excess than a correctly scoped one', () => {
    const run = (scoped: boolean) => {
      const f = fixture(); if (!scoped) f.security.bindProcess(f.pid, kernelDomain, ['kernel']);
      const fd = numberResult(syscall(f.kernel, f.pid, 'open', ['/launcher', 'r'])) as FileDescriptor;
      expect(syscall(f.kernel, f.pid, 'read', [fd, 2])).toEqual({ ok: true, value: 2 }); syscall(f.kernel, f.pid, 'close', [fd]);
      const state = f.security.state(), process = state.processes.find(row => row.pid === f.pid)!;
      const held = state.domains.find(row => row.id === process.domain)!.rights.flatMap(cell => effectiveRights(cell.rights).map(right => `${f.pid}:${cell.object}:${right}`));
      const unused = held.filter(pair => !process.usedRights.some(used => `${f.pid}:${used.object}:${used.right}` === pair));
      return { excess: f.security.excess(), pid: f.pid, unused };
    };
    const scoped = run(true), unscoped = run(false);
    expect(scoped.unused.length).toBeGreaterThan(0); expect(unscoped.excess.byPid.get(unscoped.pid)!).toBeGreaterThan(scoped.excess.byPid.get(scoped.pid)!);
    expect(unscoped.excess.total).toBeGreaterThan(scoped.excess.total);
    for (const result of [scoped, unscoped]) expect(result.excess.unusedRights.filter(pair => pair.startsWith(`${result.pid}:`)).sort()).toEqual([...result.unused].sort());
  });
  it('round-trips a nested tree, open offsets, an uncommitted transaction, both authority views and a trap stack into a fresh pair', () => {
    const source = fixture(), destination = fixture(), init = asPid(1);
    const initActor = { pid: init, tid: source.kernel.table.get(init)!.threads[0]! };
    for (const [path, kind] of [['/a', 'directory'], ['/a/b', 'directory'], ['/a/b/c', 'file']] as const) { source.fs.createFile(path, { kind }); until(source.kernel, () => !source.fs.busy); }
    const fd = numberResult(syscall(source.kernel, init, 'open', ['/a/b/c', 'rw'])) as FileDescriptor;
    source.fs.writeBytes(init, fd, [1, 2, 3, 4]); until(source.kernel, () => source.fs.pending(initActor)?.stage === 'complete'); source.fs.consume(init, initActor.tid);
    expect(syscall(source.kernel, init, 'seek', [fd, 2, 0])).toEqual({ ok: true, value: 2 });
    expect(source.kernel.syscall({ pid: init, name: 'mkdir', args: ['/a/d'] }).ok).toBe(true);
    const pending = source.fs.pending(initActor)!;
    until(source.kernel, () => source.fs.state().journal.transactions.find(row => row.operationId === pending.id)?.stage === 'barrier1');
    const trap = source.security.enterTrap(source.pid)!;
    const fs = source.fs.saveState(), security = source.security.saveState(), storage = source.kernel.storageSubsystem.saveState(), io = source.kernel.ioSubsystem.saveState().io;
    const material = createStreamRegistry(REFERENCE_CONFIG.seed).stream('security').int(0, 0x100000000);
    for (const payload of [JSON.stringify(fs), JSON.stringify(security)]) { expect(payload).not.toContain('kernelSecret'); expect(payload).not.toContain(String(material)); }
    expect(security.payload.acl.length).toBeGreaterThan(0); expect(security.payload.capabilities.some(row => row.entries.length > 0)).toBe(true);
    expect(security.payload.processes.find(row => row.pid === source.pid)!.traps).toHaveLength(1);
    expect(fs.payload.descriptors.find(row => row.fd === fd)!.offset).toBe(2);
    expect(fs.payload.journal.transactions.some(row => row.stage === 'barrier1')).toBe(true);
    const commits = [destination.kernel.storageSubsystem.prepareRestore(storage), destination.kernel.ioSubsystem.prepareRestore(io),
      destination.fs.prepareRestore(fs), destination.security.prepareRestore(security, REFERENCE_CONFIG.seed)];
    for (const commit of commits) commit();
    const resolved = (f: typeof source) => { const result = f.fs.resolve('/a/b/c', init); return result.ok ? { id: result.inode.id, generation: result.inode.generation } : result; };
    expect(resolved(destination)).toEqual(resolved(source)); expect(destination.fs.state().descriptors.find(row => row.fd === fd)!.offset).toBe(2);
    const nextFree = (f: typeof source) => { const state = f.fs.state(), free = new FreeSpace(state.volume!.blockCount, state.settings.freeSpaceMethod); free.restore(state.metadata.freeSpace); return free.allocate(1); };
    expect(nextFree(destination)).toEqual(nextFree(source));
    const objects = new Set(security.payload.domains.flatMap(row => row.rights.map(cell => cell.object)));
    for (const model of ['acl', 'capability'] as const) {
      source.security.matrix.switchModel(model); destination.security.matrix.switchModel(model);
      for (const row of security.payload.domains) for (const object of objects) for (const right of ACCESS_RIGHTS)
        expect(destination.security.matrix.check(row.id, object, right)).toBe(source.security.matrix.check(row.id, object, right));
    }
    expect(destination.security.state().processes.find(row => row.pid === source.pid)!.traps).toHaveLength(1);
    destination.security.returnTrap(source.pid, trap); source.security.returnTrap(source.pid, trap);
    expect(destination.security.identity(source.pid)).toEqual(source.security.identity(source.pid));
    for (const f of [source, destination]) { f.fs.crash(); f.fs.consume(init, initActor.tid); f.fs.recover(); until(f.kernel, () => f.fs.state().recovery === null); }
    expect(destination.fs.resolve('/a/d', init).ok).toBe(source.fs.resolve('/a/d', init).ok); expect(source.fs.resolve('/a/d', init).ok).toBe(false);
    expect(destination.fs.state().journal.transactions.map(row => [row.id, row.stage])).toEqual(source.fs.state().journal.transactions.map(row => [row.id, row.stage]));
    expect(resolved(destination)).toEqual(resolved(source));
  });
  it('rejects malformed security authority without partially applying the replacement', () => {
    const f = fixture(), before = f.security.saveState(), invalid = structuredClone(before);
    const corrupted = { ...invalid, payload: { ...invalid.payload, pageProtection: [{ space: 1, page: 0, requiredRing: 7 }] } };
    expect(() => f.security.prepareRestore(corrupted as unknown as typeof invalid, REFERENCE_CONFIG.seed)).toThrow();
    expect(f.security.saveState()).toEqual(before);
  });
});
