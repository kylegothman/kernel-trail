import type { FsMetadataDeltaSnapshot, FsTransactionSnapshot, InodeId } from '../types';
import { affectedInodes, applyMetadataDelta, emptyMetadataDelta, fsSector, imageChecksum,
  type JournalHost, type Mutable, type MutableFsPayload } from './journal';
import { rebuiltFreeSpace, scanFileSystem, verifyFileSystem } from './fsck';

/** Reads the acknowledged journal bytes and replays homes in transaction order. */
export class Recovery {
  constructor(private readonly host: JournalHost) {}
  private get state(): MutableFsPayload { return this.host.state() as MutableFsPayload; }
  start(includeCheckpointed = false): void {
    const state = this.state;
    if (state.recovery !== null) throw new RangeError('filesystem recovery already active');
    state.recovery = { kind: 'journal', phase: 'scan', targetInode: null, targetGeneration: null,
      transactionIds: state.journal.transactions.filter(tx => tx.secondBarrierAtTick !== null
        && (includeCheckpointed || tx.checkpointAtTick === null)).map(tx => tx.id).sort((a, b) => a - b),
      nextTransaction: 0, nextImage: 0, bitmapWordCursor: 0, transferIds: [], changes: emptyMetadataDelta(), recoveredInodes: [] };
  }
  rebuildInodeFromJournal(inode: InodeId): boolean {
    const state = this.state, retained = state.journal.retained;
    if (state.recovery !== null || retained === null) return false;
    const latest = state.metadata.inodeGenerations.find(item => item.inode === inode)?.generation;
    const images = retained.images.filter(image => image.inode === inode && image.inodeGeneration === latest);
    if (images.length === 0 || !images.some(image => image.kind === 'inode')) return false;
    const tx = state.journal.transactions.find(item => item.id === retained.txId); if (tx === undefined) return false;
    state.recovery = { kind: 'reconstruct', phase: 'scan', targetInode: inode, targetGeneration: latest ?? null,
      transactionIds: [tx.id], nextTransaction: 0, nextImage: 0, bitmapWordCursor: 0, transferIds: [],
      changes: emptyMetadataDelta(), recoveredInodes: [] }; return true;
  }
  private fail(inode: InodeId | null): void {
    this.host.emit({ type: 'fs.corruption', inode: inode ?? this.state.volume!.rootInode, recoverable: false });
    this.state.recovery = null; this.state.mountState = 'crashed';
  }
  private targetChanges(tx: FsTransactionSnapshot): FsMetadataDeltaSnapshot {
    const recovery = this.state.recovery!;
    if (recovery.kind !== 'reconstruct') return tx.changes;
    return { ...emptyMetadataDelta(), inodes: tx.changes.inodes.filter(item => item.id === recovery.targetInode),
      inodeGenerations: tx.changes.inodeGenerations.filter(item => item.inode === recovery.targetInode),
      blockGenerations: tx.changes.blockGenerations.filter(item => tx.images.some(image => image.inode === recovery.targetInode && image.homeBlock === item.block)) };
  }
  advance(): void {
    const state = this.state, recovery = state.recovery; if (recovery === null) return;
    switch (recovery.phase) {
      case 'scan':
        for (const tx of state.journal.transactions) if (tx.secondBarrierAtTick === null && tx.mode !== 'off') {
          if (tx.changesApplied) applyMetadataDelta(state.metadata, tx.changes, 'before');
          tx.changesApplied = false; tx.stage = 'aborted';
        }
        recovery.phase = 'replay'; return;
      case 'replay': {
        const id = recovery.transactionIds[recovery.nextTransaction];
        if (id === undefined) { recovery.phase = 'bitmap'; return; }
        const tx = state.journal.transactions.find(item => item.id === id);
        if (tx === undefined) { this.fail(recovery.targetInode); return; }
        const images = tx.images.filter(image => image.journalBlock !== null && (recovery.kind !== 'reconstruct'
          || image.inode === recovery.targetInode && image.inodeGeneration === recovery.targetGeneration));
        const image = images[recovery.nextImage];
        if (image === undefined) {
          const changes = this.targetChanges(tx);
          applyMetadataDelta(state.metadata, changes); tx.changesApplied = true;
          for (const inode of affectedInodes(changes)) if (!recovery.recoveredInodes.includes(inode)) {
            this.host.emit({ type: 'fs.recovered', inode, fromJournal: true }); recovery.recoveredInodes.push(inode);
          }
          const controlIndex = tx.controls.findIndex(control => control.phase === 'checkpoint');
          if (recovery.kind !== 'reconstruct' && controlIndex !== -1) {
            if (recovery.transferIds.length === 0) {
              const control = tx.controls[controlIndex]!;
              recovery.transferIds.push(this.host.submit({ kind: 'recovery' }, { kind: 'write', sectorLba: control.sectorLba,
                source: { kind: 'transaction_control', txId: tx.id, controlIndex } })); return;
            }
            const progress = this.host.transfer(recovery.transferIds[0]!)?.progress;
            if (progress?.kind !== 'settled') return;
            if (progress.result.kind === 'failed') { this.fail(recovery.targetInode); return; }
            tx.checkpointAtTick = this.host.tick(); tx.stage = 'complete'; state.journal.checkpointedThrough = Math.max(state.journal.checkpointedThrough, tx.id);
            if (!state.journal.entries.some(entry => entry.txId === tx.id && entry.phase === 'checkpoint')) {
              const entry = { tick: this.host.tick(), txId: tx.id, phase: 'checkpoint' as const, blocks: images.map(item => item.homeBlock) };
              state.journal.entries.push(entry); this.host.emit({ type: 'fs.journal', entry });
            }
          }
          recovery.nextTransaction++; recovery.nextImage = 0; recovery.transferIds.length = 0; return;
        }
        if (recovery.transferIds.length === 0) {
          recovery.transferIds.push(this.host.submit({ kind: 'recovery' }, { kind: 'read', sectorLba: fsSector(state, image.journalBlock!), bytes: 4096 })); return;
        }
        const read = this.host.transfer(recovery.transferIds[0]!)?.progress;
        if (read?.kind !== 'settled') return;
        if (read.result.kind === 'failed' || imageChecksum(read.result.data) !== image.checksum) { this.fail(image.inode); return; }
        if (recovery.transferIds.length === 1) {
          recovery.transferIds.push(this.host.submit({ kind: 'recovery' }, { kind: 'write', sectorLba: fsSector(state, image.homeBlock),
            source: { kind: 'inline', contents: read.result.data } })); return;
        }
        const write = this.host.transfer(recovery.transferIds[1]!)?.progress;
        if (write?.kind !== 'settled') return;
        if (write.result.kind === 'failed') { this.fail(image.inode); return; }
        if (image.kind !== 'data') {
          state.durableMetadata = state.durableMetadata.filter(item => item.block !== image.homeBlock);
          state.durableMetadata.push({ block: image.homeBlock, generation: image.generation, kind: image.kind, contents: [...read.result.data] });
          state.durableMetadata.sort((a, b) => a.block - b.block);
        }
        recovery.nextImage++; recovery.transferIds.length = 0; return;
      }
      case 'bitmap': {
        const words = Math.ceil((state.volume?.blockCount ?? 0) / 32);
        // Word inspections are CPU bookkeeping, not one physical read per word.
        state.counters.bitmapWordsScanned += words - recovery.bitmapWordCursor; recovery.bitmapWordCursor = words;
        state.metadata.freeSpace = structuredClone(rebuiltFreeSpace(state)) as Mutable<typeof state.metadata.freeSpace>;
        recovery.phase = 'verify'; return;
      }
      case 'verify': {
        const issues = scanFileSystem(state, this.host.tick());
        state.corruption = issues.map(issue => ({ ...issue, reported: true }));
        for (const issue of issues) this.host.emit({ type: 'fs.corruption', inode: issue.inode ?? state.volume!.rootInode,
          recoverable: issue.kind === 'orphan_inode' || issue.kind === 'leaked_block' });
        state.mountState = 'mounted';
        try { verifyFileSystem(this.host); } catch { if (issues.length === 0) this.host.emit({ type: 'fs.corruption', inode: state.volume!.rootInode, recoverable: false }); }
        state.recovery = null; return;
      }
    }
  }
}
