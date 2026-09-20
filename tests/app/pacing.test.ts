// @vitest-environment happy-dom
/**
 * WP-24 section 1: the player's clock. The mapping onto the loop's time
 * scale, the hold stack, the pace keys, the panel hold hook and the HUD's
 * pace indicator.
 */
import { describe, expect, it, vi } from 'vitest';
import { GameLoop, TICK_HZ, TICK_MS, type SimHost } from '@app/loop';
import { PLAYER_TICK_HZ, PLAYER_TIME_SCALES, createPacing, paceLabel, ticksPerSecondOf } from '@app/pacing';
import { installInput } from '@app/input';
import { DeferredPanel, type PanelOptions, type PanelShell } from '@app/panels/panel';
import { createHud } from '@ui/hud/Hud';
import { createRunStore, createTelemetryStore } from '@game/runStore';
import { initialRunState } from '@game/replay/runReplay';

function fakeLoop(): { readonly loop: Pick<GameLoop, 'setTimeScale'>; readonly scales: number[] } {
  const scales: number[] = [];
  return { loop: { setTimeScale: (scale: number) => { scales.push(scale); } }, scales };
}

describe('createPacing', () => {
  it('maps ticks per second onto the loop as ticksPerSecond / TICK_HZ and starts at the default', () => {
    const { loop, scales } = fakeLoop();
    const pacing = createPacing(loop);
    expect(PLAYER_TICK_HZ).toBe(2);
    expect(scales.at(-1)).toBe(PLAYER_TICK_HZ / TICK_HZ);
    expect(pacing.rate()).toBe(2);
    pacing.setRate(4);
    expect(scales.at(-1)).toBeCloseTo(4 / TICK_HZ);
    expect(pacing.rate()).toBe(4);
    expect(PLAYER_TIME_SCALES.map(ticksPerSecondOf)).toEqual([1, 2, 4]);
    expect(() => pacing.setRate(0)).toThrow(RangeError);
  });

  it('a hold pauses the loop and remembers the rate; stacked holds release in either order', () => {
    const { loop, scales } = fakeLoop();
    const paused: boolean[] = [];
    const pacing = createPacing(loop, state => paused.push(state));
    pacing.setRate(4);
    const releaseDebrief = pacing.hold('debrief');
    const releaseCrossing = pacing.hold('crossing');
    expect(scales.at(-1)).toBe(0);
    expect(pacing.rate()).toBe(0);
    expect(pacing.held()).toEqual(['debrief', 'crossing']);
    releaseDebrief();
    expect(scales.at(-1)).toBe(0);
    expect(pacing.held()).toEqual(['crossing']);
    releaseCrossing();
    expect(scales.at(-1)).toBeCloseTo(4 / TICK_HZ);
    expect(pacing.rate()).toBe(4);
    // Releasing twice does nothing, and a rate set while held lands on release.
    releaseCrossing();
    expect(pacing.held()).toEqual([]);
    const release = pacing.hold('player');
    pacing.setRate(1);
    expect(scales.at(-1)).toBe(0);
    release();
    expect(scales.at(-1)).toBeCloseTo(1 / TICK_HZ);
    expect(paused).toEqual([false, false, true, true, true, false, true, true, false]);
  });

  it('really stops the ticks: a held loop advances no tick across two seconds and advances again after release', () => {
    let now = 0;
    const scheduled: ((now: number) => void)[] = [];
    let ticks = 0;
    const host: SimHost = { applyPendingCommands: () => undefined, fixedUpdate: () => { ticks++; }, flushState: () => undefined,
      routeEvents: () => undefined, variableUpdate: () => undefined, render: () => undefined, onFrameMetrics: () => undefined, onRunStateChanged: () => undefined };
    const loop = new GameLoop({ host, clock: { now: () => now, schedule: cb => { scheduled.push(cb); return scheduled.length; }, cancel: () => undefined } });
    const pacing = createPacing(loop);
    loop.start();
    const frames = (count: number): void => { for (let i = 0; i < count; i++) { now += 1000 / 60; const next = scheduled.splice(0); for (const cb of next) cb(now); } };
    frames(120);
    expect(ticks).toBe(4);
    const release = pacing.hold('crossing');
    frames(120);
    expect(ticks).toBe(4);
    release();
    frames(120);
    expect(ticks).toBe(8);
    expect(TICK_MS).toBe(50);
  });

  it('labels the rate, or the top hold when paused', () => {
    const { loop } = fakeLoop();
    const pacing = createPacing(loop);
    expect(paceLabel(pacing)).toBe('2x');
    pacing.setRate(4);
    expect(paceLabel(pacing)).toBe('4x');
    const releaseCrossing = pacing.hold('crossing');
    expect(paceLabel(pacing)).toBe('paused (crossing)');
    const releasePlayer = pacing.hold('player');
    expect(paceLabel(pacing)).toBe('paused (player)');
    releasePlayer();
    expect(paceLabel(pacing)).toBe('paused (crossing)');
    releaseCrossing();
    expect(paceLabel(pacing)).toBe('4x');
  });
});

describe('the pace keys', () => {
  function rig(blocked = false) {
    const { loop, scales } = fakeLoop();
    const pacing = createPacing(loop);
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const unbind = installInput({ document, canvas, pacing, focus: { state: { mode: 'free' }, release: vi.fn(), engage: vi.fn(), camera: { position: { distanceToSquared: () => 0 } } } as never,
      target: { focus: { x: 0, y: 0, z: 0 }, yawRad: 0, pitchRad: 0, distanceM: 10 } as never, structures: () => [], terminal: () => null,
      toggleCodex: () => undefined, commit: write => write(), controlsBlocked: () => blocked });
    const key = (code: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true })); };
    return { pacing, scales, key, unbind };
  }

  it('Space toggles a hold named player and the brackets step through the three scales', () => {
    const r = rig();
    r.key('Space');
    expect(r.pacing.held()).toEqual(['player']);
    expect(r.pacing.rate()).toBe(0);
    r.key('Space');
    expect(r.pacing.held()).toEqual([]);
    expect(r.pacing.rate()).toBe(2);
    r.key('BracketRight');
    expect(r.pacing.rate()).toBe(4);
    r.key('BracketRight');
    expect(r.pacing.rate()).toBe(4);
    r.key('BracketLeft'); r.key('BracketLeft');
    expect(r.pacing.rate()).toBe(1);
    r.key('BracketLeft');
    expect(r.pacing.rate()).toBe(1);
    // A rate chosen under the player's own pause lands when the pause lifts.
    r.key('Space'); r.key('BracketRight');
    expect(r.pacing.rate()).toBe(0);
    r.key('Space');
    expect(r.pacing.rate()).toBe(2);
    r.unbind();
  });

  it('blocked controls change nothing, and unbinding releases the player hold', () => {
    const r = rig(true);
    r.key('Space'); r.key('BracketRight');
    expect(r.pacing.held()).toEqual([]);
    expect(r.pacing.rate()).toBe(2);
    r.unbind();
    const open = rig();
    open.key('Space');
    expect(open.pacing.held()).toEqual(['player']);
    open.unbind();
    expect(open.pacing.held()).toEqual([]);
  });
});

describe('the panel hold hook', () => {
  class Question extends DeferredPanel {
    constructor(options: PanelOptions) { super(options, 'crossing', 'Crossing'); }
    open(): void { this.show(); }
    protected render(shell: PanelShell): void { shell.body.textContent = 'a question'; }
  }
  class Always extends DeferredPanel {
    constructor(options: PanelOptions) { super(options, 'interactions', 'Anchors'); }
    open(): void { this.show(); }
    protected render(): void { /* nothing to draw */ }
  }

  it('a panel with the hook holds by its variant name from show to close, once, and releases on dispose', () => {
    const { loop } = fakeLoop();
    const pacing = createPacing(loop);
    const overlay = document.createElement('div'); document.body.append(overlay);
    const panel = new Question({ document, overlay, hold: reason => pacing.hold(reason) });
    panel.open(); panel.open();
    expect(pacing.held()).toEqual(['crossing']);
    panel.flush();
    panel.close();
    expect(pacing.held()).toEqual([]);
    panel.open();
    expect(pacing.held()).toEqual(['crossing']);
    panel.dispose();
    expect(pacing.held()).toEqual([]);
    const always = new Always({ document, overlay });
    always.open(); always.flush();
    expect(pacing.held()).toEqual([]);
    always.dispose();
  });
});

describe('the pace indicator', () => {
  it('sits in the top-right cell under the tick and repaints only on a changed label', () => {
    const root = document.createElement('div'); document.body.append(root);
    const runStore = createRunStore(initialRunState(1, 'shell', 'operator'));
    const telemetry = createTelemetryStore({ tick: 0, cpuUtilisation: 0, faultRate: 0, thrashingThreshold: 0, scheduler: 'rr', quantum: 4,
      replacement: 'fifo', disk: 'fcfs', allocation: 'first_fit', leg: { title: 'The Boot Sector', index: 0, count: 13 } });
    const hud = createHud({ root, runStore, telemetry, clock: () => 0, focusState: () => ({ mode: 'free' }) as never, injectStyle: false });
    hud.flush();
    expect(hud.cell('policyChips').contains(hud.pace)).toBe(true);
    expect(hud.pace.previousElementSibling?.querySelector('.kt-tick')).not.toBeNull();
    hud.setPace('2x'); hud.flush();
    expect(hud.pace.textContent).toBe('2x');
    expect(hud.isActive('policyChips')).toBe(true);
    hud.setPace('paused (crossing)'); hud.flush();
    expect(hud.pace.textContent).toBe('paused (crossing)');
    hud.dispose();
  });
});
