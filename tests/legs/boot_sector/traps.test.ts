/**
 * Acceptance 9 and the trap accounting table: a submission charges 4 cycles
 * whatever it returns, a direct reach charges nothing, and batching is the
 * whole difference between 4 and 24 cycles of overhead.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from '@game/CommandBus';
import { bootSector } from './leg';
import { reduceRequisition, TRAP_COST, unitPrice, windowDef } from '@legs/boot_sector/windows';
import { asKernelEvents } from '@legs/events';
import type { ScriptStep } from '../harness/decisionScript';
import { assertClean, runLeg, type HarnessResult } from '../harness/LegHarness';
import { ENTERING_LEDGER } from './scripts';

const interaction = (id: string, anchor: string): ScriptStep => ({ at: 0, command: { kind: 'interaction', id, anchor } });
const command = (cmd: Command): ScriptStep => ({ at: 0, command: cmd });

async function run(steps: readonly ScriptStep[]): Promise<HarnessResult> {
  const result = await runLeg(bootSector, { seed: 7, script: { legId: 'boot_sector', label: 'traps', steps } });
  assertClean(result);
  expect(result.unfiredSteps).toEqual([]);
  return result;
}

const submissions = (result: HarnessResult) => reduceRequisition(result.run.decisions, 'shell', 'operator').submissions;
/** The last interaction record; the runner's own `leg_done` follows it at exit. */
const lastInteraction = (result: HarnessResult) => [...result.decisions].reverse().find((record) => record.kind === 'interaction');
/** Bandwidth is refilled to 60 percent of the cap at entry, since leg 0 is not a depot leg. */
const ENTRY_BANDWIDTH = ENTERING_LEDGER.bandwidth * 0.6;

describe('boot_sector trap accounting', () => {
  it('a successful submission charges 4 cycles plus the goods at the leg 0 rate and is marked good', async () => {
    const result = await run([
      interaction('boot.set_mode', 'anchor.win.quota:kernel'),
      interaction('boot.batch_request', 'anchor.win.quota:25'),
      interaction('boot.trap_purchase', 'anchor.win.quota'),
    ]);
    const goods = 25 * unitPrice(windowDef('quota'), 'operator');
    expect(goods).toBe(50);
    expect(result.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST - goods);
    expect(result.ledgerAfter.quota).toBe(ENTERING_LEDGER.quota + 25);
    expect(submissions(result)).toEqual([expect.objectContaining({ window: 'quota', mode: 'kernel', errno: null })]);
    expect(lastInteraction(result)?.outcome).toBe('good');
  });

  it('a submission in user mode at a kernel window returns EPERM, charges the 4 cycles anyway, grants nothing and is marked costly', async () => {
    const result = await run([
      interaction('boot.set_mode', 'anchor.win.blocks:user'),
      interaction('boot.batch_request', 'anchor.win.blocks:10'),
      interaction('boot.trap_purchase', 'anchor.win.blocks'),
    ]);
    expect(result.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST);
    expect(result.ledgerAfter.blocks).toBe(ENTERING_LEDGER.blocks);
    expect(submissions(result)[0]?.errno).toBe('EPERM');
    expect(lastInteraction(result)?.outcome).toBe('costly');
  });

  it('raising a priority is refused with EPERM in either mode, and lowering one succeeds in user mode', async () => {
    const raise = await run([interaction('boot.set_mode', 'anchor.win.priority:kernel'), interaction('boot.batch_request', 'anchor.win.priority:-1'), interaction('boot.trap_purchase', 'anchor.win.priority')]);
    expect(submissions(raise)[0]?.errno).toBe('EPERM');
    expect(raise.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST);
    const lower = await run([interaction('boot.trap_purchase', 'anchor.win.priority')]);
    expect(submissions(lower)[0]).toEqual(expect.objectContaining({ mode: 'user', errno: null, items: [{ window: 'priority', amount: 1 }] }));
  });

  it('a malformed submission returns EINVAL and still charges 4 cycles', async () => {
    const zero = await run([interaction('boot.set_mode', 'anchor.win.quota:kernel'), interaction('boot.batch_request', 'anchor.win.quota:0'), interaction('boot.trap_purchase', 'anchor.win.quota')]);
    expect(submissions(zero)[0]?.errno).toBe('EINVAL');
    expect(zero.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST);
    const nowhere = await run([interaction('boot.trap_purchase', 'anchor.depot')]);
    expect(submissions(nowhere)[0]).toEqual(expect.objectContaining({ window: null, errno: 'EINVAL' }));
    expect(nowhere.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST);
  });

  it('goods the ledger cannot cover return ENOMEM, charged, with nothing moved', async () => {
    const result = await run([interaction('boot.set_mode', 'anchor.win.quota:kernel'), interaction('boot.batch_request', 'anchor.win.quota:1000'), interaction('boot.trap_purchase', 'anchor.win.quota')]);
    expect(submissions(result)[0]?.errno).toBe('ENOMEM');
    expect(result.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST);
    expect(result.ledgerAfter.quota).toBe(ENTERING_LEDGER.quota);
    const release = await run([interaction('boot.set_mode', 'anchor.win.quota:kernel'), interaction('boot.batch_request', 'anchor.win.quota:-901'), interaction('boot.trap_purchase', 'anchor.win.quota')]);
    expect(submissions(release)[0]?.errno).toBe('ENOMEM');
    expect(release.ledgerAfter.quota).toBe(ENTERING_LEDGER.quota);
  });

  it('a release is refunded at the same rate', async () => {
    const result = await run([interaction('boot.set_mode', 'anchor.win.quota:kernel'), interaction('boot.batch_request', 'anchor.win.quota:-900'), interaction('boot.trap_purchase', 'anchor.win.quota')]);
    expect(result.ledgerAfter.quota).toBe(0);
    expect(result.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST + 900 * 2);
  });

  it('a direct reach at the block stack is EPERM at a cost of 0, and the ledger is unchanged', async () => {
    const result = await run([interaction('boot.direct_reach', 'anchor.block_stack')]);
    expect(result.ledgerAfter).toEqual({ ...ENTERING_LEDGER, bandwidth: ENTRY_BANDWIDTH });
    expect(lastInteraction(result)?.outcome).toBe('costly');
    expect(reduceRequisition(result.run.decisions, 'shell', 'operator').directReaches).toBe(1);
    expect(submissions(result)).toEqual([]);
  });

  it('batching: one submission carrying six items charges 4 cycles of overhead, six submissions charge 24', async () => {
    const items = ['quota:25', 'blocks:10', 'bandwidth:5', 'manifest', 'identity', 'priority:1'];
    const batched = await run([
      interaction('boot.set_mode', 'anchor.win.quota:kernel'),
      ...items.map((item) => interaction('boot.batch_request', `anchor.win.${item}`)),
      interaction('boot.trap_purchase', 'anchor.win.quota'),
    ]);
    const goods = 25 * 2 + 10 * 3 + 5 * 4;
    expect(batched.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - TRAP_COST - goods);
    expect(submissions(batched)).toHaveLength(1);
    const separate = await run(items.flatMap((item) => {
      const window = item.split(':')[0] ?? '';
      return [interaction('boot.set_mode', `anchor.win.${window}:kernel`), interaction('boot.batch_request', `anchor.win.${item}`), interaction('boot.trap_purchase', `anchor.win.${window}`)];
    }));
    expect(separate.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - 6 * TRAP_COST - goods);
    expect(submissions(separate)).toHaveLength(6);
    expect(batched.ledgerAfter.quota).toBe(separate.ledgerAfter.quota);
  });

  it('the kernel traps the window dispatches beside a submission land in the log as syscall.invoked, never as EPERM', async () => {
    const result = await run([
      interaction('boot.set_mode', 'anchor.win.quota:kernel'),
      interaction('boot.trap_purchase', 'anchor.win.quota'),
      command({ kind: 'syscall', request: { name: 'brk', pid: result0Pid(), args: [5] } }),
      command({ kind: 'syscall', request: { name: 'open', pid: result0Pid(), args: ['manifest', 'r'] } }),
    ]);
    const calls = asKernelEvents(result.events).filter((event) => event.type === 'syscall.invoked');
    expect(calls.map((event) => event.type === 'syscall.invoked' && event.request.name)).toEqual(['brk', 'open']);
    expect(calls.some((event) => event.type === 'syscall.invoked' && !event.result.ok && event.result.errno === 'EPERM')).toBe(false);
  });
});

function result0Pid() {
  return 2 as import('@kernel/types').Pid;
}
