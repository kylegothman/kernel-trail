/**
 * KERNEL TRAIL, the Narrows: the player's verbs, and what each one does.
 *
 * The four turnstile verbs are the protocol choice. They are recorded and
 * charged, and the crossing that follows carries the option, which is what the
 * debrief and the objectives read; a leg does not reimplement a crossing.
 *
 * Three verbs write kernel state through the third handler argument (WP-L04
 * ruling 2): the capacity dial and the compare-and-swap switch are shared
 * cells the workload reads at the top of each iteration, so the Programs on
 * the span change what they do without the leg reaching into a running tick.
 *
 * Two verbs are recorded and nothing else, and both are honest about it.
 * Priority inheritance is a kernel tuning value with no write path, so the
 * toggle clears the affliction and the debrief says the kernel's wait is still
 * unbounded (ruling 3). The interrupt switch is wired to one core of four and
 * the scheduler runs one Program at a time, so it cannot be demonstrated in
 * the kernel and the debrief says that too (ruling 8).
 */
import type { InteractionDef, RunState } from '@game/types';
import type { InteractionHandler } from '@game/RunDirector';
import { advanceCapacityDial, enableInheritance, installCompareAndSwap } from './ledger';

export const CROSS_SPIN = 'narrows.cross_spin';
export const CROSS_BLOCK = 'narrows.cross_block';
export const CROSS_MONITOR = 'narrows.cross_monitor';
export const CROSS_WAIT = 'narrows.cross_wait';
export const SET_CAPACITY = 'narrows.set_capacity';
export const TOGGLE_INHERITANCE = 'narrows.toggle_inheritance';
export const DISABLE_INTERRUPTS = 'narrows.disable_interrupts';
export const USE_CAS = 'narrows.use_cas';
export const READ_STONE = 'narrows.read_stone';

export const interactions: readonly InteractionDef[] = [
  {
    id: CROSS_SPIN,
    label: 'Spin and cross',
    description: 'Hold the processor and test the lock in a loop until it clears. Costs cycles proportional to the hold, and no context switch.',
    anchor: 'anchor.turnstile',
    cost: { cycles: 0 },
    enabledWhen: () => true,
  },
  {
    id: CROSS_BLOCK,
    label: 'Block and cross',
    description: 'Sleep on the lock and be woken when it is released. Costs one context switch each way, and quota while asleep.',
    anchor: 'anchor.turnstile',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: CROSS_MONITOR,
    label: 'Pay the monitor toll',
    description: 'Enter through a maintained monitor that handles mutual exclusion and condition variables correctly, and charges for it.',
    anchor: 'anchor.turnstile',
    cost: { bandwidth: 6 },
    enabledWhen: (run) => run.resources.bandwidth >= 6,
  },
  {
    id: CROSS_WAIT,
    label: 'Wait for the ford to clear',
    description: 'Costs travel ticks and risks an event draw.',
    anchor: 'anchor.turnstile',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: SET_CAPACITY,
    label: 'Set the ford semaphore count',
    description: 'How many Programs the semaphore admits at once. Look at how wide the ford actually is.',
    anchor: 'anchor.wide_ford',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: TOGGLE_INHERITANCE,
    label: 'Priority inheritance',
    description: 'While a low-priority holder blocks a high-priority waiter, the holder runs at the waiter priority.',
    anchor: 'anchor.inheritance_toggle',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: DISABLE_INTERRUPTS,
    label: 'Disable interrupts',
    description: 'Stop this core being preempted for the duration of the section.',
    anchor: 'anchor.interrupt_switch',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: USE_CAS,
    label: 'Use compare-and-swap',
    description: 'Replace the test-then-set with a single atomic instruction.',
    anchor: 'anchor.plank',
    cost: { bandwidth: 4 },
    enabledWhen: (run) => run.resources.bandwidth >= 4,
  },
  {
    id: READ_STONE,
    label: 'Read the two-process stone',
    description: 'A software-only solution for exactly two processes, in full.',
    anchor: 'anchor.peterson_stone',
    cost: {},
    enabledWhen: () => true,
  },
];

const recordOnly: InteractionHandler = () => undefined;

/**
 * The kernel's own inheritance flag is frozen tuning with no write path, so
 * this does the two things a leg is allowed to do: it sets the switch the
 * holder reads, which is what lets the holder finish its section and release,
 * and it lifts the affliction the waiter is carrying.
 */
const toggleInheritance: InteractionHandler = (run: RunState, _at, kernel) => {
  enableInheritance(kernel);
  for (const member of run.convoy) {
    if (member.status === 'derezzed') continue;
    member.afflictions = member.afflictions.filter((affliction) => affliction.id !== 'priority_inversion');
  }
};

export const handlers: Readonly<Record<string, { readonly run: InteractionHandler; readonly target: null }>> = {
  [CROSS_SPIN]: { run: recordOnly, target: null },
  [CROSS_BLOCK]: { run: recordOnly, target: null },
  [CROSS_MONITOR]: { run: recordOnly, target: null },
  [CROSS_WAIT]: { run: recordOnly, target: null },
  [SET_CAPACITY]: { run: (_run, _at, kernel) => { advanceCapacityDial(kernel); }, target: null },
  [TOGGLE_INHERITANCE]: { run: toggleInheritance, target: null },
  [DISABLE_INTERRUPTS]: { run: recordOnly, target: null },
  [USE_CAS]: { run: (_run, _at, kernel) => { installCompareAndSwap(kernel); }, target: null },
  [READ_STONE]: { run: recordOnly, target: null },
};
