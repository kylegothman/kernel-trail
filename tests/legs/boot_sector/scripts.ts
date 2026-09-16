/**
 * The Boot Sector's scripts, expectations and fixtures; `fixtures.ts`
 * re-exports exactly `knownGood` and `knownBad` (scope correction sections 6 to 9). Both
 * enter with the starting ledger, since leg 0 has no predecessor, at the
 * shared seed. The known-bad path is `costly`: nothing dies here by design,
 * and the failure is a decision marked costly plus a ledger that leaves the
 * Fork Fields with no quota.
 *
 * The steps are grouped across the first twelve ticks and depend on no tick,
 * so the scripts hold under the zero-segment allowance and the leg ends on
 * the gate's `leg_done` record (pre-flight ruling 1). Each submission is an interaction followed by the
 * kernel traps the window dispatches beside it, issued as LUMEN (pid 2, the
 * first spawn).
 */
import { asPid, type SyscallName } from '@kernel/types';
import type { ChapterRef } from '@game/types';
import type { DecisionScript, ScriptStep } from '../harness/decisionScript';
import type { OutcomeExpectation } from '../harness/expectOutcome';
import { FIXTURE_SEED, type LegFixture } from '../harness/fixtureContract';

const LUMEN = asPid(2);
/** Steps are grouped by tick so the golden carries process admissions between the submissions; nothing depends on the tick itself. */
const interaction = (at: number, id: string, anchor: string): ScriptStep => ({ at, command: { kind: 'interaction', id, anchor } });
const terminal = (at: number, line: string): ScriptStep => ({ at, command: { kind: 'terminal', line } });
const syscall = (at: number, name: SyscallName, args: readonly (string | number | boolean)[]): ScriptStep =>
  ({ at, command: { kind: 'syscall', request: { name, pid: LUMEN, args } } });

export const OBJECTIVES: readonly string[] = [
  'obj.boot_sector.acquire_via_trap', 'obj.boot_sector.mode_switch_budget', 'obj.boot_sector.classify_privilege',
  'obj.boot_sector.balanced_ledger', 'obj.boot_sector.consult_manual', 'obj.boot_sector.disc_class_tradeoff',
];
export const CODEX: readonly string[] = ['codex.os_role', 'codex.dual_mode', 'codex.syscall_trap', 'codex.resource_ledger', 'codex.kernel_structure'];
export const DEBRIEF_CHAPTER: Pick<ChapterRef, 'chapter' | 'sections'> = { chapter: 2, sections: ['2.3', '2.3.1'] };

/** Shell at operator, narrative bible 5.2. */
export const ENTERING_LEDGER = { cycles: 1600, quota: 900, blocks: 120, bandwidth: 60 } as const;

export const KNOWN_GOOD_SCRIPT: DecisionScript = {
  legId: 'boot_sector',
  label: 'boot_sector known-good: two batched submissions, two bare ones, manuals first',
  crossings: [],
  steps: [
    interaction(0, 'boot.inspect_program', 'anchor.convoy.lumen'),
    terminal(1, 'man EPERM'),
    terminal(1, 'man syscall'),
    interaction(2, 'boot.direct_reach', 'anchor.block_stack'),
    interaction(3, 'boot.set_mode', 'anchor.win.quota:kernel'),
    interaction(3, 'boot.batch_request', 'anchor.win.quota:40'),
    interaction(3, 'boot.batch_request', 'anchor.win.blocks:40'),
    interaction(3, 'boot.trap_purchase', 'anchor.win.quota'),
    syscall(3, 'brk', [6]),
    syscall(3, 'open', ['blocks', 'w']),
    syscall(3, 'write', [3, 40]),
    interaction(5, 'boot.set_mode', 'anchor.win.bandwidth:kernel'),
    interaction(5, 'boot.batch_request', 'anchor.win.bandwidth:50'),
    interaction(5, 'boot.batch_request', 'anchor.win.manifest'),
    interaction(5, 'boot.trap_purchase', 'anchor.win.bandwidth'),
    syscall(5, 'ioctl', ['kernel', 'widen', 50]),
    syscall(5, 'open', ['manifest', 'r']),
    interaction(7, 'boot.set_mode', 'anchor.win.identity:user'),
    interaction(7, 'boot.trap_purchase', 'anchor.win.identity'),
    syscall(7, 'getpid', []),
    interaction(9, 'boot.set_mode', 'anchor.win.priority:user'),
    interaction(9, 'boot.trap_purchase', 'anchor.win.priority'),
    syscall(9, 'nice', [1]),
    interaction(12, 'boot.choose_disc', 'anchor.disc_plinth:blocks'),
  ],
};

export const KNOWN_GOOD_EXPECTATION: OutcomeExpectation = {
  survived: true,
  objectivesMet: OBJECTIVES,
  casualties: [],
  codexUnlocked: CODEX,
  decisionOutcomes: [{ kind: 'interaction', outcome: 'good' }],
  debrief: { headlineMatches: /^Outfitted\.$/, counterfactualPresent: false, chapter: DEBRIEF_CHAPTER },
  eventTypesPresent: ['syscall.invoked', 'process.created'],
  eventTypesAbsent: ['kernel.panic', 'process.exited'],
  ticksBetween: [12, 12],
};

export const KNOWN_BAD_SCRIPT: DecisionScript = {
  legId: 'boot_sector',
  label: 'boot_sector known-bad: six single submissions, all quota released for cycles, four wrong labels, no manual',
  crossings: [],
  steps: [
    interaction(1, 'boot.set_mode', 'anchor.win.quota:kernel'),
    interaction(1, 'boot.batch_request', 'anchor.win.quota:-900'),
    interaction(1, 'boot.trap_purchase', 'anchor.win.quota'),
    syscall(1, 'brk', [0]),
    interaction(3, 'boot.set_mode', 'anchor.win.blocks:user'),
    interaction(3, 'boot.trap_purchase', 'anchor.win.blocks'),
    syscall(3, 'open', ['blocks', 'w']),
    interaction(5, 'boot.set_mode', 'anchor.win.bandwidth:user'),
    interaction(5, 'boot.trap_purchase', 'anchor.win.bandwidth'),
    syscall(5, 'ioctl', ['kernel', 'widen', 5]),
    interaction(7, 'boot.set_mode', 'anchor.win.manifest:user'),
    interaction(7, 'boot.trap_purchase', 'anchor.win.manifest'),
    syscall(7, 'open', ['manifest', 'r']),
    interaction(9, 'boot.set_mode', 'anchor.win.identity:kernel'),
    interaction(9, 'boot.trap_purchase', 'anchor.win.identity'),
    syscall(9, 'getpid', []),
    interaction(11, 'boot.set_mode', 'anchor.win.priority:user'),
    interaction(11, 'boot.batch_request', 'anchor.win.priority:-1'),
    interaction(11, 'boot.trap_purchase', 'anchor.win.priority'),
    interaction(12, 'boot.choose_disc', 'anchor.disc_plinth:cycles'),
  ],
};

export const KNOWN_BAD_EXPECTATION: OutcomeExpectation = {
  survived: true,
  objectivesMet: [],
  casualties: [],
  codexUnlocked: CODEX,
  decisionOutcomes: [{ kind: 'interaction', outcome: 'costly' }],
  debrief: { headlineMatches: /^Outfitted\.$/, counterfactualPresent: true, chapter: DEBRIEF_CHAPTER },
  eventTypesPresent: ['syscall.invoked', 'process.created'],
  eventTypesAbsent: ['kernel.panic', 'process.exited'],
  ticksBetween: [12, 12],
};

const base = {
  legId: 'boot_sector', seed: FIXTURE_SEED, discClass: 'shell', difficulty: 'operator', pace: 'steady', rations: 'standard',
  enteringLedger: ENTERING_LEDGER, enteringDecisions: [],
} as const;

export const knownGood: LegFixture = { ...base, path: 'good', failureMode: 'costly', script: KNOWN_GOOD_SCRIPT, expect: KNOWN_GOOD_EXPECTATION };
export const knownBad: LegFixture = { ...base, path: 'bad', failureMode: 'costly', script: KNOWN_BAD_SCRIPT, expect: KNOWN_BAD_EXPECTATION };
