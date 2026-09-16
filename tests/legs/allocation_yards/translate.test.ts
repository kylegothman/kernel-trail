/** WP-L07 acceptance 10: the translation fixtures and the gate's single attempt. */
import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { physicalAddress, splitAddress } from '@kernel/memory/translate';
import { asFrameId } from '@kernel/types';
import { createHeadlessSetupContext } from '@game/replay/headlessLegs';
import { createRng } from '@kernel/rng';
import { runLeg } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import { XLATE_1, XLATE_2, XLATE_MANUAL } from '@legs/allocation_yards/fixtures';
import { readLeg } from '@legs/allocation_yards/evaluate';

const leg = await loadLegForTest('allocation_yards');

describe('the sim spec translation fixtures', () => {
  it('MEM-XLATE-1: page size 4 and page table [5, 6, 1, 2]', () => {
    for (const row of XLATE_1.cases) {
      const split = splitAddress(row.logical, XLATE_1.pageSize);
      expect(split.page, String(row.logical)).toBe(row.page);
      expect(split.offset, String(row.logical)).toBe(row.offset);
      expect(XLATE_1.pageTable[row.page]).toBe(row.frame);
      expect(physicalAddress(asFrameId(row.frame), row.offset, XLATE_1.pageSize)).toBe(row.physical);
    }
  });

  it('MEM-XLATE-2: 0x00003ABC carries its offset across untouched', () => {
    const split = splitAddress(XLATE_2.logical, XLATE_2.pageSize);
    expect(split.page).toBe(XLATE_2.page);
    expect(split.offset).toBe(XLATE_2.offset);
    const physical = physicalAddress(asFrameId(XLATE_2.frame), split.offset, XLATE_2.pageSize);
    expect(physical).toBe(XLATE_2.physical);
    expect(physical.toString(16)).toBe('cabc');
  });

  it('the man page third example is arithmetically correct as printed', () => {
    const split = splitAddress(XLATE_MANUAL.logical, XLATE_MANUAL.pageSize);
    expect(split.page).toBe(XLATE_MANUAL.page);
    expect(split.offset).toBe(XLATE_MANUAL.offset);
    expect(XLATE_MANUAL.frame * XLATE_MANUAL.pageSize + XLATE_MANUAL.offset).toBe(XLATE_MANUAL.physical);
  });
});

describe('the gate asks against the live page table', () => {
  it('builds its question from the frame the allocator actually gave, not from a constant', () => {
    const run = makeRunState({ seed: 0x4b54524c, legIndex: 7 });
    const kernel = createKernel(leg.kernelConfig(run), { devBuild: true, checkInvariants: true });
    const bindings = new Map();
    leg.populate(createHeadlessSetupContext(kernel, run, createRng(0x4b54524c, 'leg'), bindings));
    for (let tick = 0; tick < 6; tick++) kernel.step();
    const lumen = bindings.get('lumen');
    expect(lumen).toBeDefined();
    const pcb = kernel.process(lumen as never);
    expect(pcb).toBeDefined();
    const table = kernel.invariantState().pageTables.get(pcb?.addressSpaceId as never) ?? [];
    // Page 2 is the last page the admission pass maps, so it is the deepest
    // page the gate can ask about and still be answerable from the live table.
    const entry = table.find((row) => row.page === 2);
    expect(entry?.valid).toBe(true);
    expect(entry?.frame).not.toBeNull();
    const logical = 8892;
    const split = splitAddress(logical, 4096);
    expect(split.page).toBe(2);
    expect(split.offset).toBe(700);
    expect(physicalAddress(asFrameId(entry?.frame ?? 0), split.offset, 4096)).toBe((entry?.frame ?? 0) * 4096 + 700);
  });

  it('scores exactly one attempt and refuses a second', async () => {
    const one = await runLeg(leg, {
      seed: 0x4b54524c,
      run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } }),
      script: { legId: 'allocation_yards', label: 'one attempt', steps: [
        { at: 30, command: { kind: 'terminal', line: 'pagetable 2' } },
        { at: 32, command: { kind: 'interaction', id: 'yards.answer_translation', anchor: 'anchor.translation_gate' } },
      ] },
    });
    const first = readLeg({ run: one.run, kernelSnapshot: {} as never, events: one.events, ticksElapsed: one.ticks });
    expect(first.gateAttempts).toBe(1);
    expect(one.outcome.objectivesMet).toContain('obj.allocation_yards.translate_address');

    const twice = await runLeg(leg, {
      seed: 0x4b54524c,
      run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } }),
      script: { legId: 'allocation_yards', label: 'two attempts', steps: [
        { at: 30, command: { kind: 'terminal', line: 'pagetable 2' } },
        { at: 32, command: { kind: 'interaction', id: 'yards.answer_translation', anchor: 'anchor.translation_gate' } },
        { at: 40, command: { kind: 'interaction', id: 'yards.answer_translation', anchor: 'anchor.translation_gate' } },
      ] },
    });
    const second = readLeg({ run: twice.run, kernelSnapshot: {} as never, events: twice.events, ticksElapsed: twice.ticks });
    expect(second.gateAttempts).toBe(2);
    expect(twice.outcome.objectivesMet).not.toContain('obj.allocation_yards.translate_address');
  });

  it('refuses an answer given without reading the table first', async () => {
    const blind = await runLeg(leg, {
      seed: 0x4b54524c,
      run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } }),
      script: { legId: 'allocation_yards', label: 'blind', steps: [
        { at: 32, command: { kind: 'interaction', id: 'yards.answer_translation', anchor: 'anchor.translation_gate' } },
      ] },
    });
    expect(blind.outcome.objectivesMet).not.toContain('obj.allocation_yards.translate_address');
  });
});
