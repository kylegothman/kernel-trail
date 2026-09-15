/**
 * Lower centre band: the alert stack. At most three concurrent, at most 64
 * characters each, auto-dismissing, every alert naming the structure it
 * refers to so the player knows where in the world to look. Visual bible
 * 11.1 and 11.4; the structure vocabulary is pre-flight ruling 6.8.
 *
 * Alerts are derived from `KernelEvent` and nothing else. A non-convoy
 * process is never named, because per-process detail beyond the five
 * Programs is on the list of things the HUD must never carry (11.2).
 */
import type { KernelEvent, Pid } from '@kernel/types';
import { cssColor } from '@design';
import { HUD_ALERT_MAX, HUD_ALERT_MAX_CHARS, HUD_ALERT_TTL_MS } from '../layout';
import { HUD_KERNEL_NAME, type AlertStructure } from '../structures';
import { ALERT_STYLE } from '../hud.css';
import { el, setText, type HudRegion } from '../dom';

export type AlertSeverity = keyof typeof ALERT_STYLE;

export interface HudAlert {
  readonly severity: AlertSeverity;
  /** The full line, glyph prefix included, at most HUD_ALERT_MAX_CHARS. */
  readonly text: string;
  readonly structure: AlertStructure;
  readonly createdAtMs: number;
}

export interface AlertStackProps {
  readonly alerts: readonly HudAlert[];
}

/** Maps a pid to a convoy Program's display name, or null for any other process. */
export type ProgramNameOf = (pid: Pid) => string | null;

interface Derived {
  readonly severity: AlertSeverity;
  readonly message: string;
  readonly structure: AlertStructure;
}

function severityOf(level: 'warning' | 'critical'): AlertSeverity {
  return level === 'critical' ? 'fatal' : 'warning';
}

/** The event to alert table. Everything not listed is silent on the HUD. */
export function deriveAlert(e: KernelEvent, nameOf: ProgramNameOf): Derived | null {
  switch (e.type) {
    case 'process.starving': {
      const name = nameOf(e.pid) ?? 'a process';
      return { severity: e.fatal ? 'fatal' : 'warning', message: `${name} starving ${e.waitedTicks} ticks`, structure: 'ReadyQueueProcession' };
    }
    case 'process.exited': {
      const name = nameOf(e.pid);
      if (name === null || e.reason === 'normal_exit') return null;
      return { severity: 'fatal', message: `${name} derezzed, ${e.reason}`, structure: 'ReadyQueueProcession' };
    }
    case 'memory.thrashing':
      return { severity: severityOf(e.severity), message: `thrashing, fault rate ${Math.round(e.faultRate)}`, structure: 'PageOcean' };
    case 'memory.allocation_failed':
      return { severity: 'warning', message: `allocation failed, ${e.reason}`, structure: 'FrameVault' };
    case 'deadlock.detected':
      return { severity: 'fatal', message: 'deadlock detected', structure: 'WaitForRing' };
    case 'deadlock.resolved':
      return { severity: 'info', message: `deadlock resolved by ${e.method}`, structure: 'WaitForRing' };
    case 'sync.race_detected':
      return { severity: 'warning', message: 'race detected', structure: 'WaitForRing' };
    case 'raid.rebuild':
      return { severity: 'info', message: `raid ${e.level} rebuild ${Math.round(e.progress * 100)}%`, structure: 'PlatterStack' };
    case 'fs.corruption':
      return e.recoverable
        ? { severity: 'warning', message: 'corruption, recoverable', structure: 'ArchiveShelves' }
        : { severity: 'fatal', message: 'corruption, unrecoverable', structure: 'ArchiveShelves' };
    case 'fs.recovered':
      return { severity: 'info', message: e.fromJournal ? 'recovered from journal' : 'recovered', structure: 'ArchiveShelves' };
    case 'security.access_denied':
      return { severity: 'warning', message: `access denied, ${e.right}`, structure: 'DomainRings' };
    case 'security.escalation_attempt':
      // Appendix A: an unblocked escalation opens silently.
      return e.blocked ? { severity: 'warning', message: 'escalation blocked', structure: 'DomainRings' } : null;
    case 'kernel.panic':
      return { severity: 'fatal', message: e.message, structure: HUD_KERNEL_NAME };
    default:
      return null;
  }
}

/** Compose the line: glyph, message, structure; the message is cut to fit the cap. */
export function composeAlert(d: Derived, createdAtMs: number): HudAlert {
  const glyph = ALERT_STYLE[d.severity].glyph;
  const suffix = ` at ${d.structure}`;
  const room = HUD_ALERT_MAX_CHARS - glyph.length - 1 - suffix.length;
  const message = d.message.length > room ? d.message.slice(0, Math.max(0, room)) : d.message;
  return { severity: d.severity, text: `${glyph} ${message}${suffix}`, structure: d.structure, createdAtMs };
}

/** The bounded, auto-dismissing model behind the region. */
export class AlertModel {
  private readonly items: HudAlert[] = [];

  get alerts(): readonly HudAlert[] {
    return this.items;
  }

  /** Returns true when a new line appeared (a repeat only refreshes its timestamp). */
  push(alert: HudAlert): boolean {
    const i = this.items.findIndex((a) => a.text === alert.text);
    if (i >= 0) {
      this.items[i] = alert;
      return false;
    }
    this.items.push(alert);
    while (this.items.length > HUD_ALERT_MAX) this.items.shift();
    return true;
  }

  /** Drop expired alerts. Returns true when anything changed. */
  expire(nowMs: number): boolean {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const a = this.items[i];
      if (a !== undefined && nowMs - a.createdAtMs >= HUD_ALERT_TTL_MS) this.items.splice(i, 1);
    }
    return this.items.length !== before;
  }

  clear(): void {
    this.items.length = 0;
  }
}

export function createAlertStack(doc: Document): HudRegion<AlertStackProps> {
  const root = el(doc, 'div', 'kt-cell kt-alerts');
  const lines: HTMLElement[] = [];
  return {
    el: root,
    update(p) {
      let changed = false;
      while (lines.length < p.alerts.length) {
        const line = el(doc, 'div', 'kt-alert');
        root.append(line);
        lines.push(line);
        changed = true;
      }
      while (lines.length > p.alerts.length) {
        lines.pop()?.remove();
        changed = true;
      }
      p.alerts.forEach((a, i) => {
        const line = lines[i];
        if (line === undefined) return;
        changed = setText(line, a.text) || changed;
        const colour = cssColor(ALERT_STYLE[a.severity].hex);
        if (line.style.color !== colour) line.style.color = colour;
      });
      return changed;
    },
    dispose: () => root.remove(),
  };
}
