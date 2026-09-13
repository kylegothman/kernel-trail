import { asPageId } from '../types';
import type { FrameId, PageId } from '../types';

const MAX_ADDRESS = 0xffff_ffff;
const ADDRESS_SPACE_BYTES = 0x1_0000_0000;

function pageBits(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > ADDRESS_SPACE_BYTES) {
    throw new RangeError('page size must be a power of two within the 32-bit address space');
  }
  const bits = Math.log2(pageSize);
  if (!Number.isInteger(bits)) throw new RangeError('page size must be a power of two');
  return bits;
}

/** Split an unsigned 32-bit logical address without changing its low bits. */
export function splitAddress(logical: number, pageSize: number): { page: PageId; offset: number } {
  const bits = pageBits(pageSize);
  if (!Number.isSafeInteger(logical) || logical < 0 || logical > MAX_ADDRESS) {
    throw new RangeError('logical address must be an unsigned 32-bit integer');
  }
  // JavaScript masks a shift count to five bits, so a full-address-space page
  // needs an explicit zero page number instead of a shift by 32.
  return {
    page: asPageId(bits === 32 ? 0 : logical >>> bits),
    offset: (logical & (pageSize - 1)) >>> 0,
  };
}

/** Combine a frame and offset, rejecting truncation outside the address width. */
export function physicalAddress(frame: FrameId, offset: number, pageSize: number): number {
  const bits = pageBits(pageSize);
  const highestFrame = bits === 32 ? 0 : MAX_ADDRESS >>> bits;
  if (!Number.isSafeInteger(frame) || frame < 0 || frame > highestFrame) {
    throw new RangeError('frame number exceeds the unsigned 32-bit physical address space');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= pageSize) {
    throw new RangeError('offset must be an integer within the page');
  }
  return ((frame << bits) | offset) >>> 0;
}
