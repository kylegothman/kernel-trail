import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitReadback } from './gpu/awaitReadback';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function controlledRaf() {
  const callbacks: FrameRequestCallback[] = [];
  let next = 0;
  let time = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callbacks.push(callback);
    return ++next;
  });
  const step = vi.fn((ms: number): void => {
    time += ms;
    for (const callback of callbacks.splice(0)) callback(time);
  });
  return { step, get time() { return time; }, get pending() { return callbacks.length; } };
}

describe('boot GPU readback under controlled RAF', () => {
  it('services repeated fence polls without advancing simulation time', async () => {
    const clock = controlledRaf();
    const pixels = new Uint8Array([4, 7, 12, 255]);
    const readback = new Promise<Uint8Array>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(pixels)));
    });
    expect(await awaitReadback(readback, clock)).toBe(pixels);
    expect(clock.step.mock.calls).toEqual([[0], [0]]);
    expect(clock.time).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it.each([new Error('fence failed'), undefined])('propagates a fence rejection with reason %s', async reason => {
    const clock = controlledRaf();
    const readback = new Promise<never>((_resolve, reject) => {
      requestAnimationFrame(() => requestAnimationFrame(() => reject(reason)));
    });
    await expect(awaitReadback(readback, clock)).rejects.toBe(reason);
    expect(clock.step.mock.calls).toEqual([[0], [0]]);
    expect(clock.time).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('reports a stalled readback within the fixture readiness window', async () => {
    vi.useFakeTimers();
    const readback = new Promise<never>(() => undefined);
    const step = vi.fn(() => { vi.setSystemTime(Date.now() + 10_000); });
    const failure = expect(awaitReadback(readback, { step })).rejects.toThrow('GPU readback did not settle within 10000ms');
    await vi.runAllTimersAsync();
    await failure;
    expect(step).toHaveBeenCalledExactlyOnceWith(0);
  });
});
