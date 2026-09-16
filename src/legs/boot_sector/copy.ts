/**
 * Every line the player reads in the Boot Sector, and the five codex entries
 * in full (scope correction section 5). The register is narrative bible 2.1:
 * short declaratives, real nouns, measurements over adjectives.
 */
import type { CodexEntry } from '@game/codexTypes';
import { INTRODUCTION, STRUCTURES } from './chapters';
import { TRAP_COST } from './windows';

/** The hard stop at the block stack. The error names its own topic, per the `man` contract. */
export const DIRECT_REACH_LINE = 'EPERM. man EPERM.';
/** The one hint the shell gives at this level of directness, given once. */
export const UNKNOWN_COMMAND_HINT = 'not a command. try: man';
/** The depot signage, in the register of a posted price. */
export const TRAP_SIGNAGE = `Trap: ${TRAP_COST} cycles. Per submission. Any size.`;
/** The one line of ambient text a depot ever shows, narrative bible 10.1. */
export const DEPOT_AMBIENT = 'Depot open. Cycles accepted. Nothing here is a favour.';
/** The confirmation gate's one question. */
export const GATE_QUESTION = 'Which resource is this class short of?';

export const CODEX_IDS: readonly string[] = [
  'codex.os_role', 'codex.dual_mode', 'codex.syscall_trap', 'codex.resource_ledger', 'codex.kernel_structure',
];

const LEG_COMMANDS: readonly string[] = ['man', 'syscall', 'mode'];

export const codexEntries: readonly CodexEntry[] = [
  {
    id: 'codex.os_role',
    title: 'What an operating system does',
    chapter: { chapter: INTRODUCTION.chapter, title: INTRODUCTION.title, sections: ['1.1', '1.2.1', '1.2.2'] },
    concept: 'An operating system is a resource allocator and a control program. It decides which process holds the processor, which frames hold whose pages, and which request reaches the device next. The kernel is the one program that runs when nothing else may, and it runs only when something asks for it.',
    unlock: { kind: 'leg_complete', leg: 'boot_sector' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'never',
    related: ['codex.dual_mode', 'codex.kernel_structure'],
    commands: LEG_COMMANDS,
    epitaphs: [],
  },
  {
    id: 'codex.dual_mode',
    title: 'Dual mode',
    chapter: { chapter: INTRODUCTION.chapter, title: INTRODUCTION.title, sections: ['1.4.1', '1.4.2'] },
    concept: 'One processor carries one mode bit. In kernel mode every instruction executes; in user mode the privileged ones fault instead. The bit is hardware and flips on a trap, on an interrupt, and on nothing else. A mode switch here costs four cycles, and the same Program crosses it dozens of times a leg without ever being an administrator.',
    unlock: { kind: 'leg_complete', leg: 'boot_sector' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'never',
    related: ['codex.syscall_trap', 'codex.protection_rings'],
    commands: LEG_COMMANDS,
    epitaphs: [],
  },
  {
    id: 'codex.syscall_trap',
    title: 'The system call trap',
    chapter: { chapter: STRUCTURES.chapter, title: STRUCTURES.title, sections: ['2.3', '2.3.1', '2.3.2', '2.3.3'] },
    concept: 'A system call is not a function call. It raises a trap, the processor switches to kernel mode, and the kernel validates every argument because it trusts none of them. The crossing costs the same whether the request carries one block or a hundred, which is why requests are batched.',
    unlock: { kind: 'leg_complete', leg: 'boot_sector' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'never',
    related: ['codex.dual_mode', 'codex.code_injection'],
    commands: LEG_COMMANDS,
    epitaphs: [],
  },
  {
    id: 'codex.resource_ledger',
    title: 'The resource ledger',
    chapter: { chapter: INTRODUCTION.chapter, title: INTRODUCTION.title, sections: ['1.5', '1.6'] },
    concept: 'Four stocks, one for each thing a machine runs out of. Cycles are processor time and the currency at every depot, and quota is memory in frames, consumed while travelling. Blocks are storage, spent on repair and journaling. Bandwidth is the I/O budget for one leg, and it refills at the next.',
    unlock: { kind: 'leg_complete', leg: 'boot_sector' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'never',
    related: ['codex.os_role'],
    commands: LEG_COMMANDS,
    epitaphs: [],
  },
  {
    id: 'codex.kernel_structure',
    title: 'Kernel structure',
    chapter: { chapter: STRUCTURES.chapter, title: STRUCTURES.title, sections: ['2.8.1', '2.8.2', '2.9'] },
    concept: 'A monolithic kernel puts every service in one address space and pays nothing to cross between them. A layered kernel stacks services so each layer touches only the one below, and pays a crossing per layer. A microkernel moves services out to user space and pays a message for every request. Each structure trades speed against the size of the code that runs privileged.',
    unlock: { kind: 'leg_complete', leg: 'boot_sector' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'never',
    related: ['codex.os_role', 'codex.access_matrix'],
    commands: LEG_COMMANDS,
    epitaphs: [],
  },
];
