import { asTick } from '../types';
import type { BlockId, Pid, RaidLevel, StorageDiskOperationSnapshot, StorageRaidOperationSnapshot,
  StorageRaidSnapshot, StorageRaidTransactionSnapshot, StorageRequestSnapshot, StorageResultSnapshot, StorageTransferSnapshot, Tick } from '../types';

type Operation = StorageRaidOperationSnapshot;
type Transaction = StorageRaidTransactionSnapshot;
type Rebuild = StorageRaidSnapshot['rebuilds'][number];
export interface RaidHost {
  tick(): Tick;
  request(id: number): StorageRequestSnapshot | undefined;
  completeRequest(id: number, result: StorageResultSnapshot, tick: Tick): void;
  issuePhysical(driveId: string, transfer: StorageTransferSnapshot, owner: StorageDiskOperationSnapshot['owner'], pid: Pid | null): number;
  takePhysicalCompletion(id: number): StorageResultSnapshot | null;
  readSector(driveId: string, lba: BlockId): readonly number[];
  ensureDrive(driveId: string, cylinders?: number): void;
  failDrive(driveId: string): void;
  emit(event: { readonly type: 'raid.rebuild'; readonly level: RaidLevel; readonly failedDisk: number; readonly progress: number }): void;
}
export interface RaidOptions {
  readonly arrayId?: string;
  readonly level: RaidLevel;
  readonly members: readonly string[];
  readonly blocksPerMember: number;
  readonly spares?: readonly string[];
  readonly rebuildBlocksPerTick?: number;
  readonly rebuildProgressInterval?: number;
}
const SECTOR = 512;
const asBlockId = (value: number): BlockId => value as BlockId;
const ok = (data: readonly number[] = []): StorageResultSnapshot => ({ kind: 'ok', data });
const failed = (reason: 'device_failed' | 'cancelled' | 'storage_corruption' = 'device_failed'): StorageResultSnapshot => ({ kind: 'failed', reason });

/** RAID owns plans; the host owns every physical queue and durable sector. */
export class RaidArray {
  private state: StorageRaidSnapshot;
  readonly rebuildBlocksPerTick: number;
  readonly rebuildProgressInterval: number;
  constructor(private readonly host: RaidHost, options: RaidOptions) {
    validateLayout(options.level, options.members.length); integer(options.blocksPerMember, 'RAID member capacity', 1);
    if (new Set([...options.members, ...options.spares ?? []]).size !== options.members.length + (options.spares?.length ?? 0)) throw new Error('RAID drive ownership overlaps');
    this.rebuildBlocksPerTick = integer(options.rebuildBlocksPerTick ?? 4, 'rebuild issuance cap', 1);
    this.rebuildProgressInterval = integer(options.rebuildProgressInterval ?? 10, 'rebuild event interval', 1);
    // Constructors prepare detached state only: restore must not create live drives.
    this.state = { arrayId: options.arrayId ?? 'raid0', level: options.level, blocksPerMember: options.blocksPerMember,
      dataLost: false, members: options.members.map(driveId => ({ driveId, failed: false })), spareDriveIds: [...options.spares ?? []],
      nextTransactionId: 0, nextOperationId: 0, transactions: [], rebuildPaused: false, rebuilds: [],
      counters: { completedReadBlocks: 0, completedWriteBlocks: 0, completedRebuildBlocks: 0,
        issuedPhysicalReads: 0, issuedPhysicalWrites: 0, completedPhysicalReads: 0, completedPhysicalWrites: 0 } };
  }
  get arrayId(): string { return this.state.arrayId; }
  get level(): RaidLevel { return this.state.level; }
  get status(): 'healthy' | 'degraded' | 'lost' { return this.state.dataLost ? 'lost' : this.state.members.some(member => member.failed) ? 'degraded' : 'healthy'; }
  get dataWidth(): number { const n = this.state.members.length; return this.level === 0 ? n : this.level === 1 || this.level === 10 ? n / 2 : n - (this.level === 6 ? 2 : 1); }
  get capacity(): number { return this.dataWidth * this.state.blocksPerMember; }
  get busy(): boolean { return this.state.transactions.length > 0 || (!this.state.dataLost && this.state.rebuilds.length > 0); }
  metrics() { return { ...this.state.counters, status: this.status, queueLengths: this.queueLengths(), capacity: this.capacity }; }
  queueLengths(): readonly number[] {
    return this.state.members.map((_, memberIndex) => this.state.transactions.reduce((sum, transaction) =>
      sum + transaction.operations.filter(op => op.memberIndex === memberIndex && op.state.kind !== 'settled').length, 0));
  }
  parityDisk(stripe: number): number { return this.level === 4 ? this.state.members.length - 1 : this.state.members.length - 1 - stripe % this.state.members.length; }
  qDisk(stripe: number): number { return (this.parityDisk(stripe) - 1 + this.state.members.length) % this.state.members.length; }
  dataMembers(stripe: number): readonly number[] {
    const n = this.state.members.length;
    if (this.level === 0) return Array.from({ length: n }, (_, index) => index);
    if (this.level === 1 || this.level === 10) return Array.from({ length: n / 2 }, (_, index) => index * 2);
    return Array.from({ length: n }, (_, index) => index).filter(index => index !== this.parityDisk(stripe) && (this.level !== 6 || index !== this.qDisk(stripe)));
  }
  submit(requestId: number): number {
    const request = this.host.request(requestId); if (request === undefined || this.state.transactions.some(tx => tx.purpose.kind === 'request' && tx.purpose.requestId === requestId)) throw new Error('invalid RAID request');
    const transfer = request.transfer; const size = transfer.kind === 'read' ? transfer.bytes : transfer.data.length;
    integer(transfer.lba, 'RAID LBA'); integer(size, 'RAID transfer', 1);
    if (transfer.kind === 'write' && (size % SECTOR !== 0 || transfer.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))) throw new Error('RAID writes require complete byte sectors');
    if (transfer.lba + Math.ceil(size / SECTOR) > this.capacity) throw new RangeError('RAID transfer outside array');
    const id = this.state.nextTransactionId; const operations: Operation[] = [];
    if (!this.state.dataLost) {
      if (transfer.kind === 'read') for (let block = 0; block < Math.ceil(size / SECTOR); block++) this.planRead(transfer.lba + block, operations);
      else this.planWrite(request, operations);
    }
    this.state = { ...this.state, nextTransactionId: id + 1,
      transactions: [...this.state.transactions, { id, purpose: { kind: 'request', requestId }, operations }] };
    // No synchronous completion: the caller installs this transaction ID first.
    this.dispatch(); return id;
  }
  failDisk(memberIndex: number): void {
    integer(memberIndex, 'failed RAID member'); const member = this.state.members[memberIndex]; if (member === undefined) throw new RangeError('unknown RAID member');
    if (member.failed) return;
    const members = this.state.members.map((value, index) => index === memberIndex ? { ...value, failed: true } : value);
    const dataLost = this.state.dataLost || !survives(this.level, members.map(value => value.failed));
    this.state = { ...this.state, members, dataLost }; this.host.failDrive(member.driveId);
    if (!dataLost && this.state.spareDriveIds.length > 0) {
      const spareDriveId = this.state.spareDriveIds[0]!;
      this.state = { ...this.state, spareDriveIds: this.state.spareDriveIds.slice(1), rebuilds: [...this.state.rebuilds,
        { memberIndex, spareDriveId, nextSectorToIssue: 0, completedPrefix: 0, completedBeyondPrefix: [], nextProgressAtTick: asTick(this.host.tick() + this.rebuildProgressInterval) }] };
      this.host.emit({ type: 'raid.rebuild', level: this.level, failedDisk: memberIndex, progress: 0 });
    }
    if (dataLost) this.state = { ...this.state, transactions: this.state.transactions.map(tx => ({ ...tx,
      operations: tx.operations.map(op => op.state.kind === 'planned' ? { ...op, state: { kind: 'settled', result: failed() } } : op) })) };
  }
  pauseRebuild(): void { this.state = { ...this.state, rebuildPaused: true }; }
  resumeRebuild(): void { this.state = { ...this.state, rebuildPaused: false }; }
  cancel(requestId: number): void {
    this.state = { ...this.state, transactions: this.state.transactions.map(tx => tx.purpose.kind === 'request' && tx.purpose.requestId === requestId
      ? { ...tx, operations: tx.operations.map(op => op.state.kind === 'planned' ? { ...op, state: { kind: 'settled', result: failed('cancelled') } } : op) } : tx) };
  }
  expireTimers(tick: Tick): void {
    if (!this.state.dataLost && !this.state.rebuildPaused) {
      let issued = 0;
      for (const original of [...this.state.rebuilds]) {
        while (issued < this.rebuildBlocksPerTick) {
          const job = this.state.rebuilds.find(value => value.memberIndex === original.memberIndex); if (job === undefined) break;
          const sector = this.nextRebuildSector(job); if (sector === null) break;
          this.planRebuild(job, sector); issued += 1;
          this.state = { ...this.state, rebuilds: this.state.rebuilds.map(value => value.memberIndex === job.memberIndex ? { ...value, nextSectorToIssue: Math.max(value.nextSectorToIssue, sector + 1) } : value) };
        }
      }
    }
    for (const job of [...this.state.rebuilds]) if (!this.state.dataLost && tick >= job.nextProgressAtTick) {
      this.host.emit({ type: 'raid.rebuild', level: this.level, failedDisk: job.memberIndex,
        progress: (job.completedPrefix + job.completedBeyondPrefix.length) / this.state.blocksPerMember });
      this.state = { ...this.state, rebuilds: this.state.rebuilds.map(value => value.memberIndex === job.memberIndex ? { ...value, nextProgressAtTick: asTick(tick + this.rebuildProgressInterval) } : value) };
    }
    this.finishRebuilds(); this.dispatch();
  }
  serviceCompletions(_tick: Tick): void {
    for (const tx of [...this.state.transactions]) for (const op of tx.operations) if (op.state.kind === 'submitted') {
      const result = this.host.takePhysicalCompletion(op.state.physicalOperationId); if (result === null) continue;
      this.setOperation(tx.id, op.id, { kind: 'settled', result });
      if (result.kind === 'ok') this.increment(op.operation.kind === 'read' ? 'completedPhysicalReads' : 'completedPhysicalWrites');
    }
    this.dispatch();
    for (const tx of [...this.state.transactions]) if (tx.operations.every(op => op.state.kind === 'settled')) this.finishTransaction(tx);
    this.finishRebuilds(); this.dispatch();
  }
  saveState(): StorageRaidSnapshot { return structuredClone(this.state); }
  prepareRestore(snapshot: StorageRaidSnapshot): () => void {
    const next = structuredClone(snapshot); validateState(next, id => this.host.request(id));
    if (next.arrayId !== this.arrayId || next.level !== this.level || next.blocksPerMember !== this.state.blocksPerMember || next.members.length !== this.state.members.length) throw new Error('RAID snapshot configuration mismatch');
    return () => { this.state = next; };
  }

  private newOperation(memberIndex: number, sector: number, operation: Operation['operation'], dependsOn: readonly number[] = [], driveId = this.state.members[memberIndex]!.driveId): Operation {
    const id = this.state.nextOperationId; this.state = { ...this.state, nextOperationId: id + 1 };
    return { id, memberIndex, driveId, sectorLba: asBlockId(sector), operation, dependsOn: [...dependsOn], state: { kind: 'planned' } };
  }
  private planRead(logical: number, operations: Operation[]): void {
    const stripe = Math.floor(logical / this.dataWidth); let member = this.dataMembers(stripe)[logical % this.dataWidth]!;
    if (this.level === 1 || this.level === 10) { if (this.state.members[member]!.failed) member += 1; }
    if (!this.state.members[member]!.failed) operations.push(this.newOperation(member, stripe, { kind: 'read' }));
    else for (const [index, value] of this.state.members.entries()) if (!value.failed && !operations.some(op => op.memberIndex === index && op.sectorLba === stripe && op.operation.kind === 'read')) operations.push(this.newOperation(index, stripe, { kind: 'read' }));
  }
  private planWrite(request: StorageRequestSnapshot, operations: Operation[]): void {
    if (request.transfer.kind !== 'write') return;
    const first = request.transfer.lba; const count = request.transfer.data.length / SECTOR;
    const stripes = new Set(Array.from({ length: count }, (_, index) => Math.floor((first + index) / this.dataWidth)));
    for (const stripe of stripes) {
      const changed = this.changedBlocks(request, stripe); const dataMembers = this.dataMembers(stripe);
      if (this.level === 0 || this.level === 1 || this.level === 10) {
        for (const [ordinal, value] of changed) {
          const firstMember = dataMembers[ordinal]!; const copies = this.level === 0 ? [firstMember] : [firstMember, firstMember + 1];
          for (const member of copies) for (const driveId of this.writeTargets(member)) operations.push(this.newOperation(member, stripe, { kind: 'write', source: { kind: 'request', byteOffset: value.offset } }, [], driveId));
        }
        continue;
      }
      const dependencies: number[] = [];
      if (changed.size < this.dataWidth) {
        const reads = this.status === 'healthy' ? [...changed.keys()].map(ordinal => dataMembers[ordinal]!).concat(this.level === 6 ? [this.parityDisk(stripe), this.qDisk(stripe)] : [this.parityDisk(stripe)])
          : this.state.members.flatMap((member, index) => member.failed ? [] : [index]);
        for (const member of reads) { const op = this.newOperation(member, stripe, { kind: 'read' }); operations.push(op); dependencies.push(op.id); }
      }
      for (const [ordinal, value] of changed) {
        const member = dataMembers[ordinal]!;
        for (const driveId of this.writeTargets(member)) operations.push(this.newOperation(member, stripe, { kind: 'write', source: { kind: 'request', byteOffset: value.offset } }, dependencies, driveId));
      }
      for (const parity of this.level === 6 ? ['p', 'q'] as const : ['p'] as const) {
        const member = parity === 'p' ? this.parityDisk(stripe) : this.qDisk(stripe);
        for (const driveId of this.writeTargets(member)) operations.push(this.newOperation(member, stripe, { kind: 'write', source: { kind: parity, stripe } }, dependencies, driveId));
      }
    }
  }
  /** Writes also update an assigned spare; stripe ordering prevents stale rebuild copies. */
  private writeTargets(member: number): readonly string[] {
    if (!this.state.members[member]!.failed) return [this.state.members[member]!.driveId];
    const job = this.state.rebuilds.find(value => value.memberIndex === member); return job === undefined ? [] : [job.spareDriveId];
  }
  private changedBlocks(request: StorageRequestSnapshot, stripe: number): Map<number, { offset: number; data: readonly number[] }> {
    const changed = new Map<number, { offset: number; data: readonly number[] }>();
    if (request.transfer.kind === 'write') for (let offset = 0; offset < request.transfer.data.length; offset += SECTOR) {
      const logical = request.transfer.lba + offset / SECTOR;
      if (Math.floor(logical / this.dataWidth) === stripe) changed.set(logical % this.dataWidth, { offset, data: request.transfer.data.slice(offset, offset + SECTOR) });
    }
    return changed;
  }
  private planRebuild(job: Rebuild, sector: number): void {
    const operations: Operation[] = [];
    if (this.level === 1 || this.level === 10) {
      const mate = job.memberIndex % 2 === 0 ? job.memberIndex + 1 : job.memberIndex - 1;
      const read = this.newOperation(mate, sector, { kind: 'read' }); operations.push(read,
        this.newOperation(job.memberIndex, sector, { kind: 'write', source: { kind: 'mirror', readOperationId: read.id } }, [read.id], job.spareDriveId));
    } else {
      for (const [index, member] of this.state.members.entries()) if (!member.failed) operations.push(this.newOperation(index, sector, { kind: 'read' }));
      const source: Extract<Operation['operation'], { kind: 'write' }>['source'] = job.memberIndex === this.parityDisk(sector)
        ? { kind: 'p', stripe: sector } : this.level === 6 && job.memberIndex === this.qDisk(sector)
          ? { kind: 'q', stripe: sector } : { kind: 'reconstructed', stripe: sector, memberIndex: job.memberIndex };
      operations.push(this.newOperation(job.memberIndex, sector, { kind: 'write', source }, operations.map(op => op.id), job.spareDriveId));
    }
    const id = this.state.nextTransactionId;
    this.state = { ...this.state, nextTransactionId: id + 1, transactions: [...this.state.transactions,
      { id, purpose: { kind: 'rebuild', memberIndex: job.memberIndex, sectorLba: asBlockId(sector) }, operations }] };
  }
  private dispatch(): void {
    for (const tx of [...this.state.transactions]) {
      const stripes = new Set(tx.operations.map(op => op.sectorLba));
      // Serialize competing stripe transactions; the ordered plans are the lock authority.
      if (this.state.transactions.some(older => older.id < tx.id && older.operations.some(op => op.state.kind !== 'settled' && stripes.has(op.sectorLba)))) continue;
      for (const original of tx.operations) {
        const live = this.state.transactions.find(row => row.id === tx.id)!;
        const op = live.operations.find(value => value.id === original.id)!; if (op.state.kind !== 'planned') continue;
        const predecessors = op.dependsOn.map(id => live.operations.find(value => value.id === id));
        if (predecessors.some(value => value?.state.kind !== 'settled')) continue;
        if (this.state.dataLost || predecessors.some(value => value?.state.kind === 'settled' && value.state.result.kind === 'failed')) { this.setOperation(tx.id, op.id, { kind: 'settled', result: failed() }); continue; }
        const member = this.state.members[op.memberIndex]!;
        if (member.driveId === op.driveId && member.failed) { this.setOperation(tx.id, op.id, { kind: 'settled', result: failed() }); continue; }
        let transfer: StorageTransferSnapshot;
        try { transfer = op.operation.kind === 'read' ? { kind: 'read', lba: op.sectorLba, bytes: SECTOR } : { kind: 'write', lba: op.sectorLba, data: this.writeData(live, op) }; }
        catch { this.setOperation(tx.id, op.id, { kind: 'settled', result: failed('storage_corruption') }); continue; }
        const pid = tx.purpose.kind === 'request' ? this.host.request(tx.purpose.requestId)?.pid ?? null : null;
        const physicalOperationId = this.host.issuePhysical(op.driveId, transfer, { kind: 'raid', arrayId: this.arrayId, transactionId: tx.id, operationId: op.id }, pid);
        this.setOperation(tx.id, op.id, { kind: 'submitted', physicalOperationId }); this.increment(op.operation.kind === 'read' ? 'issuedPhysicalReads' : 'issuedPhysicalWrites');
      }
    }
  }
  private writeData(tx: Transaction, op: Operation): readonly number[] {
    if (op.operation.kind !== 'write') throw new Error('write operand missing'); const source = op.operation.source;
    const request = tx.purpose.kind === 'request' ? this.host.request(tx.purpose.requestId) : undefined;
    if (source.kind === 'request') {
      if (request?.transfer.kind !== 'write') throw new Error('RAID write input missing'); return request.transfer.data.slice(source.byteOffset, source.byteOffset + SECTOR);
    }
    if (source.kind === 'mirror') { const read = tx.operations.find(value => value.id === source.readOperationId); if (read?.state.kind !== 'settled' || read.state.result.kind !== 'ok') throw new Error('mirror source missing'); return read.state.result.data; }
    const stripe = source.stripe; const dataMembers = this.dataMembers(stripe);
    if (source.kind === 'reconstructed') return this.stripeData(tx, stripe)[dataMembers.indexOf(source.memberIndex)]!;
    const changed = request === undefined ? new Map<number, { offset: number; data: readonly number[] }>() : this.changedBlocks(request, stripe);
    const oldParity = this.readResult(tx, stripe, source.kind === 'p' ? this.parityDisk(stripe) : this.qDisk(stripe));
    if (changed.size > 0 && changed.size < this.dataWidth && oldParity !== undefined && [...changed.keys()].every(ordinal => this.readResult(tx, stripe, dataMembers[ordinal]!) !== undefined)) {
      const output = [...oldParity];
      for (const [ordinal, next] of changed) {
        const previous = this.readResult(tx, stripe, dataMembers[ordinal]!)!; const coefficient = source.kind === 'p' ? 1 : gfPower(ordinal);
        for (let index = 0; index < SECTOR; index++) output[index] = output[index]! ^ gfMultiply(coefficient, previous[index]! ^ next.data[index]!);
      }
      return output;
    }
    const data = changed.size === this.dataWidth ? dataMembers.map((_, ordinal) => changed.get(ordinal)!.data) : this.stripeData(tx, stripe);
    const updated = data.map((value, ordinal) => changed.get(ordinal)?.data ?? value);
    return parityBytes(updated, source.kind === 'q');
  }
  private readResult(tx: Transaction, stripe: number, member: number): readonly number[] | undefined {
    const op = tx.operations.find(value => value.memberIndex === member && value.sectorLba === stripe && value.operation.kind === 'read');
    return op?.state.kind === 'settled' && op.state.result.kind === 'ok' ? op.state.result.data : undefined;
  }
  private stripeData(tx: Transaction, stripe: number): readonly (readonly number[])[] {
    const members = this.dataMembers(stripe); const data = members.map(member => this.readResult(tx, stripe, member));
    const missing = data.flatMap((value, index) => value === undefined ? [index] : []);
    if (missing.length === 0) return data.map(value => value!);
    const p = this.readResult(tx, stripe, this.parityDisk(stripe)); const q = this.level === 6 ? this.readResult(tx, stripe, this.qDisk(stripe)) : undefined;
    if (missing.length > 2 || (missing.length === 2 && (p === undefined || q === undefined)) || (p === undefined && q === undefined)) throw new Error('insufficient RAID reconstruction sources');
    const residualP = p === undefined ? undefined : [...p]; const residualQ = q === undefined ? undefined : [...q];
    for (const [ordinal, value] of data.entries()) if (value !== undefined) for (let byte = 0; byte < SECTOR; byte++) {
      if (residualP !== undefined) residualP[byte] = residualP[byte]! ^ value[byte]!;
      if (residualQ !== undefined) residualQ[byte] = residualQ[byte]! ^ gfMultiply(gfPower(ordinal), value[byte]!);
    }
    const first = missing[0]!;
    if (missing.length === 1) data[first] = residualP ?? residualQ!.map(value => gfDivide(value, gfPower(first)));
    else {
      const second = missing[1]!; const ca = gfPower(first); const cb = gfPower(second);
      const b = residualQ!.map((value, byte) => gfDivide(value ^ gfMultiply(ca, residualP![byte]!), ca ^ cb));
      data[second] = b; data[first] = b.map((value, byte) => value ^ residualP![byte]!);
    }
    return data.map(value => value!);
  }
  private finishTransaction(tx: Transaction): void {
    const error = tx.operations.find(op => op.state.kind === 'settled' && op.state.result.kind === 'failed');
    let result: StorageResultSnapshot = this.state.dataLost ? failed() : error?.state.kind === 'settled' ? error.state.result : ok();
    if (tx.purpose.kind === 'request') {
      const request = this.host.request(tx.purpose.requestId);
      if (request?.cancelledAtTick !== null && request?.cancelledAtTick !== undefined) result = failed('cancelled');
      if (result.kind === 'ok' && request?.transfer.kind === 'read') {
        const data: number[] = [];
        for (let block = 0; block < Math.ceil(request.transfer.bytes / SECTOR); block++) {
          const logical = request.transfer.lba + block; const stripe = Math.floor(logical / this.dataWidth); const ordinal = logical % this.dataWidth;
          const member = this.dataMembers(stripe)[ordinal]!;
          const direct = this.readResult(tx, stripe, member) ?? ((this.level === 1 || this.level === 10) ? this.readResult(tx, stripe, member + 1) : undefined);
          try { data.push(...direct ?? this.stripeData(tx, stripe)[ordinal]!); } catch { result = failed('storage_corruption'); break; }
        }
        if (result.kind === 'ok') result = ok(data.slice(0, request.transfer.bytes));
      }
      if (result.kind === 'ok' && request !== undefined) {
        const blocks = Math.ceil((request.transfer.kind === 'read' ? request.transfer.bytes : request.transfer.data.length) / SECTOR);
        this.increment(request.transfer.kind === 'read' ? 'completedReadBlocks' : 'completedWriteBlocks', blocks);
      }
      this.host.completeRequest(tx.purpose.requestId, result, this.host.tick());
    } else if (result.kind === 'ok') {
      const purpose = tx.purpose;
      this.state = { ...this.state, rebuilds: this.state.rebuilds.map(job => job.memberIndex === purpose.memberIndex ? markCompleted(job, purpose.sectorLba) : job) };
      this.increment('completedRebuildBlocks');
    }
    this.state = { ...this.state, transactions: this.state.transactions.filter(value => value.id !== tx.id) };
  }
  private nextRebuildSector(job: Rebuild): number | null {
    const active = new Set(this.state.transactions.flatMap(tx => tx.purpose.kind === 'rebuild' && tx.purpose.memberIndex === job.memberIndex ? [tx.purpose.sectorLba] : []));
    for (let sector = job.completedPrefix; sector < this.state.blocksPerMember; sector++) if (!active.has(asBlockId(sector)) && !job.completedBeyondPrefix.includes(asBlockId(sector))) return sector;
    return null;
  }
  private finishRebuilds(): void {
    if (this.state.dataLost || this.state.transactions.some(tx => tx.purpose.kind === 'request')) return;
    for (const job of [...this.state.rebuilds]) if (job.completedPrefix === this.state.blocksPerMember) {
      this.state = { ...this.state, members: this.state.members.map((member, index) => index === job.memberIndex ? { driveId: job.spareDriveId, failed: false } : member),
        rebuilds: this.state.rebuilds.filter(value => value.memberIndex !== job.memberIndex) };
      this.host.emit({ type: 'raid.rebuild', level: this.level, failedDisk: job.memberIndex, progress: 1 });
    }
  }
  private setOperation(transactionId: number, operationId: number, state: Operation['state']): void {
    this.state = { ...this.state, transactions: this.state.transactions.map(tx => tx.id === transactionId ? { ...tx, operations: tx.operations.map(op => op.id === operationId ? { ...op, state } : op) } : tx) };
  }
  private increment(key: keyof StorageRaidSnapshot['counters'], amount = 1): void { this.state = { ...this.state, counters: { ...this.state.counters, [key]: this.state.counters[key] + amount } }; }
}

/** GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d). */
export function gfMultiply(a: number, b: number): number {
  let result = 0; let left = a; let right = b;
  while (right > 0) { if (right & 1) result ^= left; right >>>= 1; left <<= 1; if (left & 0x100) left ^= 0x11d; }
  return result;
}
function gfPower(power: number): number { let result = 1; for (let index = 0; index < power; index++) result = gfMultiply(result, 2); return result; }
function gfDivide(a: number, b: number): number {
  if (b === 0) throw new Error('zero RAID coefficient'); let inverse = 1; let base = b; let power = 254;
  while (power > 0) { if (power & 1) inverse = gfMultiply(inverse, base); base = gfMultiply(base, base); power >>>= 1; }
  return gfMultiply(a, inverse);
}
function parityBytes(data: readonly (readonly number[])[], q: boolean): readonly number[] {
  const result = Array<number>(SECTOR).fill(0);
  for (const [ordinal, block] of data.entries()) for (let index = 0; index < SECTOR; index++) result[index] = result[index]! ^ gfMultiply(q ? gfPower(ordinal) : 1, block[index]!);
  return result;
}
function markCompleted(job: Rebuild, sector: BlockId): Rebuild {
  if (sector < job.completedPrefix) return job;
  const completed = new Set<number>([...job.completedBeyondPrefix, sector]); let prefix = job.completedPrefix;
  while (completed.delete(prefix)) prefix++;
  return { ...job, completedPrefix: prefix, completedBeyondPrefix: [...completed].sort((a, b) => a - b).map(asBlockId) };
}
function integer(value: number, name: string, minimum = 0): number { if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`invalid ${name}`); return value; }
function validateLayout(level: RaidLevel, count: number): void {
  integer(count, 'RAID members', 1);
  if (![0, 1, 4, 5, 6, 10].includes(level) || ((level === 1 || level === 10) && (count < 2 || count % 2 !== 0))
    || ((level === 4 || level === 5) && count < 3) || (level === 6 && (count < 4 || count > 257))) throw new RangeError('invalid RAID layout');
}
function survives(level: RaidLevel, failures: readonly boolean[]): boolean {
  if (level === 0) return !failures.some(Boolean);
  if (level === 1 || level === 10) return failures.every((failedMember, index) => !failedMember || !failures[index % 2 === 0 ? index + 1 : index - 1]);
  return failures.filter(Boolean).length <= (level === 6 ? 2 : 1);
}
function validateState(s: StorageRaidSnapshot, lookup: (id: number) => StorageRequestSnapshot | undefined): void {
  validateLayout(s.level, s.members.length); integer(s.blocksPerMember, 'member blocks', 1); integer(s.nextTransactionId, 'next RAID transaction'); integer(s.nextOperationId, 'next RAID operation');
  if (typeof s.dataLost !== 'boolean' || typeof s.rebuildPaused !== 'boolean' || s.members.some(member => typeof member.failed !== 'boolean' || typeof member.driveId !== 'string')
    || (!survives(s.level, s.members.map(member => member.failed)) && !s.dataLost)) throw new Error('invalid RAID availability');
  const drives = [...s.members.map(member => member.driveId), ...s.spareDriveIds, ...s.rebuilds.map(job => job.spareDriveId)];
  if (typeof s.arrayId !== 'string' || s.arrayId.length === 0 || drives.some(id => typeof id !== 'string' || id.length === 0) || new Set(drives).size !== drives.length) throw new Error('RAID drive ownership overlaps');
  const txIds = new Set<number>(); const opIds = new Set<number>(); const physical = new Set<number>();
  for (const [index, tx] of s.transactions.entries()) {
    integer(tx.id, 'transaction ID'); if (tx.id >= s.nextTransactionId || txIds.has(tx.id)) throw new Error('duplicate RAID transaction'); txIds.add(tx.id);
    if (index > 0 && s.transactions[index - 1]!.id >= tx.id) throw new Error('RAID transactions are not ordered');
    if (tx.purpose.kind === 'request') { integer(tx.purpose.requestId, 'request owner'); if (lookup(tx.purpose.requestId) === undefined) throw new Error('RAID request owner missing'); }
    else if (tx.purpose.kind === 'rebuild') {
      integer(tx.purpose.memberIndex, 'rebuild owner'); integer(tx.purpose.sectorLba, 'rebuilt sector');
      const purpose = tx.purpose;
      if (!s.rebuilds.some(job => job.memberIndex === purpose.memberIndex && purpose.sectorLba < job.nextSectorToIssue)) throw new Error('RAID rebuild owner missing');
    } else throw new Error('invalid RAID transaction purpose');
    for (const [operationIndex, op] of tx.operations.entries()) {
      integer(op.id, 'operation ID'); integer(op.memberIndex, 'operation member'); integer(op.sectorLba, 'operation sector');
      if (op.id >= s.nextOperationId || opIds.has(op.id) || op.memberIndex >= s.members.length || op.sectorLba >= s.blocksPerMember) throw new Error('invalid RAID operation'); opIds.add(op.id);
      if (operationIndex > 0 && tx.operations[operationIndex - 1]!.id >= op.id) throw new Error('RAID operations are not ordered');
      if (op.driveId !== s.members[op.memberIndex]!.driveId && !s.rebuilds.some(job => job.memberIndex === op.memberIndex && job.spareDriveId === op.driveId)) throw new Error('RAID operation drive ownership mismatch');
      if (op.dependsOn.some(id => id >= op.id || !tx.operations.some(value => value.id === id))) throw new Error('invalid RAID dependency');
      if (new Set(op.dependsOn).size !== op.dependsOn.length) throw new Error('duplicate RAID dependency');
      if (op.operation.kind === 'write') {
        const source = op.operation.source;
        if (source.kind === 'request') {
          integer(source.byteOffset, 'write source offset');
          const request = tx.purpose.kind === 'request' ? lookup(tx.purpose.requestId) : undefined;
          if (request?.transfer.kind !== 'write' || source.byteOffset % SECTOR !== 0 || source.byteOffset + SECTOR > request.transfer.data.length) throw new Error('invalid RAID write source');
        } else if (source.kind === 'mirror') {
          if (!op.dependsOn.includes(source.readOperationId) || tx.operations.find(value => value.id === source.readOperationId)?.operation.kind !== 'read') throw new Error('invalid mirror dependency');
        } else if (source.kind === 'p' || source.kind === 'q' || source.kind === 'reconstructed') {
          integer(source.stripe, 'parity stripe'); if (source.stripe !== op.sectorLba || (source.kind === 'q' && s.level !== 6)) throw new Error('invalid parity write source');
          if (source.kind === 'reconstructed') { integer(source.memberIndex, 'reconstruction member'); if (source.memberIndex !== op.memberIndex) throw new Error('invalid reconstruction target'); }
        } else throw new Error('invalid RAID write operand');
      } else if (op.operation.kind !== 'read') throw new Error('invalid RAID operation kind');
      if (op.state.kind === 'submitted') { integer(op.state.physicalOperationId, 'physical operation'); if (physical.has(op.state.physicalOperationId)) throw new Error('duplicate submitted operation'); physical.add(op.state.physicalOperationId); }
      else if (op.state.kind !== 'planned' && op.state.kind !== 'settled') throw new Error('invalid operation state');
      if (op.state.kind === 'settled' && op.state.result.kind === 'ok' && (op.state.result.data.length !== (op.operation.kind === 'read' ? SECTOR : 0)
        || op.state.result.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))) throw new Error('invalid physical result');
      if (op.state.kind === 'settled' && op.state.result.kind !== 'ok' && (op.state.result.kind !== 'failed' || !['device_failed', 'cancelled', 'storage_corruption', 'io_timeout'].includes(op.state.result.reason))) throw new Error('invalid RAID failure result');
    }
  }
  const repairs = new Set<number>();
  for (const job of s.rebuilds) {
    integer(job.memberIndex, 'repair member'); integer(job.nextSectorToIssue, 'repair cursor'); integer(job.completedPrefix, 'repair prefix'); integer(job.nextProgressAtTick, 'progress deadline');
    if (!s.members[job.memberIndex]?.failed || repairs.has(job.memberIndex) || job.nextSectorToIssue > s.blocksPerMember || job.completedPrefix > job.nextSectorToIssue) throw new Error('invalid rebuild cursor'); repairs.add(job.memberIndex);
    if (job.completedBeyondPrefix.some((sector, index) => !Number.isSafeInteger(sector) || sector <= job.completedPrefix || sector >= job.nextSectorToIssue || (index > 0 && job.completedBeyondPrefix[index - 1]! >= sector))) throw new Error('invalid rebuild frontier');
  }
  for (const value of Object.values(s.counters)) integer(value, 'RAID counter');
}
