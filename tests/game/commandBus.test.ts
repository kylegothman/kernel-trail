/**
 * The command bus, WP-17 acceptance 31: exactly one DecisionRecord per
 * command, appended before the mutator runs.
 */
import { describe, expect, it } from 'vitest';
import type { SyscallRequest, SyscallResult, Tick } from '../../src/kernel/types';
import { createRunStore } from '../../src/game/runStore';
import { CommandBus, COMMAND_QUEUE_CAPACITY, commandFromRecord, describeChoice, type Command, type CommandHandlers, type KernelMutators } from '../../src/game/CommandBus';
import { worstCaseRun } from '../ui/fixtures';

const tick = (n: number): Tick => n as Tick;
const origin = { source: 'hud', legId: 'allocation_yards' } as const;

function rig() {
  const store = createRunStore(worstCaseRun());
  const calls: { name: string; decisionsAtCall: number; args: unknown[] }[] = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, decisionsAtCall: store.get().decisions.length, args });
  };
  const kernel: KernelMutators = {
    setScheduler: (id, params) => record('setScheduler', id, params),
    setReplacementPolicy: (id) => record('setReplacementPolicy', id),
    setDiskPolicy: (id) => record('setDiskPolicy', id),
    setAllocationStrategy: (s) => record('setAllocationStrategy', s),
    syscall: (request: SyscallRequest): SyscallResult => {
      record('syscall', request);
      return { ok: true, value: 7 };
    },
  };
  const handlers: CommandHandlers = {
    useAbility: (member, target, at) => record('useAbility', member, target, at),
    interaction: (id, anchor, at) => record('interaction', id, anchor, at),
    terminal: (line, at) => record('terminal', line, at),
  };
  const bus = new CommandBus({ store, kernel, handlers });
  return { store, bus, calls };
}

const EVERY_COMMAND: readonly Command[] = [
  { kind: 'set_scheduler', to: 'rr', quantum: 8 },
  { kind: 'set_replacement', to: 'lru' },
  { kind: 'set_disk_policy', to: 'clook' },
  { kind: 'set_allocation', to: 'best_fit' },
  { kind: 'set_pace', to: 'reckless' },
  { kind: 'set_rations', to: 'lean' },
  { kind: 'set_degree', to: 9 },
  { kind: 'use_ability', member: 'sable', target: 4 },
  { kind: 'syscall', request: { name: 'getpid', pid: 3 as never, args: [] } },
  { kind: 'interaction', id: 'repair', anchor: 'FrameVault' },
  { kind: 'terminal', line: 'vmstat' },
];

describe('CommandBus', () => {
  it('appends exactly one DecisionRecord per command and then calls the mutator, in that order', () => {
    const r = rig();
    for (const cmd of EVERY_COMMAND) expect(r.bus.dispatch(cmd, origin)).toBe(true);
    expect(r.bus.pending).toBe(EVERY_COMMAND.length);
    expect(r.store.get().decisions).toHaveLength(0);
    const outcomes = r.bus.drain(tick(4981));
    expect(r.bus.pending).toBe(0);
    const decisions = r.store.get().decisions;
    expect(decisions).toHaveLength(EVERY_COMMAND.length);
    decisions.forEach((d, i) => {
      const cmd = EVERY_COMMAND[i];
      if (cmd === undefined) throw new Error('fixture');
      expect(d.tick).toBe(4981);
      expect(d.legId).toBe('allocation_yards');
      expect(d.kind).toBe(cmd.kind);
      expect(d.choice).toBe(describeChoice(cmd));
      expect(d.outcome).toBe('pending');
      expect(d.relatedObjective).toBeNull();
      expect(outcomes[i]?.decisionIndex).toBe(i);
    });
    // The mutator saw the record already appended: record first, mutate second.
    const mutating = EVERY_COMMAND.filter((c) => !c.kind.startsWith('set_pace') && c.kind !== 'set_rations' && c.kind !== 'set_degree');
    expect(r.calls).toHaveLength(mutating.length);
    r.calls.forEach((call) => expect(call.decisionsAtCall, call.name).toBeGreaterThan(0));
    expect(r.calls.map((c) => c.name)).toEqual([
      'setScheduler', 'setReplacementPolicy', 'setDiskPolicy', 'setAllocationStrategy', 'useAbility', 'syscall', 'interaction', 'terminal',
    ]);
    expect(r.calls[0]?.args).toEqual(['rr', { quantum: 8 }]);
    expect(r.calls[0]?.decisionsAtCall).toBe(1);
    expect(r.calls[7]?.decisionsAtCall).toBe(11);
    expect(outcomes[8]?.syscall).toEqual({ ok: true, value: 7 });
    const policy = r.store.get().policy;
    expect(policy).toEqual({ pace: 'reckless', rations: 'lean', degreeOfMultiprogramming: 9 });
  });

  it('records the decision even when the mutator throws, and the throw propagates', () => {
    const r = rig();
    const kernel: KernelMutators = {
      setScheduler: () => {
        throw new Error('scheduler refused');
      },
      setReplacementPolicy: () => undefined,
      setDiskPolicy: () => undefined,
      setAllocationStrategy: () => undefined,
      syscall: () => ({ ok: true, value: null }),
    };
    const bus = new CommandBus({ store: r.store, kernel, handlers: { useAbility: () => undefined, interaction: () => undefined, terminal: () => undefined } });
    expect(() => bus.apply({ kind: 'set_scheduler', to: 'sjf' }, origin, tick(5))).toThrow('scheduler refused');
    expect(r.store.get().decisions).toHaveLength(1);
  });

  // WP-18 scope correction U2, quote-and-wait ruled approved in the WP-18 pre-flight.
  it('commandFromRecord inverts describeChoice for every replayed kind and is null for the rest', () => {
    const r = rig();
    for (const cmd of EVERY_COMMAND) r.bus.apply(cmd, origin, tick(7));
    const replayed = new Set(['set_scheduler', 'set_replacement', 'set_disk_policy', 'set_allocation', 'set_pace', 'set_rations', 'set_degree', 'syscall']);
    r.store.get().decisions.forEach((d, i) => {
      const cmd = EVERY_COMMAND[i];
      if (cmd === undefined) throw new Error('fixture');
      expect(commandFromRecord(d), d.choice).toEqual(replayed.has(cmd.kind) ? cmd : null);
    });
    // The variants EVERY_COMMAND does not cover: a scheduler without a quantum, and typed syscall args.
    const bare: Command = { kind: 'set_scheduler', to: 'srtf' };
    expect(commandFromRecord({ tick: tick(1), legId: 'boot_sector', kind: 'set_scheduler', choice: describeChoice(bare), outcome: 'pending', relatedObjective: null })).toEqual(bare);
    const typed: Command = { kind: 'syscall', request: { name: 'open', pid: 4 as never, args: ['/tmp, a', 1, true] } };
    expect(describeChoice(typed)).toBe('open("/tmp, a", 1, true) pid=4');
    expect(commandFromRecord({ tick: tick(1), legId: 'boot_sector', kind: 'syscall', choice: describeChoice(typed), outcome: 'pending', relatedObjective: null })).toEqual(typed);
    // Unknown ids and unparseable strings are refused rather than guessed.
    for (const [kind, choice] of [['set_scheduler', 'warp q=4'], ['set_replacement', 'magic'], ['set_degree', 'six'], ['syscall', 'kill(7)'], ['syscall', 'teleport(1) pid=2']] as const) {
      expect(commandFromRecord({ tick: tick(1), legId: 'boot_sector', kind, choice, outcome: 'pending', relatedObjective: null }), `${kind} ${choice}`).toBeNull();
    }
  });

  it('is bounded: a stuck key cannot queue past the capacity', () => {
    const r = rig();
    for (let i = 0; i < COMMAND_QUEUE_CAPACITY; i++) expect(r.bus.dispatch({ kind: 'terminal', line: 'ls' }, origin)).toBe(true);
    expect(r.bus.dispatch({ kind: 'terminal', line: 'ls' }, origin)).toBe(false);
    expect(r.bus.dropped).toBe(1);
    expect(r.bus.pending).toBe(COMMAND_QUEUE_CAPACITY);
    expect(r.bus.drain(tick(1))).toHaveLength(COMMAND_QUEUE_CAPACITY);
    expect(r.store.get().decisions).toHaveLength(COMMAND_QUEUE_CAPACITY);
  });
});
