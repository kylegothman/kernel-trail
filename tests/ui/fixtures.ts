/**
 * The worst-case HUD fixture, visual bible 11.3: five Programs alive, four
 * non-zero resources, three alerts showing, the longest policy names. Shared
 * by the Node suite and by the browser page in tests/render/gpu/hud.gpu.ts.
 */
import type { CameraPose, FocusCameraState, FocusMode } from '../../src/render/camera/focusContract';
import type { HudTelemetry } from '../../src/game/runStore';
import type { Affliction, ConvoyMember, RunState } from '../../src/game/types';
import type { KernelEvent, Pid, Tick } from '../../src/kernel/types';

const tick = (n: number): Tick => n as Tick;
const pid = (n: number): Pid => n as Pid;

function affliction(id: Affliction['id'], displayName: string): Affliction {
  return {
    id,
    displayName,
    acquiredAtTick: tick(4900),
    drainPerTick: 0.5,
    fatalAfter: null,
    remedy: { kind: 'reduce_degree', by: 3 },
  };
}

function member(
  id: ConvoyMember['id'],
  name: string,
  role: ConvoyMember['role'],
  p: number,
  integrity: number,
  status: ConvoyMember['status'],
  afflictions: Affliction[],
): ConvoyMember {
  return { id, name, role, pid: pid(p), integrity, status, epitaph: null, abilityCharges: 2, afflictions };
}

export function worstCaseRun(): RunState {
  return {
    runId: 'run-fixture-0001',
    seed: 0x4b54524c,
    discClass: 'compiler',
    difficulty: 'operator',
    legIndex: 7,
    legProgress: 0.42,
    convoy: [
      member('lumen', 'LUMEN', 'compiler', 3, 88, 'nominal', []),
      member('sable', 'SABLE', 'sentinel', 4, 61, 'degraded', [affliction('starvation', 'Starvation')]),
      member('orrery', 'ORRERY', 'codec', 5, 97, 'nominal', []),
      member('kestrel', 'KESTREL', 'courier', 6, 34, 'critical', [
        affliction('priority_inversion', 'Priority inversion'),
        affliction('interrupt_storm', 'Interrupt storm'),
      ]),
      member('vesper', 'VESPER', 'cartographer', 7, 72, 'degraded', [affliction('thrashing', 'Thrashing')]),
    ],
    resources: { cycles: 1840, quota: 96, blocks: 412, bandwidth: 57 },
    policy: { pace: 'conservative', rations: 'generous', degreeOfMultiprogramming: 6 },
    tombstones: [],
    codexUnlocked: [],
    objectivesMet: [],
    decisions: [],
    score: { survivors: 0, throughput: 0, efficiency: 0, correctness: 0, conceptsMastered: 0, classMultiplier: 3.5, total: 0 },
    status: 'in_progress',
  };
}

export function worstCaseTelemetry(): HudTelemetry {
  return {
    tick: 4980,
    cpuUtilisation: 0.91,
    faultRate: 47,
    thrashingThreshold: 200,
    scheduler: 'priority_aging',
    quantum: 16,
    replacement: 'optimal',
    disk: 'cscan',
    allocation: 'first_fit',
    leg: { title: 'The Allocation Yards', index: 7, count: 13 },
  };
}

/** Three events that each produce an alert, the longest lines the table can make. */
export function worstCaseAlertEvents(): KernelEvent[] {
  return [
    { type: 'process.starving', tick: tick(4981), seq: 1, pid: pid(4), waitedTicks: 118, fatal: false },
    { type: 'memory.thrashing', tick: tick(4982), seq: 2, faultRate: 91, severity: 'critical' },
    { type: 'process.exited', tick: tick(4983), seq: 3, pid: pid(6), exitCode: 137, reason: 'thrashing_collapse' },
  ];
}

const POSE = { fov: 0.8, orthoHeight: 10 } as unknown as CameraPose;

export function focusStateOf(mode: FocusMode): FocusCameraState {
  return { mode, target: null, t: 0, blend: mode === 'locked' ? 1 : 0, from: POSE, to: POSE, durationMs: 520 };
}
