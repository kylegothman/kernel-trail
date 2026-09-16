// @vitest-environment happy-dom
/**
 * The HUD, visual bible 11 and WP-17 acceptance 4 to 14. happy-dom gives a
 * DOM without layout, so geometry lives in the browser run
 * (tests/render/gpu/hud.gpu.ts); everything else is asserted here.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AMBER, CYAN, TEXT_CONTRAST, VOID, cssColor } from '../../src/design';
import { STRUCTURE_NAMES } from '../../src/world/structures/base/StructureRegistry';
import { DEREZZ_TIMING } from '../../src/render/derezz/variants';
import { createRunStore, createTelemetryStore } from '../../src/game/runStore';
import type { HudTelemetry } from '../../src/game/runStore';
import type { RunState } from '../../src/game/types';
import type { KernelEvent, Pid, Tick } from '../../src/kernel/types';
import type { FocusMode } from '../../src/render/camera/focusContract';
import { DomBatch } from '../../src/ui/DomBatch';
import { Hud } from '../../src/ui/hud/Hud';
import { contrastRatio } from '../../src/ui/hud/contrast';
import { ALERT_STYLE, HUD_CSS, HUD_TEXT_TOKENS } from '../../src/ui/hud/hud.css';
import {
  HUD_ACTIVE,
  HUD_ACTIVE_HOLD_MS,
  HUD_ALERT_MAX,
  HUD_ALERT_MAX_CHARS,
  HUD_ALERT_TTL_MS,
  HUD_EASE_BACK_MS,
  HUD_FOCUSED,
  HUD_METER_WIDTH_PX,
  HUD_REGION_IDS,
  HUD_REST,
  HUD_SAFE,
  hudSafeInsetPx,
} from '../../src/ui/hud/layout';
import { HUD_KERNEL_NAME, HUD_STRUCTURE_NAMES } from '../../src/ui/hud/structures';
import { legRailProps } from '../../src/ui/hud/regions/LegRail';
import { policyChipsProps } from '../../src/ui/hud/regions/PolicyChips';
import { metersProps } from '../../src/ui/hud/regions/Meters';
import { convoyPipsProps } from '../../src/ui/hud/regions/ConvoyPips';
import { resourceLedgerProps } from '../../src/ui/hud/regions/ResourceLedgerView';
import type { UiSounds } from '../../src/ui/sounds';
import { collectSources, reportOffences, scanFiles, UI_ROOT } from './uiSourceScan';
import { focusStateOf, worstCaseAlertEvents, worstCaseRun, worstCaseTelemetry } from './fixtures';

const tick = (n: number): Tick => n as Tick;
const pid = (n: number): Pid => n as Pid;

interface Rig {
  readonly hud: Hud;
  readonly runStore: ReturnType<typeof createRunStore>;
  readonly telemetry: ReturnType<typeof createTelemetryStore>;
  readonly clock: { now: number };
  readonly focus: { mode: FocusMode };
  readonly sounds: UiSounds & { readonly calls: string[] };
  readonly root: HTMLElement;
  /** Flush the stores and the DOM batch: one game frame. */
  frame(advanceMs?: number): void;
}

function spySounds(): UiSounds & { readonly calls: string[] } {
  const calls: string[] = [];
  const cue = (name: string) => (): void => {
    calls.push(name);
  };
  return {
    calls,
    unlock: cue('unlock'),
    keyTick: cue('keyTick'),
    commandAccept: cue('commandAccept'),
    commandReject: cue('commandReject'),
    alertAppear: cue('alertAppear'),
    focusEngage: cue('focusEngage'),
    focusRelease: cue('focusRelease'),
  };
}

function rig(run: RunState = worstCaseRun(), tel: HudTelemetry = worstCaseTelemetry(), batch?: DomBatch): Rig {
  const root = document.createElement('div');
  document.body.append(root);
  const runStore = createRunStore(run);
  const telemetry = createTelemetryStore(tel);
  const clock = { now: 10_000 };
  const focus: { mode: FocusMode } = { mode: 'free' };
  const sounds = spySounds();
  const hud = new Hud({
    root,
    runStore,
    telemetry,
    clock: () => clock.now,
    focusState: () => focusStateOf(focus.mode),
    sounds,
    ...(batch === undefined ? {} : { batch }),
  });
  const frame = (advanceMs = 0): void => {
    clock.now += advanceMs;
    runStore.flush();
    telemetry.flush();
    hud.frame(clock.now);
    hud.flush();
  };
  return { hud, runStore, telemetry, clock, focus, sounds, root, frame };
}

const HUD_FILES = collectSources(join(UI_ROOT, 'hud'));

describe('HUD', () => {
  it('six regions: all six render from the fixture run state', () => {
    const r = rig();
    for (const e of worstCaseAlertEvents()) r.hud.consume(e);
    r.hud.setHover('FrameVault');
    r.frame();
    for (const id of HUD_REGION_IDS) expect(r.hud.cell(id).isConnected, id).toBe(true);
    expect(r.hud.cell('legRail').textContent).toContain('The Allocation Yards');
    expect(r.hud.cell('legRail').textContent).toContain('7 of 13');
    const chips = r.hud.cell('policyChips').textContent ?? '';
    for (const word of ['priority_aging', '16', 'optimal', 'cscan', 'first_fit', 'conservative', 'generous']) expect(chips).toContain(word);
    expect(r.hud.cell('convoyPips').querySelectorAll('.kt-pip')).toHaveLength(5);
    expect(r.hud.cell('convoyPips').textContent).toContain('KESTREL');
    expect(r.hud.cell('convoyPips').textContent).toContain('PI IS');
    const ledger = r.hud.cell('resourceLedger').textContent ?? '';
    for (const word of ['cycles', '1840', 'quota', '96', 'blocks', '412', 'bandwidth', '57']) expect(ledger).toContain(word);
    expect(r.hud.cell('alertStack').querySelectorAll('.kt-alert')).toHaveLength(3);
    expect(r.hud.cell('focusHint').textContent).toContain('FrameVault');
    expect(r.hud.cell('focusHint').textContent).toContain('[F] engage');
    r.hud.dispose();
    expect(r.root.childElementCount).toBe(0);
  });

  it('two meters: CPU utilisation and fault rate as 96 px bars with a marked threshold', () => {
    const r = rig();
    const meters = r.hud.cell('policyChips').querySelectorAll<HTMLElement>('.kt-meter');
    expect(meters).toHaveLength(2);
    expect(HUD_CSS).toContain(`.kt-bar {`);
    expect(HUD_CSS).toContain(`width: ${HUD_METER_WIDTH_PX}px;`);
    expect(HUD_METER_WIDTH_PX).toBe(96);
    const [cpu, fault] = [meters[0], meters[1]];
    expect(cpu?.style.getPropertyValue('--kt-fill')).toBe('0.9100');
    expect(cpu?.querySelector<HTMLElement>('.kt-bar-mark')?.style.getPropertyValue('--kt-mark')).toBe('0.8500');
    // 47 per thousand against a threshold of 200: the meter spans twice the threshold.
    expect(fault?.style.getPropertyValue('--kt-fill')).toBe((47 / 400).toFixed(4));
    expect(fault?.querySelector<HTMLElement>('.kt-bar-mark')?.style.getPropertyValue('--kt-mark')).toBe('0.5000');
  });

  it('forbidden data: no region reads a kernel structure, and every props shape is scalar', () => {
    const offences = scanFiles(
      HUD_FILES,
      /\b(KernelSnapshot|SchedulerSnapshot|pageTables|frameTable|readyQueue|waitFor|bankers|Banker|diskQueue|allocationTable|syncPrimitives|inodes|journal|domains)\b|\.(processes|frames|queues|devices)\b/,
      'code',
    );
    expect(reportOffences(offences)).toBe('');
    const run = worstCaseRun();
    const tel = worstCaseTelemetry();
    const props: unknown[] = [
      legRailProps(tel.leg, run.legProgress),
      policyChipsProps(tel, run.policy),
      metersProps(tel),
      convoyPipsProps(run.convoy),
      resourceLedgerProps(run.resources),
    ];
    const walk = (v: unknown, path: string): void => {
      if (v === null || typeof v !== 'object') {
        expect(['string', 'number', 'boolean'].includes(typeof v) || v === null, `${path} is a ${typeof v}`).toBe(true);
        return;
      }
      if (Array.isArray(v)) {
        expect(v.length, `${path} has ${v.length} entries`).toBeLessThanOrEqual(13);
        v.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      for (const [k, item] of Object.entries(v)) {
        expect(k, `${path}.${k}`).not.toMatch(/^(pid|pids|tid|frame|frames|page|pages|queue|queues|matrix|table)$/);
        walk(item, `${path}.${k}`);
      }
    };
    props.forEach((p, i) => walk(p, `props[${i}]`));
    const pips = convoyPipsProps(run.convoy).pips;
    expect(pips).toHaveLength(5);
    expect(JSON.stringify(pips)).not.toContain('pid');
  });

  it('safe area: the container is inset by max(24px, 2.5vh) on every edge', () => {
    expect(HUD_SAFE).toBe('max(24px, 2.5vh)');
    expect(HUD_CSS).toContain(`--hud-safe: ${HUD_SAFE};`);
    expect(HUD_CSS).toMatch(/\.kt-hud \{[^}]*position: absolute;[^}]*inset: var\(--hud-safe\);/);
    expect(hudSafeInsetPx(900)).toBe(24);
    expect(hudSafeInsetPx(1200)).toBe(30);
  });

  it('opacity states: rest 0.72, a changed value 1.0 for 1.2 s then a 400 ms ease back, focus lock 0.25 with alerts at 1.0', () => {
    expect([HUD_REST, HUD_ACTIVE, HUD_FOCUSED, HUD_ACTIVE_HOLD_MS, HUD_EASE_BACK_MS]).toEqual([0.72, 1, 0.25, 1200, 400]);
    expect(HUD_CSS).toContain('--hud-rest: 0.72;');
    expect(HUD_CSS).toContain('--hud-active: 1;');
    expect(HUD_CSS).toContain('--hud-focused: 0.25;');
    expect(HUD_CSS).toMatch(/\.kt-hud > \.kt-cell \{[^}]*opacity: var\(--hud-rest\);[^}]*transition: opacity 400ms/);
    expect(HUD_CSS).toContain('.kt-hud > .kt-cell[data-hud-state="active"] { opacity: var(--hud-active); transition: none; }');
    expect(HUD_CSS).toContain('.kt-hud[data-focus="locked"] > .kt-cell { opacity: var(--hud-focused); }');
    expect(HUD_CSS).toContain('.kt-hud[data-focus="locked"] > .kt-cell.kt-alerts { opacity: var(--hud-active); }');

    const r = rig();
    r.frame();
    for (const id of HUD_REGION_IDS) expect(r.hud.opacityOf(id), id).toBe(HUD_REST);

    r.runStore.mutate((s) => {
      s.resources.cycles -= 40;
    });
    r.frame();
    expect(r.hud.opacityOf('resourceLedger')).toBe(HUD_ACTIVE);
    expect(r.hud.cell('resourceLedger').getAttribute('data-hud-state')).toBe('active');
    expect(r.hud.opacityOf('convoyPips')).toBe(HUD_REST);
    r.frame(HUD_ACTIVE_HOLD_MS - 1);
    expect(r.hud.opacityOf('resourceLedger')).toBe(HUD_ACTIVE);
    r.frame(1);
    expect(r.hud.opacityOf('resourceLedger')).toBe(HUD_REST);
    expect(r.hud.cell('resourceLedger').hasAttribute('data-hud-state')).toBe(false);

    r.focus.mode = 'engaging';
    r.frame();
    for (const id of HUD_REGION_IDS) expect(r.hud.opacityOf(id), id).toBe(HUD_REST);
    r.focus.mode = 'locked';
    r.frame();
    expect(r.hud.element.getAttribute('data-focus')).toBe('locked');
    for (const id of HUD_REGION_IDS) expect(r.hud.opacityOf(id), id).toBe(id === 'alertStack' ? HUD_ACTIVE : HUD_FOCUSED);
    r.focus.mode = 'releasing';
    r.frame();
    expect(r.hud.element.hasAttribute('data-focus')).toBe(false);
    for (const id of HUD_REGION_IDS) expect(r.hud.opacityOf(id), id).toBe(HUD_REST);
    expect(r.sounds.calls.filter((c) => c === 'focusEngage')).toHaveLength(1);
    expect(r.sounds.calls.filter((c) => c === 'focusRelease')).toHaveLength(1);
  });

  it('derezz hide: hidden from the pre-roll to the tombstone across the full sequence', () => {
    const r = rig();
    r.frame();
    expect(r.hud.hidden).toBe(false);
    expect(r.hud.element.hidden).toBe(false);
    const { preRoll, tombstone } = DEREZZ_TIMING.convoy;
    expect(tombstone).toBe(3900);
    r.hud.derezz.begin();
    r.frame();
    let elapsed = -preRoll;
    while (elapsed < tombstone) {
      r.runStore.mutate((s) => {
        s.legProgress += 0.001;
      });
      r.frame(50);
      elapsed += 50;
      expect(r.hud.hidden, `${elapsed} ms`).toBe(true);
      expect(r.hud.element.hidden, `${elapsed} ms`).toBe(true);
      for (const id of HUD_REGION_IDS) expect(r.hud.opacityOf(id)).toBe(0);
    }
    r.hud.derezz.tombstone();
    r.frame();
    expect(r.hud.hidden).toBe(false);
    expect(r.hud.element.hidden).toBe(false);
    expect(HUD_CSS).toContain('.kt-hud[hidden] { display: none; }');
  });

  it('no position animation: no transform, translate, left, top or right in any transition or animation declaration', () => {
    const declarations = [...HUD_CSS.matchAll(/(?:transition|animation)(?:-property)?\s*:\s*([^;]+);/g)].map((m) => m[1] ?? '');
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) expect(d, d).not.toMatch(/\b(transform|translate|left|top|right)\b/);
    expect(HUD_CSS).not.toMatch(/@keyframes/);
    expect(reportOffences(scanFiles(HUD_FILES, /\.style\.(transition|animation|left|top|right|transform)\b|style\.setProperty\(['"](transition|animation|left|top|right|transform)/, 'imports'))).toBe('');
  });

  it('no modals: no role="dialog" and nothing that traps focus', () => {
    const r = rig();
    r.frame();
    expect(document.querySelectorAll('[role="dialog"], [aria-modal]')).toHaveLength(0);
    expect(reportOffences(scanFiles(collectSources(UI_ROOT), /['"]dialog['"]|aria-modal|\binert\b|trapFocus|focusTrap|\.focus\(\)/, 'imports'))).toBe('');
    expect(reportOffences(scanFiles(collectSources(UI_ROOT), /\bkeydown\b[^)]*Tab\b/, 'imports'))).toBe('');
  });

  it('alerts: at most 3 concurrent, at most 64 characters, every one names a structure, auto-dismissing', () => {
    const r = rig();
    const events: KernelEvent[] = [
      { type: 'process.starving', tick: tick(1), seq: 1, pid: pid(4), waitedTicks: 118, fatal: false },
      { type: 'process.starving', tick: tick(1), seq: 2, pid: pid(99), waitedTicks: 130, fatal: true },
      { type: 'memory.thrashing', tick: tick(2), seq: 3, faultRate: 91, severity: 'critical' },
      { type: 'deadlock.detected', tick: tick(3), seq: 4, report: {} as never },
      { type: 'kernel.panic', tick: tick(4), seq: 5, message: 'x'.repeat(200) },
    ];
    for (const e of events) r.hud.consume(e);
    r.frame();
    const shown = r.hud.alerts;
    expect(shown).toHaveLength(HUD_ALERT_MAX);
    expect(HUD_ALERT_MAX).toBe(3);
    expect(r.hud.cell('alertStack').querySelectorAll('.kt-alert')).toHaveLength(3);
    const names: readonly string[] = [...HUD_STRUCTURE_NAMES, HUD_KERNEL_NAME];
    for (const a of shown) {
      expect(a.text.length, a.text).toBeLessThanOrEqual(HUD_ALERT_MAX_CHARS);
      expect(names.some((n) => a.text.endsWith(` at ${n}`)), a.text).toBe(true);
    }
    expect(shown[2]?.text).toMatch(/^& x+ at Kernel$/);
    expect(shown[2]?.text).toHaveLength(64);
    expect(shown.map((a) => a.severity)).toEqual(['fatal', 'fatal', 'fatal']);
    // The oldest two were dropped; a non-convoy process is never named.
    expect(shown[0]?.text).toContain('thrashing');
    const all = events.map((e) => {
      r.hud.consume(e);
      return r.hud.alerts.map((a) => a.text);
    });
    expect(all.flat().join('\n')).not.toContain('99');
    expect(all.flat().join('\n')).toContain('a process starving');
    expect(all.flat().join('\n')).toContain('SABLE starving 118 ticks at ReadyQueueProcession');
    // Severity to palette.
    expect(ALERT_STYLE.info.hex).toBe(CYAN.core);
    expect(ALERT_STYLE.warning.hex).toBe(AMBER.core);
    expect(ALERT_STYLE.fatal.hex).toBe(AMBER.white);
    r.frame();
    const lines = r.hud.cell('alertStack').querySelectorAll<HTMLElement>('.kt-alert');
    expect(lines[2]?.style.color).toBe(cssColor(AMBER.white));
    // A new line plays the cue; a repeat does not.
    const cues = r.sounds.calls.filter((c) => c === 'alertAppear').length;
    r.hud.consume(events[4] as KernelEvent);
    expect(r.sounds.calls.filter((c) => c === 'alertAppear')).toHaveLength(cues);
    // Auto-dismiss.
    r.frame(HUD_ALERT_TTL_MS);
    expect(r.hud.alerts).toHaveLength(0);
    expect(r.hud.cell('alertStack').querySelectorAll('.kt-alert')).toHaveLength(0);
  });

  it('structure names match the world registry so the alert vocabulary cannot drift', () => {
    expect([...HUD_STRUCTURE_NAMES]).toEqual([...STRUCTURE_NAMES]);
  });

  it('contrast: every HUD text token at 0.72 over the void is at least 4.5:1, and the 2.6 table reproduces at alpha 1', () => {
    const measured: string[] = [];
    for (const [name, hex] of Object.entries(HUD_TEXT_TOKENS)) {
      const ratio = contrastRatio(hex, VOID.base, HUD_REST);
      measured.push(`${name} ${ratio.toFixed(2)}:1`);
      expect(ratio, `${name} at ${HUD_REST}`).toBeGreaterThanOrEqual(4.5);
      const row = TEXT_CONTRAST.find((t) => t.hex === hex);
      expect(row?.permitted, name).toBe('any-size');
    }
    console.log(`HUD text contrast at opacity ${HUD_REST}: ${measured.join(', ')}`);
    for (const row of TEXT_CONTRAST) {
      expect(Math.abs(contrastRatio(row.hex, VOID.base, 1) - row.ratio), row.hex.toString(16)).toBeLessThan(0.1);
    }
    expect(contrastRatio(VOID.base, VOID.base, 1)).toBe(1);
    for (const line of HUD_CSS.split('\n')) {
      if (/^\s*color:/.test(line)) expect(line).toMatch(/var\(--slate-primary\)|currentColor|rgba\(/);
    }
  });

  it('dom batch: 1,000 updates make one DOM batch per frame and never read layout after a write', () => {
    const log: string[] = [];
    class ProbeBatch extends DomBatch {
      override flush(): void {
        log.push('flush-start');
        super.flush();
        log.push('flush-end');
      }
    }
    const batch = new ProbeBatch();
    const r = rig(worstCaseRun(), worstCaseTelemetry(), batch);
    r.frame();
    log.length = 0;
    const probeEl = r.hud.cell('resourceLedger');
    const findDescriptor = (target: object, key: string): { proto: object; desc: PropertyDescriptor } | null => {
      let proto: object | null = target;
      while (proto !== null) {
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (desc !== undefined) return { proto, desc };
        proto = Object.getPrototypeOf(proto);
      }
      return null;
    };
    const restore: (() => void)[] = [];
    const instrument = (target: object, key: string, kind: 'read' | 'write'): void => {
      const found = findDescriptor(target, key);
      if (found === null) throw new Error(`no descriptor for ${key}`);
      const { proto, desc } = found;
      const patched: PropertyDescriptor = { ...desc };
      if (desc.get !== undefined) {
        const original = desc.get;
        patched.get = function (this: unknown) {
          log.push(kind);
          return original.call(this);
        };
      }
      if (desc.set !== undefined) {
        const original = desc.set;
        patched.set = function (this: unknown, v: unknown) {
          log.push(kind);
          original.call(this, v);
        };
      }
      if (typeof desc.value === 'function') {
        const original = desc.value as (...args: unknown[]) => unknown;
        patched.value = function (this: unknown, ...args: unknown[]) {
          log.push(kind);
          return original.apply(this, args);
        };
      }
      Object.defineProperty(proto, key, patched);
      restore.push(() => Object.defineProperty(proto, key, desc));
    };
    instrument(probeEl, 'offsetWidth', 'read');
    instrument(probeEl, 'getBoundingClientRect', 'read');
    instrument(probeEl, 'textContent', 'write');
    instrument(probeEl.style, 'setProperty', 'write');
    try {
      const frames = 10;
      const flushesBefore = batch.stats.flushes;
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < 100; i++) {
          r.runStore.mutate((s) => {
            s.resources.cycles -= 1;
            const m = s.convoy[i % 5];
            if (m !== undefined) m.integrity = Math.max(0, m.integrity - 0.1);
          });
          r.telemetry.mutate((t) => {
            t.tick += 1;
            t.cpuUtilisation = ((f * 100 + i) % 50) / 50;
          });
        }
        r.frame();
      }
      expect(batch.stats.flushes - flushesBefore).toBe(frames);
      const writes = log.filter((e) => e === 'write').length;
      expect(writes).toBeGreaterThan(frames);
      expect(log.filter((e) => e === 'read')).toHaveLength(0);
      let open = false;
      for (const entry of log) {
        if (entry === 'flush-start') open = true;
        else if (entry === 'flush-end') open = false;
        else expect(open, 'a DOM write outside the batch flush').toBe(true);
      }
    } finally {
      for (const u of restore) u();
    }
  });

  it('pointer through: the container is pointer-events none and its children are auto', () => {
    const r = rig();
    expect(r.hud.element.style.pointerEvents).toBe('none');
    for (const id of HUD_REGION_IDS) expect(r.hud.cell(id).style.pointerEvents, id).toBe('auto');
    expect(HUD_CSS).toMatch(/\.kt-hud \{[^}]*pointer-events: none;/);
    expect(HUD_CSS).toContain('.kt-hud > * { pointer-events: auto; }');
  });

  it('boundaries: the HUD holds no three import, no colour literal, and imports the other layers as types only', () => {
    expect(reportOffences(scanFiles(HUD_FILES, /\bfrom\s*['"]three/, 'imports'))).toBe('');
    expect(reportOffences(scanFiles(HUD_FILES, /#[0-9a-fA-F]{3,8}\b|\b0x[0-9a-fA-F]{6}\b/, 'imports'))).toBe('');
    expect(reportOffences(scanFiles(HUD_FILES, /^\s*import\s+(?!type\s)[^;]*?\bfrom\s*['"](?:@kernel|@game|@world|@audio|@render)\b/, 'imports'))).toBe('');
    expect(reportOffences(scanFiles(HUD_FILES, /^\s*import\s+(?!type\s)[^;]*?\bfrom\s*['"](?!@design\b|\.)/, 'imports'))).toBe('');
  });

  it('tick counter cost: the per-tick readout updates a CSS custom property, not a text node', () => {
    const r = rig();
    r.frame();
    const tickEl = r.hud.cell('policyChips').querySelector<HTMLElement>('.kt-tick');
    expect(tickEl).not.toBeNull();
    expect(tickEl?.style.getPropertyValue('--kt-tick')).toBe('4980');
    expect(tickEl?.textContent).toBe('');
    r.telemetry.mutate((t) => {
      t.tick = 4981;
    });
    r.frame();
    expect(tickEl?.style.getPropertyValue('--kt-tick')).toBe('4981');
    expect(tickEl?.textContent).toBe('');
    expect(r.hud.opacityOf('policyChips')).toBe(HUD_REST);
    expect(HUD_CSS).toContain(".kt-tick::after { counter-reset: kt-tick var(--kt-tick, 0); content: 't' counter(kt-tick); }");
    expect(HUD_CSS).toContain("@property --kt-tick { syntax: '<integer>'; inherits: true; initial-value: 0; }");
  });

  it('unlocks the audio surface from the first pointer or key handler, once', () => {
    const r = rig();
    r.hud.cell('legRail').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    r.hud.cell('legRail').dispatchEvent(new Event('keydown', { bubbles: true }));
    expect(r.sounds.calls.filter((c) => c === 'unlock')).toHaveLength(1);
  });
});
