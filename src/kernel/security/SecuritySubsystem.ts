import type { EmittableEvent } from '../EventBus';
import { KernelConfigError } from '../errors';
import { createStreams } from '../rngStreams';
import { plainData } from '../io/drivers/DeviceDriver';
import type { IoSubsystem } from '../io/IoSubsystem';
import type { FileSystemSubsystem } from '../fs/FileSystemSubsystem';
import type { Program } from '../process/Program';
import type { IpcManager, SharedMapping } from '../process/ipc';
import type { AccessRight, AddressSpaceId, BlockId, DeviceId, DomainId, FsInodeSnapshot, InodeId, IoSnapshotActor, IoSnapshotRequest,
  IoSnapshotResult, KernelEvent, KernelSnapshot, PageId, PageTableEntry, Pid, ProcessControlBlock, ProtectionDomain,
  ProtectionRing, ResourceId, Rng, SecuritySnapshotState, SyscallResult, Tick } from '../types';
import { AccessMatrix, canonicalDomain, type MutableSecurityPayload } from './accessMatrix';
import { ACCESS_RIGHTS, canonicalRights } from './acl';
import { capabilityCheck, sealCapability, verifyCapability } from './capabilities';
import { callerIdentity, commitDomainReturn, processState } from './domains';
import { Rings } from './rings';
import { defaultRoles, roleDomains, validateRoles } from './rbac';
import { privilegeExcess, recordUse } from './leastPrivilege';
import { advanceProbe, probeProgram, observeProbeResult, type Probe } from './scenarios/escalationProbe';

const domain = (value: string): DomainId => value as DomainId;
const success = (value: number | null = null): SyscallResult => ({ ok: true, value });
const denied = (message: string): SyscallResult => ({ ok: false, errno: 'EACCES', message });
const invalid = (message: string): SyscallResult => ({ ok: false, errno: 'EINVAL', message });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const inodeObject = (inode: InodeId): string => `inode:${inode}`;
export interface SecurityHost {
  tick(): Tick;
  enabled(): boolean;
  process(pid: Pid): ProcessControlBlock | undefined;
  processes(): readonly ProcessControlBlock[];
  pages(space: AddressSpaceId): readonly PageTableEntry[];
  pageSize(): number;
  actor(pid: Pid): IoSnapshotActor | undefined;
  emit(event: EmittableEvent): void;
  terminate(pid: Pid, reason: 'protection_fault' | 'storage_corruption'): void;
  publishResult(pid: Pid, result: SyscallResult): void;
  registerProgram(name: string, program: Program): void;
  io: IoSubsystem;
  ipc: IpcManager;
  fs(): FileSystemSubsystem;
}
/** Structural rather than substring: a small secret must not make ordinary tick or pid values look like a leak. */
function carriesMaterial(value: unknown, material: number): boolean {
  if (typeof value === 'number') return value === material;
  if (typeof value === 'string') return value.includes(String(material));
  if (Array.isArray(value)) return value.some(item => carriesMaterial(item, material));
  if (value !== null && typeof value === 'object') return Object.values(value).some(item => carriesMaterial(item, material));
  return false;
}
export function emptySecurityPayload(tick: Tick, accessModel: 'acl' | 'capability'): MutableSecurityPayload {
  return { tick, accessModel, nextTrapId: 1, domains: [], acl: [], capabilities: [], roles: [], processes: [], inodeDomains: [],
    pageProtection: [], sharedProtection: [], requests: [], probes: [] };
}

/** Private sealing state is deliberately outside every snapshot and view. */
export class SecuritySubsystem {
  #kernelSecret: number;
  private data: MutableSecurityPayload;
  readonly matrix: AccessMatrix;
  readonly rings: Rings;
  readonly domains: ProtectionDomain[] = [];
  constructor(private readonly host: SecurityHost, rng: Rng, accessModel: 'acl' | 'capability' = 'acl') {
    this.#kernelSecret = host.enabled() ? rng.int(0, 0x100000000) : 0;
    this.data = emptySecurityPayload(host.tick(), accessModel);
    this.matrix = new AccessMatrix(() => this.data,
      (id, object, rights) => sealCapability(object, rights, id, this.#kernelSecret),
      (id, capability) => verifyCapability(capability, id, this.#kernelSecret));
    this.rings = new Rings(this);
    if (host.enabled()) {
      for (const [id, name, ring] of [['domain:kernel', 'Kernel', 0], ['domain:driver', 'Device driver', 1],
        ['domain:system', 'System service', 2], ['domain:user_ro', 'Read-only user', 3], ['domain:user', 'User', 3], ['domain:spool', 'Spool operator', 3]] as const)
        this.matrix.defineDomain(domain(id), name, ring);
      this.data.roles = structuredClone(defaultRoles()) as MutableSecurityPayload['roles']; this.refresh();
    }
  }
  state(): SecuritySnapshotState['payload'] { return this.data; }
  emit(event: EmittableEvent): void { if (this.host.enabled()) this.host.emit(event); }
  identity(pid: Pid) { this.ensure(pid); return callerIdentity(this.data, pid); }
  callerDomain(pid: Pid): DomainId { return this.identity(pid)?.domain ?? canonicalDomain(this.host.process(pid)?.domain ?? domain('unknown')); }
  ring(pid: Pid): ProtectionRing { return this.ensure(pid).ring; }
  defineDomain(id: DomainId, name: string, ring: ProtectionRing): void {
    this.matrix.defineDomain(id, name, ring);
    if (ring === 3) { const admin = this.data.roles.find(role => role.id === 'admin'); if (admin !== undefined && !admin.domains.includes(id)) admin.domains.push(id); }
    this.refresh();
  }
  bindProcess(pid: Pid, id: DomainId, roles: readonly string[] = []): void {
    const target = this.data.domains.find(row => row.id === canonicalDomain(id)); if (target === undefined) throw new KernelConfigError('unknown security domain');
    const pcb = this.host.process(pid); if (pcb === undefined) throw new KernelConfigError('unknown security process');
    const selected = roles.length === 0 ? [target.ring === 0 ? 'kernel' : target.ring === 1 ? 'driver' : 'user'] : [...roles];
    roleDomains(this.data.roles, selected);
    let process = processState(this.data, pid);
    if (process === undefined) { process = { pid, active: !['zombie', 'terminated'].includes(pcb.state), domain: target.id, ring: target.ring, roles: selected, usedRights: [], traps: [] }; this.data.processes.push(process); }
    else { if (process.traps.length !== 0) throw new KernelConfigError('cannot bind a process inside a trap'); process.domain = target.id; process.ring = target.ring; process.roles = selected; }
    this.data.processes.sort((a, b) => a.pid - b.pid); pcb.domain = target.id;
  }
  enterTrap(pid: Pid): number | null { if (!this.host.enabled()) return null; this.ensure(pid); return this.rings.enterTrap(pid); }
  returnTrap(pid: Pid, trap: number | null): void {
    if (trap === null) return;
    const process = processState(this.data, pid); if (process === undefined || !process.active) return;
    if (process.traps.at(-1)?.id !== trap) throw new Error('I-34: trap return identity mismatch');
    this.rings.returnTrap(pid);
    if (process.traps.length === 0) {
      const pcb = this.host.process(pid);
      if (pcb !== undefined && canonicalDomain(pcb.domain) !== process.domain) pcb.domain = process.domain;
    }
  }
  check(id: DomainId, object: string, right: AccessRight): boolean {
    const result = this.matrix.check(canonicalDomain(id), object, right);
    if (!result) this.emit({ type: 'security.access_denied', domain: canonicalDomain(id), object, right }); return result;
  }
  use(pid: Pid, object: string, right: AccessRight): void { this.ensure(pid); recordUse(this.data, pid, object, right); }
  checkFile(id: DomainId, inode: FsInodeSnapshot, right: AccessRight): boolean {
    if (!this.host.enabled()) return true;
    const permitted = (right !== 'read' && right !== 'write' && right !== 'execute') || inode.permissions[right];
    if (!permitted) { this.emit({ type: 'security.access_denied', domain: canonicalDomain(id), object: inodeObject(inode.id), right }); return false; }
    return this.check(id, inodeObject(inode.id), right);
  }
  inodeCreated(inode: FsInodeSnapshot): void {
    if (!this.host.enabled()) return;
    const object = inodeObject(inode.id);
    // A reused numeric inode may not inherit the old object's grants or setuid binding.
    for (const row of this.data.domains) this.matrix.setRights(row.id, object, []);
    this.data.inodeDomains = this.data.inodeDomains.filter(row => row.inode !== inode.id);
    if (!this.data.domains.some(row => row.id === canonicalDomain(inode.owner))) return;
    this.matrix.grant(canonicalDomain(inode.owner), object, ['owner']); this.refresh();
  }
  setInodeDomain(inode: FsInodeSnapshot, target: DomainId): void {
    if (!this.data.domains.some(row => row.id === canonicalDomain(target))) throw new KernelConfigError('unknown setuid target');
    this.data.inodeDomains = this.data.inodeDomains.filter(row => row.inode !== inode.id);
    this.data.inodeDomains.push({ inode: inode.id, generation: inode.generation, targetDomain: canonicalDomain(target) });
    this.data.inodeDomains.sort((a, b) => a.inode - b.inode);
    // The default writable authority is explicit. Fixtures can deliberately grant another domain write.
    for (const row of this.data.domains) if (row.id !== canonicalDomain(target)) this.matrix.revoke(row.id, inodeObject(inode.id), ['write', 'owner']);
    this.matrix.grant(canonicalDomain(target), inodeObject(inode.id), ['read', 'write', 'execute', 'owner']); this.refresh();
  }
  commitExec(pid: Pid, inode: FsInodeSnapshot | undefined): void {
    if (!this.host.enabled() || inode === undefined) return;
    this.use(pid, inodeObject(inode.id), 'execute'); const binding = this.data.inodeDomains.find(row => row.inode === inode.id && row.generation === inode.generation);
    if (binding !== undefined) commitDomainReturn(this, pid, binding.targetDomain, 'exec');
  }
  switchDomain(pid: Pid, target: DomainId): boolean {
    this.ensure(pid); const result = commitDomainReturn(this, pid, target, 'explicit_switch');
    if (result) { this.use(pid, canonicalDomain(target), 'control'); const process = processState(this.data, pid)!;
      if (process.traps.length === 0) this.host.process(pid)!.domain = process.domain; }
    return result;
  }
  fork(parent: ProcessControlBlock, child: ProcessControlBlock): void {
    if (!this.host.enabled()) return;
    const source = processState(this.data, parent.pid); if (source !== undefined) {
      const caller = this.identity(parent.pid)!; this.data.processes.push({ pid: child.pid, active: true, ...caller, roles: [...source.roles], usedRights: [], traps: [] });
      child.domain = canonicalDomain(parent.domain) === caller.domain ? parent.domain : caller.domain;
    }
    for (const row of this.data.pageProtection.filter(item => item.space === parent.addressSpaceId)) this.data.pageProtection.push({ ...row, space: child.addressSpaceId });
    for (const row of this.data.sharedProtection) for (const alias of row.aliases.filter(item => item.pid === parent.pid)) row.aliases.push({ ...alias, pid: child.pid, space: child.addressSpaceId });
    this.sortProtection();
  }
  rights(pid: Pid, resource: ResourceId): readonly AccessRight[] { return this.host.enabled() ? this.matrix.rights(this.callerDomain(pid), resource) : []; }
  mappingDenied(pid: Pid, resource: ResourceId, right: 'read' | 'write'): void { if (this.host.enabled()) this.emit({ type: 'security.access_denied', domain: this.callerDomain(pid), object: resource, right }); }
  protectPage(space: AddressSpaceId, page: PageId, requiredRing: ProtectionRing): void {
    if (![0, 1, 2, 3].includes(requiredRing)) throw new KernelConfigError('invalid page ring');
    const row = this.data.pageProtection.find(item => item.space === space && item.page === page);
    if (row === undefined) this.data.pageProtection.push({ space, page, requiredRing }); else row.requiredRing = requiredRing;
    for (const shared of this.data.sharedProtection) if (shared.backingSpace === space && shared.backingPage === page) shared.requiredRing = requiredRing;
    this.sortProtection();
  }
  sharedMapped(pid: Pid, mapping: SharedMapping): void {
    if (!this.host.enabled()) return;
    let row = this.data.sharedProtection.find(item => item.region === mapping.region && item.backingPage === mapping.backingPage);
    if (row === undefined) { row = { region: mapping.region, backingSpace: mapping.backingSpace, backingPage: mapping.backingPage,
      requiredRing: this.data.pageProtection.find(item => item.space === mapping.backingSpace && item.page === mapping.backingPage)?.requiredRing ?? 3, aliases: [] }; this.data.sharedProtection.push(row); }
    row.aliases.push({ pid, space: mapping.space, page: mapping.page }); this.sortProtection();
    const pte = this.host.pages(mapping.space).find(item => item.page === mapping.page);
    for (const right of ['read', 'write', 'execute'] as const) if (pte?.[right === 'read' ? 'readable' : right === 'write' ? 'writable' : 'executable']) this.use(pid, mapping.region, right);
  }
  sharedUnmapped(pid: Pid, mapping: SharedMapping): void {
    for (const row of this.data.sharedProtection) row.aliases = row.aliases.filter(alias => alias.pid !== pid || alias.space !== mapping.space || alias.page !== mapping.page);
  }
  pageAllowed(pid: Pid, page: PageId, write: boolean): boolean {
    if (!this.host.enabled()) return true;
    const pcb = this.host.process(pid); if (pcb === undefined) return false;
    const alias = this.data.sharedProtection.find(row => row.aliases.some(item => item.pid === pid && item.space === pcb.addressSpaceId && item.page === page));
    const required = alias?.requiredRing ?? this.data.pageProtection.find(row => row.space === pcb.addressSpaceId && row.page === page)?.requiredRing ?? 3;
    if (this.rings.canAccessPage(this.ensure(pid).pid, required)) return true;
    this.emit({ type: 'security.access_denied', domain: this.callerDomain(pid), object: alias?.region ?? `page:${pcb.addressSpaceId}:${page}`, right: write ? 'write' : 'read' });
    this.host.terminate(pid, 'protection_fault'); return false;
  }
  validateByteCount(pid: Pid, count: unknown): SyscallResult | null {
    // TODO(astra): WP-11 provides validateArgs.
    const pcb = this.host.process(pid), ceiling = (pcb === undefined ? 0 : this.host.pages(pcb.addressSpaceId).length) * this.host.pageSize();
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > ceiling) return invalid('address out of range: byte count exceeds the caller address space');
    return null;
  }
  control(device: DeviceId, command: string, args: readonly (string | number | boolean)[], actor: IoSnapshotActor | undefined): SyscallResult | undefined {
    if (!this.host.enabled()) return undefined;
    if (device === 'kernel' && command === 'set_ring') {
      if (actor === undefined) return invalid('set_ring requires a caller'); this.ensure(actor.pid);
      this.emit({ type: 'security.escalation_attempt', pid: actor.pid, fromRing: this.identity(actor.pid)!.ring, toRing: 0, blocked: true }); return invalid('ring entry requires an authorized gate');
    }
    if (device === 'kernel' && command === 'domain_switch') return actor === undefined || typeof args[0] !== 'string' ? invalid('domain_switch requires a target')
      : this.switchDomain(actor.pid, domain(args[0])) ? success() : denied('domain switch denied');
    if (device === 'kernel' && command === 'capability_access') {
      if (actor === undefined || typeof args[0] !== 'string' || typeof args[1] !== 'string' || typeof args[2] !== 'number' || !ACCESS_RIGHTS.includes(args[3] as AccessRight)) return invalid('invalid capability arguments');
      const id = this.callerDomain(actor.pid), presented = { object: args[0], rights: args[1].split(',') as AccessRight[], seal: args[2] };
      let allowed = false; try { canonicalRights(presented.rights); allowed = capabilityCheck(this.data.capabilities, id, presented.object, args[3] as AccessRight,
        (owner, cap) => verifyCapability(cap, owner, this.#kernelSecret), presented); } catch { /* Invalid rights never create authority. */ }
      if (!allowed) { this.emit({ type: 'security.access_denied', domain: id, object: presented.object, right: args[3] as AccessRight });
        this.emit({ type: 'security.escalation_attempt', pid: actor.pid, fromRing: this.identity(actor.pid)!.ring, toRing: 0, blocked: true }); return { ok: false, errno: 'EPERM', message: 'capability is not active or its seal is invalid' }; }
      this.use(actor.pid, presented.object, args[3] as AccessRight); return success();
    }
    if (device === 'disk0' && command === 'write_region') {
      if (actor === undefined || typeof args[0] !== 'number' || !Number.isSafeInteger(args[0]) || typeof args[1] !== 'string' || typeof args[2] !== 'number' || !Number.isSafeInteger(args[2])) return invalid('write_region requires driver, region and integer value');
      const driver = this.host.process(args[0] as Pid), region = this.host.ipc.sharedRegion(args[1] as ResourceId);
      if (driver === undefined || this.identity(driver.pid)?.ring !== 1 || region === undefined) return invalid('write_region requires a ring-one driver and live region');
      const requestId = this.host.io.submit({ kind: 'actor', actor }, device, { kind: 'read', lba: 0 as BlockId, bytes: 512 }, 'interrupt');
      const row = this.data.requests.find(item => item.requestId === requestId)!;
      row.delegatedWrite = { driverPid: driver.pid, driverDomain: this.callerDomain(driver.pid), driverRing: 1, region: region.id, value: args[2], completion: { kind: 'pending' } };
      this.host.io.request(actor.pid, device); return success(requestId);
    }
    if (device === 'disk0' && command === 'crash') { this.host.fs().crash(); return success(); }
    return undefined;
  }
  onRequestSubmitted(request: IoSnapshotRequest): void {
    if (!this.host.enabled()) return;
    const identity = request.owner.kind === 'actor' ? this.identity(request.owner.actor.pid) : null;
    this.data.requests.push({ requestId: request.id, submittedAtTick: request.submittedAtTick, authority: request.owner.kind === 'actor'
      ? { kind: 'process', ...request.owner.actor, domain: identity!.domain, ring: identity!.ring }
      : { kind: 'kernel', domain: domain('domain:kernel'), ring: 0 }, delegatedWrite: null });
    this.data.requests.sort((a, b) => a.requestId - b.requestId);
  }
  onRequestRemoved(request: IoSnapshotRequest): void { this.data.requests = this.data.requests.filter(row => row.requestId !== request.id); }
  onRequestCompleted(request: IoSnapshotRequest, result: IoSnapshotResult): void {
    const row = this.data.requests.find(item => item.requestId === request.id), delegated = row?.delegatedWrite;
    if (row === undefined || delegated == null || delegated.completion.kind !== 'pending') return;
    const authority = row.authority, region = this.host.ipc.sharedRegion(delegated.region), pid = authority.kind === 'process' ? authority.pid : null;
    const allowed = result.kind === 'ok' && region !== undefined && pid !== null && region.attached.includes(pid)
      && this.matrix.check(authority.domain, delegated.region, 'write');
    const outcome: SyscallResult = allowed ? success() : denied('requester cannot write the delegated destination');
    if (allowed) { region.value = delegated.value; delegated.completion = { kind: 'written', acknowledgedAtTick: this.host.tick() }; this.use(pid!, delegated.region, 'write'); }
    else {
      delegated.completion = { kind: 'failed', atTick: this.host.tick(), errno: 'EACCES', message: 'requester cannot write the delegated destination' };
      this.emit({ type: 'security.access_denied', domain: authority.domain, object: delegated.region, right: 'write' });
    }
    if (pid !== null) {
      this.host.publishResult(pid, outcome);
      for (const probe of this.data.probes.filter(item => item.pid === pid && item.pendingOperation?.kind === 'io' && item.pendingOperation.requestId === request.id)) {
        observeProbeResult(this, probe, outcome, true); probe.pendingOperation = null;
      }
    }
  }
  observe(event: KernelEvent): void {
    if (!this.host.enabled()) return;
    if (carriesMaterial(event, this.#kernelSecret)) throw new Error('I-37: private sealing material appeared in an event');
    if (event.type === 'process.exited') {
      const process = processState(this.data, event.pid); if (process !== undefined) {
        const identity = callerIdentity(this.data, event.pid)!;
        process.domain = identity.domain; process.ring = identity.ring; process.active = false; process.traps.length = 0;
      }
      for (const probe of this.data.probes) if (probe.pid === event.pid && probe.status === 'active') probe.status = 'cancelled';
    }
    if (event.type === 'syscall.invoked') for (const probe of this.data.probes.filter(item => item.pid === event.request.pid && item.status === 'active')) {
      const actor = this.host.actor(probe.pid), operation = actor === undefined ? undefined : this.host.fs().pending(actor);
      if (operation !== undefined && !operation.instructionRetired && operation.stage !== 'complete') { probe.pendingOperation = { kind: 'fs', operationId: operation.id }; continue; }
      if (probe.pendingOperation?.kind === 'fs') continue;
      if (probe.stage === 'deputy_write' && event.result.ok && typeof event.result.value === 'number') { probe.pendingOperation = { kind: 'io', requestId: event.result.value }; continue; }
      observeProbeResult(this, probe, event.result, false);
    }
  }
  onPhase(phase: number): void {
    if (!this.host.enabled()) return; this.data.tick = this.host.tick();
    if (phase !== 4) return;
    for (const probe of this.data.probes.filter(item => item.status === 'active')) advanceProbe(this, probe);
  }
  createProbe(options: Omit<Probe, 'stage' | 'overwriteDescriptor' | 'pendingOperation' | 'outcomes' | 'status'>): Program {
    if (this.data.probes.some(row => row.id === options.id || row.pid === options.pid)) throw new KernelConfigError('duplicate escalation probe');
    const probe: Probe = { ...structuredClone(options), stage: 'ring_write', overwriteDescriptor: null, pendingOperation: null, outcomes: [], status: 'active' };
    this.data.probes.push(probe); const program = probeProgram(probe); this.host.registerProgram(options.programName, program); return program;
  }
  probeTick(): Tick { return this.host.tick(); }
  probeOperation(id: number) { return this.host.fs().operation(id); }
  probeConsume(pid: Pid): void { const actor = this.host.actor(pid); if (actor !== undefined) this.host.fs().consume(pid, actor.tid); }
  probeTerminate(pid: Pid): void { this.host.terminate(pid, 'protection_fault'); }
  probeCompromised(pid: Pid): boolean { return this.identity(pid)?.domain !== domain('domain:user_ro'); }
  excess() { return privilegeExcess(this.data); }
  saveState(): SecuritySnapshotState { this.data.tick = this.host.tick(); return { owner: 'security', version: 1, payload: structuredClone(this.data) }; }
  prepareRestore(state: SecuritySnapshotState, sourceSeed: number): () => void {
    plainData(state); if (state.owner !== 'security' || state.version !== 1) throw new KernelConfigError('invalid security snapshot');
    const data = structuredClone(state.payload) as MutableSecurityPayload;
    const integer = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
    const ring = (value: number) => integer(value) && value <= 3;
    const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
    const valid = (condition: boolean, message: string) => { if (!condition) throw new KernelConfigError(`invalid security snapshot: ${message}`); };
    valid(integer(data.tick) && ['acl', 'capability'].includes(data.accessModel), 'clock or access model');
    valid(unique(data.domains.map(row => row.id)), 'duplicate domains');
    for (const row of data.domains) {
      valid(typeof row.id === 'string' && row.id.length > 0 && canonicalDomain(row.id) === row.id && typeof row.displayName === 'string' && ring(row.ring), 'domain');
      valid(unique(row.rights.map(cell => cell.object)), 'duplicate matrix object');
      for (const cell of row.rights) valid(typeof cell.object === 'string' && cell.object.length > 0
        && same(cell.rights, canonicalRights(cell.rights)) && same(cell.transferableRights, canonicalRights(cell.transferableRights))
        && cell.transferableRights.every(right => cell.rights.includes(right)), 'matrix rights');
    }
    const detached = createStreams(sourceSeed).streams.get('security'); if (detached === undefined) throw new Error('missing detached security stream');
    const material = detached.int(0, 0x100000000);
    validateRoles(data.roles);
    for (const list of data.capabilities) for (const cap of list.entries) if (!verifyCapability(cap, list.domain, material)) throw new KernelConfigError('invalid saved capability seal');
    const matrix = new AccessMatrix(() => data, (id, object, rights) => sealCapability(object, rights, id, material), (id, cap) => verifyCapability(cap, id, material));
    matrix.assertEquivalent(); new Rings({ state: () => data, emit: () => {} }).assertInvariants();
    if (!Number.isSafeInteger(data.nextTrapId) || data.nextTrapId < 1 || new Set(data.processes.map(row => row.pid)).size !== data.processes.length) throw new KernelConfigError('invalid security process identities');
    for (const process of data.processes) {
      if (!data.domains.some(row => row.id === canonicalDomain(process.domain)) || process.traps.some(frame => frame.id < 1 || frame.id >= data.nextTrapId)) throw new KernelConfigError('invalid security process binding');
      valid(integer(process.pid) && typeof process.active === 'boolean' && ring(process.ring) && unique(process.roles), 'process');
      valid(unique(process.usedRights.map(item => `${item.object}\u0000${item.right}`)), 'duplicate used right');
      for (const used of process.usedRights) valid(typeof used.object === 'string' && ACCESS_RIGHTS.includes(used.right), 'used right');
      for (const frame of process.traps) {
        valid(integer(frame.id, 1) && ring(frame.savedRing) && data.domains.some(row => row.id === canonicalDomain(frame.savedDomain)), 'trap frame');
        if (frame.committedReturn !== null) valid(['exec', 'explicit_switch'].includes(frame.committedReturn.reason)
          && data.domains.some(row => row.id === frame.committedReturn!.domain && row.ring === frame.committedReturn!.ring), 'committed return');
      }
      roleDomains(data.roles, process.roles);
    }
    valid(unique(data.processes.flatMap(process => process.traps.map(frame => frame.id))), 'duplicate trap id');
    valid(unique(data.inodeDomains.map(row => row.inode)), 'duplicate inode binding');
    for (const row of data.inodeDomains) valid(integer(row.inode, 2) && integer(row.generation, 1) && data.domains.some(item => item.id === row.targetDomain), 'inode binding');
    valid(unique(data.pageProtection.map(row => `${row.space}:${row.page}`)), 'duplicate page protection');
    for (const row of data.pageProtection) valid(integer(row.space) && integer(row.page) && ring(row.requiredRing), 'page protection');
    valid(unique(data.sharedProtection.map(row => `${row.region}:${row.backingSpace}:${row.backingPage}`)), 'duplicate shared protection');
    for (const row of data.sharedProtection) {
      valid(typeof row.region === 'string' && integer(row.backingSpace) && integer(row.backingPage) && ring(row.requiredRing), 'shared protection');
      valid(unique(row.aliases.map(alias => `${alias.pid}:${alias.space}:${alias.page}`)), 'duplicate shared alias');
      for (const alias of row.aliases) valid(integer(alias.pid) && integer(alias.space) && integer(alias.page), 'shared alias');
    }
    valid(unique(data.requests.map(row => row.requestId)), 'duplicate captured request');
    for (const row of data.requests) {
      valid(integer(row.requestId) && integer(row.submittedAtTick) && row.submittedAtTick <= data.tick
        && data.domains.some(item => item.id === row.authority.domain) && ring(row.authority.ring), 'request authority');
      if (row.authority.kind === 'process') valid(integer(row.authority.pid) && integer(row.authority.tid), 'request actor');
      else valid(row.authority.kind === 'kernel' && row.authority.domain === 'domain:kernel' && row.authority.ring === 0, 'kernel authority');
      if (row.delegatedWrite !== null) valid(integer(row.delegatedWrite.driverPid) && row.delegatedWrite.driverRing === 1
        && typeof row.delegatedWrite.region === 'string' && Number.isSafeInteger(row.delegatedWrite.value)
        && data.domains.some(item => item.id === row.delegatedWrite!.driverDomain && item.ring === 1)
        && ['pending', 'written', 'failed'].includes(row.delegatedWrite.completion.kind), 'delegated write');
    }
    valid(unique(data.probes.map(row => row.id)) && unique(data.probes.map(row => row.pid)), 'duplicate probe');
    for (const probe of data.probes) {
      valid(typeof probe.id === 'string' && probe.id.length > 0 && typeof probe.programName === 'string' && integer(probe.pid)
        && integer(probe.driverPid) && integer(probe.descriptor) && integer(probe.binaryInode, 2) && integer(probe.binaryGeneration, 1)
        && integer(probe.outOfRangeLength) && integer(probe.overwriteBytes) && Number.isSafeInteger(probe.delegatedValue), 'probe input');
      valid(['ring_write', 'argument_bounds', 'deputy_write', 'binary_open', 'binary_write', 'binary_exec', 'capability_forgery', 'finished'].includes(probe.stage)
        && ['active', 'completed', 'compromised', 'cancelled'].includes(probe.status) && unique(probe.outcomes.map(item => item.attempt)), 'probe continuation');
      for (const outcome of probe.outcomes) valid(integer(outcome.attempt, 1) && outcome.attempt <= 5 && integer(outcome.tick)
        && outcome.tick <= data.tick && typeof outcome.blocked === 'boolean' && typeof outcome.decisionEmitted === 'boolean', 'probe outcome');
    }
    return () => { this.#kernelSecret = material; this.data = data; this.matrix.refreshViews(); this.refresh();
      for (const probe of data.probes) this.host.registerProgram(probe.programName, probeProgram(probe)); };
  }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    let state = snapshot.subsystems?.security;
    if (state === undefined) {
      if (snapshot.subsystems !== undefined) throw new KernelConfigError('missing security snapshot');
      const detached = createStreams(snapshot.config.seed).streams.get('security')!;
      state = new SecuritySubsystem({ ...this.host, tick: () => snapshot.tick, registerProgram: () => {}, emit: () => {} }, detached, this.data.accessModel).saveState();
    }
    const commit = this.prepareRestore(state, snapshot.config.seed);
    const views = state.payload.domains.map(row => ({ id: row.id, displayName: row.displayName, ring: row.ring, rights: row.rights.map(cell => [cell.object, cell.rights]) }));
    const actual = snapshot.domains.map(row => ({ id: row.id, displayName: row.displayName, ring: row.ring, rights: [...row.rights] }));
    if (state.payload.tick !== snapshot.tick || !same(views, actual)) throw new KernelConfigError('security shared mirrors disagree');
    for (const request of state.payload.requests) if (!snapshot.subsystems?.io?.payload.requests.some(row => row.id === request.requestId)) throw new KernelConfigError('security request has no I/O owner');
    for (const binding of state.payload.inodeDomains) if (!snapshot.subsystems?.fs?.payload.metadata.inodes.some(row => row.id === binding.inode && row.generation === binding.generation)) throw new KernelConfigError('security inode generation missing');
    return commit;
  }
  assertInvariants(): void { this.rings.assertInvariants(); this.matrix.assertEquivalent(); }
  private ensure(pid: Pid) {
    let process = processState(this.data, pid); if (process !== undefined) return process;
    const pcb = this.host.process(pid); if (pcb === undefined) throw new KernelConfigError('unknown security process');
    const id = canonicalDomain(pcb.domain), row = this.data.domains.find(item => item.id === id);
    if (row === undefined) throw new KernelConfigError('unknown process protection domain');
    process = { pid, active: !['zombie', 'terminated'].includes(pcb.state), domain: id, ring: row.ring,
      roles: [row.ring === 0 ? 'kernel' : row.ring === 1 ? 'driver' : 'user'], usedRights: [], traps: [] };
    this.data.processes.push(process); this.data.processes.sort((a, b) => a.pid - b.pid); return process;
  }
  private refresh(): void { this.matrix.refreshViews(); this.domains.splice(0, this.domains.length, ...this.data.domains.map(domain => this.matrix.domains.get(domain.id)!)); }
  private sortProtection(): void {
    this.data.pageProtection.sort((a, b) => a.space - b.space || a.page - b.page);
    this.data.sharedProtection.sort((a, b) => a.region < b.region ? -1 : a.region > b.region ? 1 : a.backingPage - b.backingPage);
    for (const row of this.data.sharedProtection) row.aliases.sort((a, b) => a.pid - b.pid || a.page - b.page);
  }
}
