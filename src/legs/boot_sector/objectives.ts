/**
 * The six learning objectives, verbatim from the curriculum map. The debrief
 * and the end-of-run report quote the statements, so they are not reworded.
 */
import type { LearningObjective } from '@game/types';

export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.boot_sector.acquire_via_trap',
    statement: 'Acquires every starting resource by issuing a syscall trap at the depot rather than by writing to the resource pool directly, finishing outfitting with zero EPERM results in the syscall log.',
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.3', '2.3.1'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.boot_sector.mode_switch_budget',
    statement: 'Completes outfitting with total mode-switch overhead under 40 cycles while still leaving the Boot Sector with at least 120 cycles, 24 quota, 30 blocks and 40 bandwidth.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.4.1', '1.4.2'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.boot_sector.classify_privilege',
    statement: 'Labels each of the six depot services as requiring kernel mode or user mode before purchasing it, and gets at least five of six right.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.4.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.boot_sector.balanced_ledger',
    statement: 'Leaves the Boot Sector with no resource category at zero, so no later leg opens with a category already exhausted.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.5'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.boot_sector.consult_manual',
    statement: 'Resolves at least two unfamiliar depot terms with `man` before committing cycles to them.',
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.boot_sector.disc_class_tradeoff',
    statement: 'Selects a disc class and, at the confirmation gate, names which resource that class is short of, matching the class table.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.5'] },
    assessedBy: 'decision',
  },
];

export const OBJECTIVE_IDS = {
  acquireViaTrap: 'obj.boot_sector.acquire_via_trap',
  modeSwitchBudget: 'obj.boot_sector.mode_switch_budget',
  classifyPrivilege: 'obj.boot_sector.classify_privilege',
  balancedLedger: 'obj.boot_sector.balanced_ledger',
  consultManual: 'obj.boot_sector.consult_manual',
  discClassTradeoff: 'obj.boot_sector.disc_class_tradeoff',
} as const;
