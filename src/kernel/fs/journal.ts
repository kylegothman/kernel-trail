import type { EmittableEvent } from '../EventBus';
import type { BlockId, FsMetadataDeltaSnapshot, FsMetadataSnapshot, FsSnapshotState,
  FsTransactionSnapshot, FsTransferSnapshot, InodeId, Tick } from '../types';

export type Mutable<T> = T extends string | number | boolean | null ? T
  : T extends readonly (infer U)[] ? Mutable<U>[] : { -readonly [K in keyof T]: Mutable<T[K]> };
export type MutableFsPayload = Mutable<FsSnapshotState['payload']>;
export type JournalImage = Omit<FsTransactionSnapshot['images'][number],
  'checksum' | 'journalBlock' | 'journalTransferId' | 'homeTransferId'>;
export interface JournalHost {
  state(): FsSnapshotState['payload'];
  tick(): Tick;
  emit(event: EmittableEvent): void;
  submit(purpose: FsTransferSnapshot['purpose'], command: FsTransferSnapshot['command']): number;
  transfer(id: number): FsTransferSnapshot | undefined;
  /** False only for off-mode volatile cache acceptance, never a journal barrier. */
  isDurable?(id: number): boolean;
  /** Off-mode write-back admission is explicitly volatile and creates no false ACK. */
  admitVolatile?(transaction: FsTransactionSnapshot): boolean | null;
}
export const emptyMetadataDelta = (): Mutable<FsMetadataDeltaSnapshot> => ({
  inodes: [], directories: [], freeSpace: null, inodeAllocator: null, inodeGenerations: [], blockGenerations: [],
});

/** Metadata changes are idempotent assignments, never increments during replay. */
export function applyMetadataDelta(metadata: Mutable<FsMetadataSnapshot>, delta: FsMetadataDeltaSnapshot,
  direction: 'after' | 'before' = 'after'): void {
  for (const item of delta.inodes) {
    const index = metadata.inodes.findIndex(inode => inode.id === item.id), value = item[direction];
    if (index >= 0) metadata.inodes.splice(index, 1);
    if (value !== null) metadata.inodes.push(structuredClone(value) as Mutable<typeof value>);
  }
  metadata.inodes.sort((a, b) => a.id - b.id);
  for (const item of delta.directories) {
    const index = metadata.directories.findIndex(directory => directory.inode === item.inode), value = item[direction];
    if (index >= 0) metadata.directories.splice(index, 1);
    if (value !== null) metadata.directories.push(structuredClone(value) as Mutable<typeof value>);
  }
  metadata.directories.sort((a, b) => a.inode - b.inode);
  if (delta.freeSpace !== null) metadata.freeSpace = structuredClone(delta.freeSpace[direction]) as Mutable<typeof metadata.freeSpace>;
  if (delta.inodeAllocator !== null) {
    metadata.nextInodeId = direction === 'after' ? delta.inodeAllocator.nextAfter : delta.inodeAllocator.nextBefore;
    metadata.freeInodeIds = [...(direction === 'after' ? delta.inodeAllocator.freeAfter : delta.inodeAllocator.freeBefore)];
  }
  for (const item of delta.inodeGenerations) {
    metadata.inodeGenerations = metadata.inodeGenerations.filter(entry => entry.inode !== item.inode);
    const generation = item[direction]; if (generation !== null) metadata.inodeGenerations.push({ inode: item.inode, generation });
  }
  metadata.inodeGenerations.sort((a, b) => a.inode - b.inode);
  for (const item of delta.blockGenerations) {
    metadata.blockGenerations = metadata.blockGenerations.filter(entry => entry.block !== item.block);
    const generation = item[direction]; if (generation !== null) metadata.blockGenerations.push({ block: item.block, generation });
  }
  metadata.blockGenerations.sort((a, b) => a.block - b.block);
}

/** Fixed-width finite byte checksum. It checks media damage, not authenticity. */
export function imageChecksum(contents: readonly number[]): number {
  let hash = 2166136261;
  for (const byte of contents) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}
function byteString(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const value = character.codePointAt(0)!;
    if (value < 128) bytes.push(value);
    else if (value < 2048) bytes.push(192 | (value >>> 6), 128 | (value & 63));
    else if (value < 65536) bytes.push(224 | (value >>> 12), 128 | ((value >>> 6) & 63), 128 | (value & 63));
    else bytes.push(240 | (value >>> 18), 128 | ((value >>> 12) & 63), 128 | ((value >>> 6) & 63), 128 | (value & 63));
  }
  return bytes;
}
/** Versioned bounded metadata/control codec; no process-specific object identity. */
export function encodeFsRecord(value: unknown, bytes = 4096): number[] {
  const encoded = byteString(JSON.stringify(value));
  if (encoded.length > bytes - 8) throw new RangeError('ENOSPC: filesystem image exceeds its reserved bytes');
  const output = Array<number>(bytes).fill(0);
  output.splice(0, 8, 75, 84, 70, 1, encoded.length & 255, (encoded.length >>> 8) & 255,
    (encoded.length >>> 16) & 255, (encoded.length >>> 24) & 255);
  output.splice(8, encoded.length, ...encoded); return output;
}
export function decodeFsRecord(contents: readonly number[]): unknown {
  if (contents[0] !== 75 || contents[1] !== 84 || contents[2] !== 70 || contents[3] !== 1) throw new RangeError('invalid filesystem image header');
  const length = ((contents[4] ?? 0) | ((contents[5] ?? 0) << 8) | ((contents[6] ?? 0) << 16) | ((contents[7] ?? 0) << 24)) >>> 0;
  if (length > contents.length - 8) throw new RangeError('invalid filesystem image length');
  let text = '';
  for (let cursor = 8; cursor < 8 + length;) {
    const first = contents[cursor++]!; let point = first;
    const extra = first < 128 ? 0 : first < 224 ? 1 : first < 240 ? 2 : 3;
    if (extra > 0) point &= (1 << (6 - extra)) - 1;
    for (let i = 0; i < extra; i++) {
      const next = contents[cursor++];
      if (next === undefined || next < 128 || next > 191 || cursor > 8 + length) throw new RangeError('invalid filesystem UTF-8');
      point = (point << 6) | (next & 63);
    }
    text += String.fromCodePoint(point);
  }
  return JSON.parse(text) as unknown;
}

export function fsSector(state: FsSnapshotState['payload'], block: BlockId, sector = 0): BlockId {
  if (state.volume === null) throw new RangeError('filesystem is not formatted');
  return (state.volume.firstSector + block * 8 + sector) as BlockId;
}

/** Serialized write-ahead transactions. All continuation lives in the FS DTO. */
export class Journal {
  constructor(private readonly host: JournalHost) {}
  private get state(): MutableFsPayload { return this.host.state() as MutableFsPayload; }
  prepare(input: { readonly images: readonly JournalImage[]; readonly changes?: FsMetadataDeltaSnapshot;
    readonly operationId?: number | null; readonly mode?: FsTransactionSnapshot['mode'] }): number {
    const state = this.state, volume = state.volume;
    if (volume === null) throw new RangeError('filesystem is not formatted');
    const mode = input.mode ?? state.settings.journalMode, id = state.nextTransactionId;
    const reserved = new Set<number>(), seen = new Set<number>();
    for (let b = volume.journalPayloadStart; b < volume.journalPayloadStart + volume.journalPayloadBlocks; b++) reserved.add(b);
    reserved.add(volume.journalControlBlock);
    let offset = 0;
    const images: Mutable<FsTransactionSnapshot['images']> = input.images.map(image => {
      if (!Number.isSafeInteger(image.homeBlock) || image.homeBlock < 0 || image.homeBlock >= volume.blockCount
        || seen.has(image.homeBlock) || reserved.has(image.homeBlock) || image.contents.length !== 4096
        || image.contents.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new RangeError('invalid transaction image');
      seen.add(image.homeBlock);
      const journaled = mode === 'full' || mode === 'metadata' && image.kind !== 'data';
      const journalBlock = journaled ? (volume.journalPayloadStart + offset++) as BlockId : null;
      return { ...structuredClone(image), contents: [...image.contents], checksum: imageChecksum(image.contents), journalBlock,
        journalTransferId: null, homeTransferId: null };
    });
    if (offset > volume.journalPayloadBlocks) throw new RangeError('ENOSPC: transaction exceeds journal reservation');
    const ranges: number[][] = [];
    for (const image of images.filter(item => item.journalBlock !== null)) {
      const kind = ['data', 'inode', 'directory', 'allocation', 'superblock'].indexOf(image.kind), prior = ranges.at(-1);
      if (prior !== undefined && prior[0]! + prior[2]! === image.homeBlock && prior[1]! + prior[2]! === image.journalBlock
        && prior[3] === kind) { prior[2] = prior[2]! + 1; prior[4] = (Math.imul(prior[4]!, 31) ^ image.checksum) >>> 0; }
      else ranges.push([image.homeBlock, image.journalBlock!, 1, kind, image.checksum]);
    }
    const groups: number[][][] = [[]];
    for (const range of ranges) {
      const group = groups.at(-1)!;
      try { encodeFsRecord({ v: 1, tx: id, mode, ranges: [...group, range] }, 512); group.push(range); }
      catch { groups.push([range]); }
    }
    if (groups.length > 6 && mode !== 'off') throw new RangeError('ENOSPC: journal descriptors exceed six reserved sectors');
    const controls: Mutable<FsTransactionSnapshot['controls']> = mode === 'off' ? [] : [
      ...groups.map((group, index) => ({ phase: 'descriptors' as const, sectorLba: fsSector(state, volume.journalControlBlock, index),
        contents: encodeFsRecord({ v: 1, tx: id, mode, ranges: group }, 512), transferId: null })),
      { phase: 'commit', sectorLba: fsSector(state, volume.journalControlBlock, groups.length), contents: encodeFsRecord({ v: 1, tx: id, phase: 'commit' }, 512), transferId: null },
      { phase: 'checkpoint', sectorLba: fsSector(state, volume.journalControlBlock, groups.length + 1), contents: encodeFsRecord({ v: 1, tx: id, phase: 'checkpoint' }, 512), transferId: null },
    ];
    const tx: Mutable<FsTransactionSnapshot> = { id, operationId: input.operationId ?? null, requestedAtTick: this.host.tick(), mode,
      stage: 'prepared', changes: structuredClone(input.changes ?? emptyMetadataDelta()) as Mutable<FsMetadataDeltaSnapshot>,
      changesApplied: false, images, controls, firstBarrierAtTick: null, secondBarrierAtTick: null, checkpointAtTick: null, failure: null };
    state.nextTransactionId++; state.journal.transactions.push(tx); return id;
  }
  isComplete(id: number): boolean { return this.state.journal.transactions.find(tx => tx.id === id)?.stage === 'complete'; }
  private append(tx: Mutable<FsTransactionSnapshot>, phase: 'begin' | 'write' | 'commit' | 'checkpoint'): void {
    const entry = { tick: this.host.tick(), txId: tx.id, phase,
      blocks: phase === 'begin' || phase === 'commit' ? [] : tx.images.filter(image => image.journalBlock !== null).map(image => image.homeBlock) };
    this.state.journal.entries.push(entry); this.host.emit({ type: 'fs.journal', entry: structuredClone(entry) });
  }
  private control(tx: Mutable<FsTransactionSnapshot>, index: number): void {
    const control = tx.controls[index]!;
    control.transferId = this.host.submit({ kind: 'journal', txId: tx.id, phase: control.phase },
      { kind: 'write', sectorLba: control.sectorLba, source: { kind: 'transaction_control', txId: tx.id, controlIndex: index } });
  }
  private acknowledged(tx: Mutable<FsTransactionSnapshot>, ids: readonly (number | null)[]): boolean {
    let complete = true;
    for (const id of ids) {
      const progress = id === null ? undefined : this.host.transfer(id)?.progress;
      if (progress?.kind !== 'settled') { complete = false; continue; }
      if (progress.result.kind === 'failed') {
        tx.stage = 'aborted'; tx.failure = { errno: 'EINVAL', message: `filesystem transfer failed: ${progress.result.reason}` }; return false;
      }
    }
    return complete;
  }
  private flushJournalPayload(tx: Mutable<FsTransactionSnapshot>): boolean {
    return this.acknowledged(tx, [...tx.images.filter(image => image.journalBlock !== null).map(image => image.journalTransferId),
      ...tx.controls.filter(control => control.phase === 'descriptors').map(control => control.transferId)]);
  }
  private flushJournalCommit(tx: Mutable<FsTransactionSnapshot>): boolean { return this.acknowledged(tx, [tx.controls.find(control => control.phase === 'commit')!.transferId]); }
  advance(): void {
    const state = this.state;
    if (state.mountState === 'crashed' || state.recovery !== null) return;
    const tx = state.journal.transactions.find(item => item.stage !== 'complete' && item.stage !== 'aborted');
    if (tx === undefined) return;
    switch (tx.stage) {
      case 'prepared':
        if (tx.mode === 'off' && this.host.admitVolatile !== undefined) {
          const admitted = this.host.admitVolatile(tx);
          if (admitted === false) return;
          if (admitted === true) { applyMetadataDelta(state.metadata, tx.changes); tx.changesApplied = true; tx.stage = 'complete'; return; }
        }
        if (tx.mode === 'off') { tx.stage = 'home'; return; }
        this.append(tx, 'begin'); tx.stage = 'payload'; return;
      case 'payload':
        // Only the first actual overwrite invalidates the last retained image set.
        for (const old of state.journal.transactions) {
          if (old.id === tx.id || old.stage !== 'complete') continue;
          const activeSource = state.transfers.some(transfer => transfer.progress.kind !== 'settled' && transfer.command.kind === 'write'
            && transfer.command.source.kind !== 'inline' && transfer.command.source.txId === old.id);
          if (activeSource) continue;
          state.transfers = state.transfers.filter(transfer => transfer.purpose.kind !== 'journal' || transfer.purpose.txId !== old.id || transfer.progress.kind !== 'settled');
          old.images.length = 0; old.controls.length = 0; old.changes = emptyMetadataDelta();
        }
        state.journal.retained = null;
        this.append(tx, 'write');
        for (let index = 0; index < tx.images.length; index++) {
          const image = tx.images[index]!; if (image.journalBlock === null) continue;
          image.journalTransferId = this.host.submit({ kind: 'journal', txId: tx.id, phase: 'payload' },
            { kind: 'write', sectorLba: fsSector(state, image.journalBlock), source: { kind: 'transaction_image', txId: tx.id, imageIndex: index } });
        }
        for (let index = 0; index < tx.controls.length; index++) if (tx.controls[index]!.phase === 'descriptors') this.control(tx, index);
        tx.stage = 'barrier1'; return;
      case 'barrier1':
        if (!this.flushJournalPayload(tx)) return;
        tx.firstBarrierAtTick = this.host.tick(); tx.stage = 'commit'; return;
      case 'commit': this.append(tx, 'commit'); this.control(tx, tx.controls.findIndex(control => control.phase === 'commit')); tx.stage = 'barrier2'; return;
      case 'barrier2':
        if (!this.flushJournalCommit(tx)) return;
        tx.secondBarrierAtTick = this.host.tick(); tx.stage = 'home'; return;
      case 'home': {
        if (tx.images.some(image => image.homeTransferId === null)) {
          for (let index = 0; index < tx.images.length; index++) {
            const image = tx.images[index]!; if (image.homeTransferId !== null) continue;
            image.homeTransferId = this.host.submit({ kind: 'journal', txId: tx.id, phase: 'home' },
              { kind: 'write', sectorLba: fsSector(state, image.homeBlock), source: { kind: 'transaction_image', txId: tx.id, imageIndex: index } });
          }
          return;
        }
        if (!this.acknowledged(tx, tx.images.map(image => image.homeTransferId))) return;
        applyMetadataDelta(state.metadata, tx.changes); tx.changesApplied = true;
        for (const image of tx.images) {
          if (image.kind === 'data' || image.homeTransferId !== null && this.host.isDurable?.(image.homeTransferId) === false) continue;
          const prior = state.durableMetadata.findIndex(item => item.block === image.homeBlock);
          if (prior >= 0) state.durableMetadata.splice(prior, 1);
          state.durableMetadata.push({ block: image.homeBlock, generation: image.generation, kind: image.kind, contents: [...image.contents] });
        }
        state.durableMetadata.sort((a, b) => a.block - b.block);
        if (tx.mode === 'off') { tx.stage = 'complete'; tx.checkpointAtTick = this.host.tick(); return; }
        tx.stage = 'checkpoint'; return;
      }
      case 'checkpoint': {
        const controlIndex = tx.controls.findIndex(control => control.phase === 'checkpoint'), control = tx.controls[controlIndex]!;
        if (control.transferId === null) { this.append(tx, 'checkpoint'); this.control(tx, controlIndex); return; }
        if (!this.acknowledged(tx, [control.transferId])) return;
        tx.checkpointAtTick = this.host.tick(); tx.stage = 'complete'; state.journal.checkpointedThrough = tx.id;
        state.journal.retained = { txId: tx.id, mode: tx.mode as 'metadata' | 'full', images: tx.images.filter(image => image.journalBlock !== null).map(image => ({
          homeBlock: image.homeBlock, journalBlock: image.journalBlock!, generation: image.generation, checksum: image.checksum,
          kind: image.kind, inode: image.inode, inodeGeneration: image.inodeGeneration,
        })) }; return;
      }
      default: return;
    }
  }
  /** Forget protocol records beyond an acknowledged barrier without changing media. */
  crash(): void {
    const state = this.state;
    for (const tx of state.journal.transactions) {
      if (tx.stage === 'complete' || tx.stage === 'aborted') continue;
      // Completion may have landed earlier in this phase before the FS timer ran.
      if (tx.mode !== 'off' && tx.controls[0]!.transferId !== null && tx.firstBarrierAtTick === null && this.flushJournalPayload(tx)) tx.firstBarrierAtTick = this.host.tick();
      if (tx.mode !== 'off' && tx.firstBarrierAtTick !== null && tx.controls.find(control => control.phase === 'commit')!.transferId !== null && tx.secondBarrierAtTick === null && this.flushJournalCommit(tx)) tx.secondBarrierAtTick = this.host.tick();
      if (tx.secondBarrierAtTick === null) {
        tx.stage = 'aborted'; tx.failure = { errno: 'EINVAL', message: 'crash before durable commit' };
        state.journal.entries = state.journal.entries.filter(entry => entry.txId !== tx.id
          || tx.firstBarrierAtTick !== null && (entry.phase === 'begin' || entry.phase === 'write'));
      } else {
        tx.stage = 'home';
        state.journal.entries = state.journal.entries.filter(entry => entry.txId !== tx.id || entry.phase !== 'checkpoint');
      }
    }
    state.caches.dentries.length = 0; state.caches.metadata.length = 0;
  }
}

export function affectedInodes(changes: FsMetadataDeltaSnapshot): InodeId[] {
  return [...new Set(changes.inodes.map(item => item.id))].sort((a, b) => a - b);
}
