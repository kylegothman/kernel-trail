import type { IoMode, IoSnapshotRequest } from '../types';
import { check, validInteger } from './drivers/DeviceDriver';

export const DEFAULT_WORD_SIZE = 64;
export function transferTicks(bytes: number, wordSize = DEFAULT_WORD_SIZE): number {
  check(validInteger(bytes) && validInteger(wordSize, 1), 'transfer size');
  return Math.ceil(bytes / wordSize);
}
export function dmaStealTicks(bytes: number, wordSize: number, ratio: number): number {
  check(Number.isFinite(ratio) && ratio >= 0 && ratio <= 1, 'DMA ratio');
  return Math.round(transferTicks(bytes, wordSize) * ratio);
}
export function continuation(mode: IoMode, bytes: number, wordSize: number, ratio: number): IoSnapshotRequest['continuation'] {
  if (mode === 'polling') return { mode, setupTicksRemaining: 1, copiedWords: 0, wastedPolls: 0, wastedEventEmitted: false };
  if (mode === 'interrupt') return { mode, setupTicksRemaining: 1, copyDebt: 'not_due' };
  return { mode, setupTicksRemaining: 2, transferTicks: transferTicks(bytes, wordSize), elapsedTransferTicks: 0,
    stealBudget: dmaStealTicks(bytes, wordSize, ratio), stealsCharged: 0, stealAccumulator: 0, dmaEventEmitted: false };
}
