// @vitest-environment happy-dom
/**
 * The counterfactual planner (WP-18 acceptance 14 to 16) and the debrief
 * flow's failure path and computing state (acceptance 24).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKernel } from '../../src/kernel/Kernel';
import type { DebriefCard } from '../../src/game/types';
import { createDebriefCard, COUNTERFACTUAL_PENDING_TEXT } from '../../src/ui/cards/DebriefCard';
import { createHeadlessSetupContext } from '../../src/game/replay/headlessLegs';
import { DEFAULT_THRESHOLDS, planCounterfactuals, workloadIsScripted, type PlannerInput } from '../../src/game/replay/CounterfactualPlanner';
import { phraseCounterfactual } from '../../src/game/replay/phrasing';
import { initialRunState, runReplay } from '../../src/game/replay/runReplay';
import { createRunStreams, type ObservedLeg, type ReplayKernel, type ReplayOverrides } from '../../src/game/replay/types';
import { createSyntheticLeg, registerSynthetic, type SyntheticLegOptions } from './fixtures/syntheticLeg';

const undos: (() => void)[] = [];
afterEach(() => {
  while (undos.length > 0) undos.pop()?.();
});

/** A live kernel at leg end: the synthetic leg populated and run until the workload drains. */
function liveKernel(options: SyntheticLegOptions = {}, ticks = 400): ReplayKernel {
  const leg = createSyntheticLeg(options);
  const run = initialRunState(31, 'shell', 'operator');
  const kernel = createKernel({ ...leg.kernelConfig(run), seed: 31 });
  leg.populate(createHeadlessSetupContext(kernel, run, createRunStreams(31).leg.fork('boot_sector'), new Map()));
  kernel.run(ticks);
  return kernel;
}

const CLEAN: ObservedLeg = {
  casualties: [],
  scheduling: { averageWaitingTime: 12, averageTurnaroundTime: 40, averageResponseTime: 3, contextSwitches: 80, cpuUtilisation: 0.9, worstWait: 30 },
  memory: { pageFaults: 40, evictions: 10, faultRate: 12 },
  storage: { seekDistance: 300 },
};

function observed(patch: Partial<ObservedLeg>): ObservedLeg {
  return { ...CLEAN, ...patch };
}

function input(kernel: ReplayKernel, leg: ObservedLeg, patch: Partial<PlannerInput> = {}): PlannerInput {
  return { legId: 'boot_sector', seed: 31, discClass: 'shell', difficulty: 'operator', decisions: [], observed: leg, kernel, policy: { pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 6 }, maxTicks: 20_000, ...patch };
}

const OVERRIDE_KEYS = ['scheduler', 'quantum', 'replacement', 'diskPolicy', 'allocation', 'pace', 'rations', 'degreeOfMultiprogramming', 'suppressRecordedPolicyChanges'] as const;

describe('CounterfactualPlanner', () => {
  it('at most two: a leg that lost three Programs three ways plans two replays', () => {
    const kernel = liveKernel();
    const plans = planCounterfactuals(input(kernel, observed({
      casualties: [
        { member: 'sable', reason: 'starvation', tick: 300 },
        { member: 'vesper', reason: 'thrashing_collapse', tick: 500 },
        { member: 'orrery', reason: 'deadlock_victim', tick: 700 },
      ],
    })));
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.row)).toEqual(['starvation', 'thrashing']);
    for (const plan of plans) expect(plan.request.legs).toEqual(['boot_sector']);
  });

  it('starvation row: priority_aging, or rr when the player was already aging', () => {
    const kernel = liveKernel({ config: { scheduler: 'priority' } });
    const [plan] = planCounterfactuals(input(kernel, observed({ casualties: [{ member: 'sable', reason: 'starvation', tick: 300 }] })));
    expect(plan?.row).toBe('starvation');
    expect(plan?.request.overrides).toEqual({ scheduler: 'priority_aging', suppressRecordedPolicyChanges: true });
    expect(plan?.label).toBe('priority scheduling with aging');
    kernel.setScheduler('priority_aging');
    const [aging] = planCounterfactuals(input(kernel, observed({ casualties: [{ member: 'sable', reason: 'starvation', tick: 300 }] })));
    expect(aging?.request.overrides.scheduler).toBe('rr');
  });

  it('thrashing row: degreeOfMultiprogramming minus two', () => {
    const [plan] = planCounterfactuals(input(liveKernel(), observed({ casualties: [{ member: 'vesper', reason: 'thrashing_collapse', tick: 500 }] })));
    expect(plan?.row).toBe('thrashing');
    expect(plan?.request.overrides).toEqual({ degreeOfMultiprogramming: 4, suppressRecordedPolicyChanges: true });
    const [floor] = planCounterfactuals(input(liveKernel(), observed({ casualties: [{ member: 'vesper', reason: 'thrashing_collapse', tick: 500 }] }), { policy: { pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 2 } }));
    expect(floor?.request.overrides.degreeOfMultiprogramming).toBe(1);
  });

  it('deadlock row: deadlockStrategy avoid through the config patch', () => {
    const [plan] = planCounterfactuals(input(liveKernel(), observed({ casualties: [{ member: 'orrery', reason: 'deadlock_victim', tick: 700 }] })));
    expect(plan?.row).toBe('deadlock');
    expect(plan?.request.configPatch).toEqual({ deadlockStrategy: 'avoid' });
    expect(plan?.label).toBe('deadlock avoidance');
  });

  it('waiting row: high average waiting time with no casualty plans srtf', () => {
    const [plan] = planCounterfactuals(input(liveKernel(), observed({ scheduling: { ...CLEAN.scheduling, averageWaitingTime: DEFAULT_THRESHOLDS.averageWaitingTime + 1 } })));
    expect(plan?.row).toBe('waiting');
    expect(plan?.request.overrides.scheduler).toBe('srtf');
    // A casualty takes the row off the table; it is the no-casualty case.
    const withLoss = planCounterfactuals(input(liveKernel(), observed({ casualties: [{ member: 'sable', reason: 'starvation', tick: 3 }], scheduling: { ...CLEAN.scheduling, averageWaitingTime: 999 } })));
    expect(withLoss.map((p) => p.row)).toEqual(['starvation']);
  });

  it('faults row: high page faults with no casualty plans optimal, labelled the unachievable floor', () => {
    const kernel = liveKernel({ scripted: true });
    expect(workloadIsScripted(kernel)).toBe(true);
    const leg = observed({ memory: { ...CLEAN.memory, pageFaults: DEFAULT_THRESHOLDS.pageFaults + 1 } });
    const [plan] = planCounterfactuals(input(kernel, leg));
    expect(plan?.row).toBe('faults');
    expect(plan?.floor).toBe(true);
    expect(plan?.request.overrides.replacement).toBe('optimal');
    if (plan === undefined) throw new Error('no plan');
    const text = phraseCounterfactual({ baseline: leg, alternative: { ...fakeResult(leg), memory: { ...leg.memory, pageFaults: 90 } }, request: plan.request, floor: plan.floor });
    expect(text).toBe('Under optimal replacement, an unachievable floor, page faults fall from 201 to 90. Every Program survives either way.');
  });

  it('seek row: high seek distance plans clook', () => {
    const [plan] = planCounterfactuals(input(liveKernel(), observed({ storage: { seekDistance: DEFAULT_THRESHOLDS.seekDistance + 1 } })));
    expect(plan?.row).toBe('seek');
    expect(plan?.request.overrides.diskPolicy).toBe('clook');
  });

  it('nothing wrong row: a clean leg plans the next-worse policy', () => {
    const [plan] = planCounterfactuals(input(liveKernel(), CLEAN));
    expect(plan?.row).toBe('clean');
    expect(plan?.request.overrides.scheduler).toBe('fcfs');
    const [fromSrtf] = planCounterfactuals(input(liveKernel({ config: { scheduler: 'srtf' } }), CLEAN));
    expect(fromSrtf?.request.overrides.scheduler).toBe('sjf');
    // At the bottom of the scheduler ranking, the next dimension answers.
    const [replacement] = planCounterfactuals(input(liveKernel({ config: { scheduler: 'fcfs' } }), CLEAN));
    expect(replacement?.request.overrides.replacement).toBe('clock');
  });

  it('optimal skipped: the faults row is not planned when allProgramsScripted() is false', () => {
    const busy = liveKernel({}, 20);
    expect(busy.allProgramsScripted()).toBe(false);
    expect(workloadIsScripted(busy)).toBe(false);
    const leg = observed({ memory: { ...CLEAN.memory, pageFaults: 9999 } });
    expect(planCounterfactuals(input(busy, leg)).map((p) => p.row)).not.toContain('faults');
    // At leg end allProgramsScripted() is vacuously true (pre-flight finding 5); the program check still refuses.
    const drained = liveKernel({}, 4000);
    expect(drained.allProgramsScripted()).toBe(true);
    expect(workloadIsScripted(drained)).toBe(false);
    expect(planCounterfactuals(input(drained, leg)).map((p) => p.row)).not.toContain('faults');
  });

  it('deadlock without new field: the avoid replay runs and ReplayOverrides has no strategy member', () => {
    let strategy: string | null = null;
    undos.push(registerSynthetic({ hooks: { afterStep: (_at, kernel) => { strategy ??= kernel.config.deadlockStrategy; } } }));
    const [plan] = planCounterfactuals(input(liveKernel(), observed({ casualties: [{ member: 'orrery', reason: 'deadlock_victim', tick: 700 }] })));
    if (plan === undefined) throw new Error('no plan');
    expect(Object.keys(plan.request.overrides).every((key) => (OVERRIDE_KEYS as readonly string[]).includes(key))).toBe(true);
    const keys: readonly (keyof ReplayOverrides)[] = OVERRIDE_KEYS;
    expect(keys).not.toContain('deadlockStrategy');
    const response = runReplay(plan.request);
    expect(response.ok).toBe(true);
    expect(strategy).toBe('avoid');
    // The same leg without the patch keeps its own strategy.
    strategy = null;
    runReplay({ ...plan.request, configPatch: {} });
    expect(strategy).toBe('detect');
  });
});

const card: DebriefCard = {
  headline: 'The Reach took VESPER',
  whatHappened: 'You raised the degree of multiprogramming from 6 to 9 at tick 4980.',
  whyItHappened: 'Working sets no longer fit, and every process faulted on every page it needed.',
  counterfactual: null,
  chapter: { chapter: 10, sections: ['10.6'], title: 'Thrashing' },
};

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the debrief flow', () => {
  it('debrief non-blocking: with the worker failed the card renders complete and the counterfactual is null', async () => {
    const failed = Promise.reject<string | null>(new Error('replay worker crashed'));
    failed.catch(() => undefined);
    const crashed = createDebriefCard(document, card, failed);
    document.body.append(crashed.el);
    // Complete at once, before the promise settles: headline, both paragraphs and the citation.
    expect(crashed.el.querySelector('h2')?.textContent).toBe(card.headline);
    expect(crashed.el.querySelector('.kt-what')?.textContent).toBe(card.whatHappened);
    expect(crashed.el.querySelector('.kt-why')?.textContent).toBe(card.whyItHappened);
    expect(crashed.el.querySelector('.kt-cite')?.textContent).toContain('Ch. 10.6');
    await settled();
    expect(crashed.el.querySelector('.kt-counterfactual')).toBeNull();
    expect(crashed.el.querySelector('.kt-counterfactual-pending')).toBeNull();
    expect(crashed.el.textContent).not.toContain('If you had done it');
    expect(card.counterfactual).toBeNull();
    crashed.dispose();
    // A timeout resolves null and takes the same path.
    const timedOut = createDebriefCard(document, card, Promise.resolve(null));
    await settled();
    expect(timedOut.el.querySelector('.kt-counterfactual, .kt-counterfactual-pending')).toBeNull();
    // A disposed card ignores a late arrival.
    let arrive: (text: string | null) => void = () => undefined;
    const late = createDebriefCard(document, card, new Promise((resolve) => { arrive = resolve; }));
    late.dispose();
    arrive('too late');
    await settled();
    expect(late.el.querySelector('.kt-counterfactual')).toBeNull();
  });

  it('computing state: the slot shows a computing state until the result arrives, then fills it', async () => {
    let arrive: (text: string | null) => void = () => undefined;
    const pending = new Promise<string | null>((resolve) => { arrive = resolve; });
    const shown = createDebriefCard(document, card, pending);
    document.body.append(shown.el);
    const slot = shown.el.querySelector('.kt-counterfactual-pending');
    expect(slot?.textContent).toBe(COUNTERFACTUAL_PENDING_TEXT);
    expect(shown.el.textContent).toContain('If you had done it');
    expect(shown.el.querySelector('.kt-counterfactual')).toBeNull();
    // The citation stays last.
    expect(shown.el.lastElementChild?.className).toBe('kt-cite');
    arrive('Held at 6, VESPER survives with 71 integrity.');
    await settled();
    const filled = shown.el.querySelector('.kt-counterfactual');
    expect(filled?.textContent).toContain('71 integrity');
    expect(filled?.classList.contains('kt-counterfactual--arrived')).toBe(true);
    expect(shown.el.querySelector('.kt-counterfactual-pending')).toBeNull();
    // A card handed a finished counterfactual renders it at once with no computing state.
    const finished = createDebriefCard(document, { ...card, counterfactual: 'Held at 6, VESPER survives.' }, pending);
    expect(finished.el.querySelector('.kt-counterfactual')?.textContent).toBe('Held at 6, VESPER survives.');
    expect(finished.el.querySelector('.kt-counterfactual-pending')).toBeNull();
    shown.dispose();
  });
});

function fakeResult(leg: ObservedLeg) {
  return {
    ok: true as const,
    ticks: 1000,
    eventLogHash: '0'.repeat(16),
    survivors: ['lumen', 'sable', 'orrery', 'kestrel', 'vesper'],
    casualties: leg.casualties,
    scheduling: leg.scheduling,
    memory: leg.memory,
    storage: leg.storage,
    score: { survivors: 0, throughput: 0, efficiency: 0, correctness: 0, conceptsMastered: 0, classMultiplier: 1, total: 0 },
    highlights: [],
    diagnostics: { skippedDecisions: 0, legs: [] },
  };
}
