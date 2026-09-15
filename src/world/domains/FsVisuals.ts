import type { FsVisuals as FsContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class FsVisuals extends DomainVisuals implements FsContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onBlockAllocated(e: KernelEventOf<'fs.block_allocated'>, _c: WorldEventContext): void { this.spawn('journal_stamp', this.cyan(), 0.26, 1, e.block as number); }
  onFragmented(e: KernelEventOf<'fs.fragmented'>, _c: WorldEventContext): void { this.spawn('denial_ward', this.amber(), 0.4, 1, e.extents); }
  onJournal(e: KernelEventOf<'fs.journal'>, _c: WorldEventContext): void { this.spawn('journal_stamp', this.cyan(), e.entry.phase === 'commit' ? 0.08 : 0.26, 1, e.entry.txId); }
  onCorruption(e: KernelEventOf<'fs.corruption'>, _c: WorldEventContext): void { this.state(`inode:${e.inode as number}:corrupt`, e.recoverable ? 1 : 2); }
  onRecovered(e: KernelEventOf<'fs.recovered'>, _c: WorldEventContext): void { this.spawn('journal_stamp', this.cyan(), 0.6, 1, e.inode as number, e.fromJournal ? 1 : 0); }
}
