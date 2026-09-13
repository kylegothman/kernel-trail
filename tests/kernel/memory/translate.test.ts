import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { KernelConfigError } from '@kernel/errors';
import { createRng } from '@kernel/rng';
import { physicalAddress, splitAddress } from '@kernel/memory/translate';
import { asFrameId } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

describe('paging address translation', () => {
  it.each([
    [0, 0, 0, 5, 20],
    [3, 0, 3, 5, 23],
    [4, 1, 0, 6, 24],
    [13, 3, 1, 2, 9],
  ])('MEM-XLATE-1: logical %i maps through the four-byte page table', (logical, page, offset, frame, physical) => {
    expect(splitAddress(logical, 4)).toEqual({ page, offset });
    expect(physicalAddress(asFrameId(frame), offset, 4)).toBe(physical);
  });

  it('MEM-XLATE-2: 0x00003ABC maps to frame 12 with the offset unchanged', () => {
    const split = splitAddress(0x0000_3abc, 4096);
    expect(split).toEqual({ page: 3, offset: 2748 });
    const physical = physicalAddress(asFrameId(12), split.offset, 4096);
    expect(physical).toBe(51900);
    expect(physical.toString(16)).toBe('cabc');
  });

  it('preserves offsets and identity mappings over 1000 seeded unsigned addresses', () => {
    const rng = createRng(0x584c4154);
    for (let index = 0; index < 1000; index++) {
      const logical = rng.int(0, 0x1_0000_0000);
      const { page, offset } = splitAddress(logical, 4096);
      const frame = asFrameId(rng.int(0, 0x10_0000));
      expect(physicalAddress(frame, offset, 4096) & 4095).toBe(offset);
      expect(physicalAddress(asFrameId(page), offset, 4096)).toBe(logical);
    }
  });

  it.each([1, 2, 4, 4096, 0x8000_0000, 0x1_0000_0000])('keeps high-bit addresses unsigned with page size %i', pageSize => {
    for (const logical of [0, 1, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff]) {
      const { page, offset } = splitAddress(logical, pageSize);
      expect(physicalAddress(asFrameId(page), offset, pageSize)).toBe(logical);
    }
  });

  it.each([0, -1, 3, 3000, 1.5, 0x2_0000_0000, Infinity, NaN])('rejects invalid page size %s', pageSize => {
    expect(() => splitAddress(0, pageSize)).toThrow(RangeError);
    expect(() => physicalAddress(asFrameId(0), 0, pageSize)).toThrow(RangeError);
  });

  it.each([-1, 0.5, 0x1_0000_0000, Infinity, NaN])('rejects invalid logical address %s before bitwise truncation', logical => {
    expect(() => splitAddress(logical, 4096)).toThrow(RangeError);
  });

  it('rejects frames or offsets that would wrap or spill across a page', () => {
    for (const frame of [-1, 0.5, 0x10_0000, Infinity, NaN]) {
      expect(() => physicalAddress(asFrameId(frame), 0, 4096)).toThrow(RangeError);
    }
    for (const offset of [-1, 0.5, 4096, Infinity, NaN]) {
      expect(() => physicalAddress(asFrameId(0), offset, 4096)).toThrow(RangeError);
    }
    expect(() => physicalAddress(asFrameId(1), 0, 0x1_0000_0000)).toThrow(RangeError);
  });

  it('existing kernel configuration rejects a non-power-of-two page size', () => {
    expect(() => createKernel({ ...REFERENCE_CONFIG, scheduler: 'fcfs', pageSize: 3000 })).toThrow(KernelConfigError);
  });
});
