/**
 * WP-L04 acceptance 5: every objective, met and not met, and the debrief the
 * player reads. Both routes through the three requirements are exercised: the
 * player who reasons about bounded waiting, and the player who picks an
 * ordered primitive and never notices why.
 */
import { describe, expect, it } from 'vitest';
import { counterfactualFor, parseMarks, spunTicksOf, SPUN_TICK_BUDGET } from '@legs/the_narrows/evaluate';
import { GUARDED_REGION } from '@legs/the_narrows/ledger';
import {
  ATOMIC_PRIMITIVE, MINIMAL_CRITICAL_SECTION, OBJECTIVE_IDS, PRIORITY_INVERSION,
  SEMAPHORE_CAPACITY, SPIN_VERSUS_BLOCK, THREE_REQUIREMENTS,
} from '@legs/the_narrows/objectives';
import { PLANK, SECOND_FORD, WIDE_FORD_3 } from '@legs/the_narrows/crossings';
import { analysisWith, objectivesAfter, runWith } from './evaluateFixture';
import type { ConvoyMember } from '@game/types';

const derezzSable = (): ReturnType<typeof runWith> => {
  const run = runWith();
  const sable = run.convoy.find((member: ConvoyMember) => member.id === 'sable');
  if (sable !== undefined) { sable.status = 'derezzed'; sable.integrity = 0; }
  return run;
};

describe('the six objectives', () => {
  it('meets all six on a clean analysis', () => {
    expect([...objectivesAfter({})].sort()).toEqual([...OBJECTIVE_IDS].sort());
  });

  describe('three requirements', () => {
    it('holds when the protocol was installed and nothing that began after it took the old path', () => {
      expect(objectivesAfter({})).toContain(THREE_REQUIREMENTS);
    });
    it('fails when a write that began after the swap still took the old path', () => {
      expect(objectivesAfter({ unguardedAfterFix: 1 })).not.toContain(THREE_REQUIREMENTS);
    });
    it('fails when no protocol was ever installed', () => {
      expect(objectivesAfter({ casInstalledAt: null })).not.toContain(THREE_REQUIREMENTS);
    });
    it('fails when a Program was overtaken more than twice, which is the reasoning route', () => {
      expect(objectivesAfter({ boundedWaitingHeld: false })).not.toContain(THREE_REQUIREMENTS);
    });
    it('passes on the structural route too: an ordered primitive bounds the wait whether or not the player noticed', () => {
      expect(objectivesAfter({ boundedWaitingHeld: true, nearDeficit: 3 })).toContain(THREE_REQUIREMENTS);
    });
  });

  describe('spin against block', () => {
    it('admits spinning at the plank, which is the cheapest crossing in the game', () => {
      expect(objectivesAfter({ crossingOptions: [{ id: PLANK, option: 'spin' }] })).toContain(SPIN_VERSUS_BLOCK);
    });
    it('refuses spinning at the second ford, where the hold is real', () => {
      expect(objectivesAfter({ crossingOptions: [{ id: PLANK, option: 'spin' }, { id: SECOND_FORD, option: 'spin' }] })).not.toContain(SPIN_VERSUS_BLOCK);
    });
    it('refuses spinning at the wide ford', () => {
      expect(objectivesAfter({ crossingOptions: [{ id: WIDE_FORD_3, option: 'spin' }] })).not.toContain(SPIN_VERSUS_BLOCK);
    });
    it('refuses a leg that spun past the budget', () => {
      expect(objectivesAfter({ spunTicks: SPUN_TICK_BUDGET })).not.toContain(SPIN_VERSUS_BLOCK);
      expect(objectivesAfter({ spunTicks: SPUN_TICK_BUDGET - 1 })).toContain(SPIN_VERSUS_BLOCK);
    });
    it('refuses a leg that crossed nothing', () => {
      expect(objectivesAfter({ crossingOptions: [] })).not.toContain(SPIN_VERSUS_BLOCK);
    });
  });

  describe('the minimal critical section', () => {
    it('takes a mark that covers the acquire through the release and is under six long', () => {
      expect(objectivesAfter({ marks: [{ start: GUARDED_REGION.first, end: GUARDED_REGION.last }] })).toContain(MINIMAL_CRITICAL_SECTION);
    });
    it('refuses a mark that leaves the load outside the guard', () => {
      expect(objectivesAfter({ marks: [{ start: GUARDED_REGION.first + 2, end: GUARDED_REGION.last }] })).not.toContain(MINIMAL_CRITICAL_SECTION);
    });
    it('refuses a mark that stops before the release', () => {
      expect(objectivesAfter({ marks: [{ start: GUARDED_REGION.first, end: GUARDED_REGION.last - 1 }] })).not.toContain(MINIMAL_CRITICAL_SECTION);
    });
    it('refuses a section six ticks or longer, which excludes everyone for no reason', () => {
      expect(objectivesAfter({ marks: [{ start: GUARDED_REGION.first - 1, end: GUARDED_REGION.last + 4 }] })).not.toContain(MINIMAL_CRITICAL_SECTION);
    });
    it('refuses a leg that marked nothing', () => {
      expect(objectivesAfter({ marks: [] })).not.toContain(MINIMAL_CRITICAL_SECTION);
    });
  });

  describe('the atomic primitive', () => {
    it('wants the swap and a replay that shows it held', () => {
      expect(objectivesAfter({})).toContain(ATOMIC_PRIMITIVE);
    });
    it('refuses the swap without the replay, because the point is proving it', () => {
      expect(objectivesAfter({ replays: 0 })).not.toContain(ATOMIC_PRIMITIVE);
    });
    it('refuses a replay with no swap behind it', () => {
      expect(objectivesAfter({ casInstalledAt: null })).not.toContain(ATOMIC_PRIMITIVE);
    });
  });

  describe('the priority inversion', () => {
    it('wants the inversion to have happened, the toggle to have been used, and SABLE to be standing', () => {
      expect(objectivesAfter({})).toContain(PRIORITY_INVERSION);
    });
    it('refuses a toggle on a leg where nobody ever waited', () => {
      expect(objectivesAfter({ sableWait: 0 })).not.toContain(PRIORITY_INVERSION);
    });
    it('refuses a leg that never toggled', () => {
      expect(objectivesAfter({ inheritanceToggled: false })).not.toContain(PRIORITY_INVERSION);
    });
    it('refuses a leg where SABLE did not survive the deadline', () => {
      expect(objectivesFromDerezzed()).not.toContain(PRIORITY_INVERSION);
    });
  });

  it('meets the semaphore objective only at the width of the ford', () => {
    expect(objectivesAfter({})).toContain(SEMAPHORE_CAPACITY);
    expect(objectivesAfter({ wideFordCrossed: null, capacity: 1 })).not.toContain(SEMAPHORE_CAPACITY);
  });
});

function objectivesFromDerezzed(): readonly string[] {
  return objectivesAfter({}, derezzSable());
}

describe('reading the run', () => {
  it('parses the mark the player typed, and ignores every other terminal line', () => {
    expect(parseMarks([
      { tick: 1 as never, legId: 'the_narrows', kind: 'terminal', choice: '[terminal] lock --mark 16 21', outcome: 'pending', relatedObjective: null },
      { tick: 2 as never, legId: 'the_narrows', kind: 'terminal', choice: '[terminal] lock --list', outcome: 'pending', relatedObjective: null },
      { tick: 3 as never, legId: 'the_narrows', kind: 'interaction', choice: 'narrows.use_cas @ anchor.plank', outcome: 'pending', relatedObjective: null },
    ])).toEqual([{ start: 16, end: 21 }]);
  });

  it('sums the last spun total per Program, because the figure on each event is cumulative', () => {
    const event = (pid: number, spunTicks: number, seq: number) =>
      ({ type: 'sync.busy_wait', tick: seq as never, seq, pid: pid as never, resource: 'lock.plank' as never, spunTicks }) as never;
    expect(spunTicksOf([event(2, 1, 1), event(2, 2, 2), event(2, 3, 3), event(3, 1, 4), event(3, 2, 5)])).toBe(5);
  });
});

describe('the counterfactual, in the order the package sets', () => {
  it('leads with the manifest when the far post is wrong', () => {
    expect(counterfactualFor(analysisWith({ farDeficit: 1, farValue: 2, farExpected: 3 }))).toContain('The manifest you are carrying reads 2.');
  });
  it('falls to the near post when only that one lost an increment', () => {
    expect(counterfactualFor(analysisWith({ farDeficit: 0, nearDeficit: 2 }))).toContain('on the near post');
  });
  it('names the wait when the inversion is the story', () => {
    const text = counterfactualFor(analysisWith({ farDeficit: 0, nearDeficit: 0, sableWait: 240 }));
    expect(text).toContain('SABLE waited 240 ticks');
  });
  it('names the spin budget when the convoy burned it', () => {
    const text = counterfactualFor(analysisWith({ farDeficit: 0, nearDeficit: 0, sableWait: 0, sableAfflicted: false, spunTicks: 60 }));
    expect(text).toContain('You spun 60 ticks');
  });
  it('names the ford width when the count was wrong', () => {
    const text = counterfactualFor(analysisWith({ farDeficit: 0, nearDeficit: 0, sableWait: 0, spunTicks: 0, capacity: 1 }));
    expect(text).toBe('The ford holds 3. Your semaphore admitted 1.');
  });
  it('says nothing when there is nothing to say', () => {
    expect(counterfactualFor(analysisWith({ farDeficit: 0, nearDeficit: 0, sableWait: 0, spunTicks: 0, wideFordCrossed: null }))).toBeNull();
  });
});
