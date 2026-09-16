/**
 * WP-L04 acceptance 14 and scope correction 17.3: the ford holds three, the
 * count is fixed when the semaphore is created, and the dial chooses between
 * the three counts the leg declared rather than raising one of them.
 */
import { describe, expect, it } from 'vitest';
import { asResourceId } from '@kernel/types';
import {
  advanceCapacityDial, CAPACITY_POSITIONS, capacityDial, FORD_WIDTH, fordSemaphore,
  SEM_FORD, SEM_FORD_3, SEM_FORD_4, setCapacityDial,
} from '@legs/the_narrows/ledger';
import { SEMAPHORE_CAPACITY } from '@legs/the_narrows/objectives';
import { narrowsKernel } from './kernelFixture';
import { objectivesAfter } from './evaluateFixture';

describe('the ford count', () => {
  it('declares one semaphore per count the dial can select, because a count is fixed at creation', () => {
    const fixture = narrowsKernel();
    const view = fixture.kernel.invariantState();
    const capacity = (id: string): number | undefined => view.syncPrimitives.find((primitive) => primitive.id === asResourceId(id))?.capacity;
    expect(capacity(SEM_FORD)).toBe(1);
    expect(capacity(SEM_FORD_3)).toBe(FORD_WIDTH);
    expect(capacity(SEM_FORD_4)).toBe(4);
    expect(FORD_WIDTH).toBe(3);
  });

  it('starts at one and steps one, three, four and back to one', () => {
    const fixture = narrowsKernel();
    expect(capacityDial(fixture.kernel)).toBe(1);
    expect(CAPACITY_POSITIONS).toEqual([1, 3, 4]);
    expect(advanceCapacityDial(fixture.kernel)).toBe(3);
    expect(advanceCapacityDial(fixture.kernel)).toBe(4);
    expect(advanceCapacityDial(fixture.kernel)).toBe(1);
  });

  it('sends the workload to the semaphore the dial names', () => {
    expect(fordSemaphore(1)).toBe(SEM_FORD);
    expect(fordSemaphore(FORD_WIDTH)).toBe(SEM_FORD_3);
    expect(fordSemaphore(4)).toBe(SEM_FORD_4);
  });

  it('admits at most the count it was created with, and never more', () => {
    for (const [dial, id] of [[1, SEM_FORD], [FORD_WIDTH, SEM_FORD_3], [4, SEM_FORD_4]] as const) {
      const fixture = narrowsKernel();
      setCapacityDial(fixture.kernel, dial);
      fixture.run(140);
      const primitive = fixture.kernel.invariantState().syncPrimitives.find((row) => row.id === id);
      expect(primitive?.holders.length ?? 0, `${id} at dial ${dial}`).toBeLessThanOrEqual(dial);
      const acquired = fixture.events('sync.acquired').filter((event) => event.type === 'sync.acquired' && event.resource === id);
      const released = fixture.events('sync.released').filter((event) => event.type === 'sync.released' && event.resource === id);
      expect(acquired.length - released.length).toBeLessThanOrEqual(dial);
    }
  });

  it('meets the objective only at three, because that is how wide the ford is', () => {
    expect(objectivesAfter({ capacity: FORD_WIDTH })).toContain(SEMAPHORE_CAPACITY);
    expect(objectivesAfter({ capacity: 1 })).not.toContain(SEMAPHORE_CAPACITY);
    expect(objectivesAfter({ capacity: 4 })).not.toContain(SEMAPHORE_CAPACITY);
    expect(objectivesAfter({ capacity: FORD_WIDTH, admittedPastWidth: true })).not.toContain(SEMAPHORE_CAPACITY);
    expect(objectivesAfter({ capacity: FORD_WIDTH, blockedWithRoom: true })).not.toContain(SEMAPHORE_CAPACITY);
  });
});
