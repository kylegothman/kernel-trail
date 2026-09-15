import type { BlockId, DeviceId } from '../types';
import { Journal, type JournalHost, type MutableFsPayload } from './journal';

export interface CrashHost extends JournalHost {
  dropDirty(): readonly { readonly device: DeviceId; readonly sectorLba: BlockId }[];
  abortIo(): void;
  /** Decode completed storage sectors after all volatile work was discarded. */
  reloadMetadata?(): void;
}

/** The leg chooses when to call this; no random stream participates in a crash. */
export function crashFileSystem(host: CrashHost, journal = new Journal(host)): void {
  const state = host.state() as MutableFsPayload;
  const dropped = host.dropDirty(), aborted = state.transfers.filter(transfer => transfer.progress.kind !== 'settled').map(transfer => transfer.id);
  journal.crash(); host.abortIo();
  for (const transfer of state.transfers) if (transfer.progress.kind !== 'settled') transfer.progress = {
    kind: 'settled', atTick: host.tick(), result: { kind: 'failed', reason: 'cancelled' },
  };
  for (const operation of state.operations) if (operation.stage !== 'complete') {
    operation.stage = 'complete'; operation.result = { ok: false, errno: 'EINVAL', message: 'filesystem operation interrupted by crash' }; operation.wakeable = true;
  }
  state.recovery = null; state.mountState = 'crashed'; state.durableMetadata.length = 0;
  state.caches.dentries.length = 0; state.caches.metadata.length = 0;
  state.lastCrash = { tick: host.tick(), abortedTransferIds: aborted, droppedCacheBlocks: dropped.map(item => ({ ...item })), panicEmitted: false };
  host.reloadMetadata?.(); host.emit({ type: 'kernel.panic', message: 'crash' }); state.lastCrash.panicEmitted = true;
}
