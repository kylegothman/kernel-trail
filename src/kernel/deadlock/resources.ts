import { KernelInvariantError } from '../errors';
import type { BankersState, DeadlockSnapshotState, Pid, ProcessControlBlock, ResourceId, ResourceType } from '../types';

export type ResourceVector = readonly (readonly [ResourceId, number])[];
export type ResourceDeclaration = DeadlockSnapshotState['payload']['declarations'][number];
export type ResourceClaims = DeadlockSnapshotState['payload']['claims'];

export interface ResourceTableHost {
  readonly processes: () => readonly ProcessControlBlock[];
  readonly collides?: (resource: ResourceId) => boolean;
}

/** Ch. 8. Resource columns are lexical; allocations have one owner: the PCB. */
export class ResourceTable {
  private readonly records = new Map<ResourceId, ResourceType>();
  private readonly declared = new Map<ResourceId, ResourceDeclaration>();
  private readonly maximums = new Map<Pid, ResourceVector>();
  /** This array keeps its identity when declarations or effective flags change. */
  readonly resources: ResourceType[] = [];

  constructor(private readonly host: ResourceTableHost) {}

  owns(resource: ResourceId): boolean { return this.records.has(resource); }
  get(resource: ResourceId): ResourceType | undefined { return this.records.get(resource); }

  declare(declaration: ResourceDeclaration): ResourceType {
    this.validateDeclaration(declaration);
    if (this.owns(declaration.id)) throw new RangeError(`resource ${declaration.id} already declared`);
    const saved = Object.freeze({ ...declaration });
    const resource = { ...saved, availableInstances: saved.totalInstances };
    this.declared.set(saved.id, saved);
    this.records.set(saved.id, resource);
    this.resources.push(resource);
    this.resources.sort((a, b) => compareResources(a.id, b.id));
    return resource;
  }

  /** Duplicate columns are rejected, zero columns omitted, and positives sorted. */
  normalizeVector(vector: ResourceVector): ResourceVector {
    const seen = new Set<ResourceId>();
    const normalized: (readonly [ResourceId, number])[] = [];
    for (const [id, instances] of vector) {
      if (!this.owns(id)) throw new RangeError(`unknown resource ${id}`);
      if (seen.has(id)) throw new RangeError(`duplicate resource ${id}`);
      if (!Number.isSafeInteger(instances) || instances < 0) throw new RangeError('resource count must be a non-negative integer');
      seen.add(id);
      if (instances > 0) normalized.push(Object.freeze([id, instances] as const));
    }
    return Object.freeze(normalized.sort((a, b) => compareResources(a[0], b[0])));
  }

  declareClaims(pid: Pid, vector: ResourceVector): void {
    const process = this.process(pid);
    if (process.state !== 'new') throw new RangeError('claims must be declared before admission');
    const normalized = this.normalizeVector(vector);
    for (const [id, count] of normalized) {
      if (count > this.requireResource(id).totalInstances) throw new RangeError(`claim exceeds total instances for ${id}`);
    }
    this.maximums.set(pid, normalized);
  }

  claim(pid: Pid): ResourceVector { return this.maximums.get(pid) ?? Object.freeze([]); }
  clearClaims(pid: Pid): void { this.maximums.delete(pid); }

  available(vector: ResourceVector): boolean {
    return this.normalizeVector(vector).every(([id, count]) => count <= this.requireResource(id).availableInstances);
  }

  /** The complete precheck precedes any mutation, so a vector grant is atomic. */
  grant(pid: Pid, vector: ResourceVector): void {
    const process = this.process(pid);
    const normalized = this.normalizeVector(vector);
    if (!normalized.every(([id, count]) => count <= this.requireResource(id).availableInstances)) {
      throw new RangeError('resource vector unavailable');
    }
    for (const [id, count] of normalized) {
      this.requireResource(id).availableInstances -= count;
      for (let instance = 0; instance < count; instance += 1) process.heldResources.push(id);
    }
  }

  /** Refuse over-release before returning any instance from the vector. */
  release(pid: Pid, vector: ResourceVector): void {
    const process = this.process(pid);
    const normalized = this.normalizeVector(vector);
    for (const [id, count] of normalized) {
      if (process.heldResources.filter(held => held === id).length < count) throw new RangeError(`process does not hold ${count} of ${id}`);
    }
    for (const [id, count] of normalized) {
      let remaining = count;
      process.heldResources = process.heldResources.filter(held => {
        if (held !== id || remaining === 0) return true;
        remaining -= 1;
        return false;
      });
      this.requireResource(id).availableInstances += count;
    }
  }

  releaseAll(pid: Pid): ResourceVector {
    const process = this.process(pid);
    const released = this.heldVector(process);
    this.release(pid, released);
    return released;
  }

  heldVector(process: Readonly<ProcessControlBlock>): ResourceVector {
    return Object.freeze(this.resources.flatMap(resource => {
      const count = process.heldResources.filter(held => held === resource.id).length;
      return count === 0 ? [] : [Object.freeze([resource.id, count] as const)];
    }));
  }

  bankersState(): BankersState {
    const processes = this.liveProcesses();
    const allocation = processes.map(process => this.resources.map(resource => process.heldResources.filter(id => id === resource.id).length));
    const max = processes.map(process => {
      const claim = new Map(this.claim(process.pid));
      return this.resources.map(resource => claim.get(resource.id) ?? 0);
    });
    // Need is reconstructed from those same sources, never retained as a matrix.
    const need = processes.map(process => {
      const claim = new Map(this.claim(process.pid));
      return this.resources.map(resource => (claim.get(resource.id) ?? 0) - process.heldResources.filter(id => id === resource.id).length);
    });
    return {
      processes: processes.map(process => process.pid), resources: this.resources.map(resource => resource.id),
      available: this.resources.map(resource => resource.availableInstances), max, allocation, need,
    };
  }

  requestMatrix(): number[][] {
    return this.liveProcesses().map(process => this.resources.map(resource => process.requestedResources.filter(id => id === resource.id).length));
  }

  setEffectivePreemptible(id: ResourceId, preemptible: boolean): void {
    const resource = this.requireResource(id);
    const effective: ResourceType = { ...resource, preemptible };
    this.records.set(id, effective);
    const index = this.resources.findIndex(entry => entry.id === id);
    if (index < 0) throw new KernelInvariantError(5, 'resource missing from ordered view');
    this.resources[index] = effective;
  }

  declarations(): readonly ResourceDeclaration[] {
    return this.resources.map(resource => {
      const declaration = this.declared.get(resource.id);
      if (declaration === undefined) throw new KernelInvariantError(5, 'resource missing declaration');
      return { ...declaration };
    });
  }

  claimsSnapshot(): ResourceClaims {
    return [...this.maximums].sort((a, b) => a[0] - b[0]).map(([pid, resources]) => ({ pid, resources: resources.map(([id, count]) => [id, count] as const) }));
  }

  /** Build against staged PCBs first; this method never changes any PCB. */
  restore(declarations: readonly ResourceDeclaration[], claims: ResourceClaims): void {
    const staged = new ResourceTable(this.host);
    for (const declaration of declarations) staged.declare(declaration);
    const claimPids = new Set<Pid>();
    for (const claim of claims) {
      if (claimPids.has(claim.pid)) throw new RangeError('duplicate resource claim pid');
      staged.process(claim.pid);
      const normalized = staged.normalizeVector(claim.resources);
      for (const [id, count] of normalized) {
        if (count > staged.requireResource(id).totalInstances) throw new RangeError('restored claim exceeds resource total');
      }
      staged.maximums.set(claim.pid, normalized);
      claimPids.add(claim.pid);
    }
    for (const resource of staged.resources) {
      resource.availableInstances -= this.host.processes().reduce((total, process) => total + process.heldResources.filter(id => id === resource.id).length, 0);
    }
    staged.assertConservation();
    this.records.clear(); this.declared.clear(); this.maximums.clear(); this.resources.length = 0;
    for (const [id, resource] of staged.records) this.records.set(id, resource);
    for (const [id, declaration] of staged.declared) this.declared.set(id, declaration);
    for (const [pid, claim] of staged.maximums) this.maximums.set(pid, claim);
    this.resources.push(...staged.resources);
  }

  assertConservation(): void {
    for (const resource of this.resources) {
      const allocated = this.host.processes().reduce((total, process) => total + process.heldResources.filter(id => id === resource.id).length, 0);
      if (!Number.isSafeInteger(resource.availableInstances) || resource.availableInstances < 0
        || resource.availableInstances + allocated !== resource.totalInstances) {
        throw new KernelInvariantError(5, `resource conservation failed for ${resource.id}`);
      }
    }
  }

  private liveProcesses(): ProcessControlBlock[] {
    return this.host.processes().filter(process => process.state !== 'terminated' && process.state !== 'zombie').sort((a, b) => a.pid - b.pid);
  }

  private process(pid: Pid): ProcessControlBlock {
    const process = this.host.processes().find(candidate => candidate.pid === pid);
    if (process === undefined) throw new RangeError(`unknown process ${pid}`);
    return process;
  }

  private requireResource(id: ResourceId): ResourceType {
    const resource = this.records.get(id);
    if (resource === undefined) throw new RangeError(`unknown resource ${id}`);
    return resource;
  }

  private validateDeclaration(declaration: ResourceDeclaration): void {
    if (typeof declaration.id !== 'string' || declaration.id.length === 0 || declaration.id.startsWith('mbox:') || this.host.collides?.(declaration.id) === true) {
      throw new RangeError('resource id is empty or collides with another namespace');
    }
    if (typeof declaration.displayName !== 'string' || typeof declaration.preemptible !== 'boolean'
      || !Number.isSafeInteger(declaration.totalInstances) || declaration.totalInstances < 1) {
      throw new RangeError('invalid resource declaration');
    }
  }
}

export function compareResources(a: ResourceId, b: ResourceId): number { return a < b ? -1 : a > b ? 1 : 0; }
