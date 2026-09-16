/**
 * WP-17 browser probe, run by tests/render/gpu/run.mjs under Playwright at
 * 1440 by 900: the HUD mounted with the worst-case fixture (five Programs
 * alive, four non-zero resources, three alerts, the longest policy names),
 * every element's bounding box read, the union over the viewport asserted
 * under 11 percent, and every box at least max(24, 0.025 * 900) px from each
 * edge. Visual bible 11.3; acceptance 6 and 7.
 */
import { createRunStore, createTelemetryStore } from '../../../src/game/runStore';
import { Hud } from '../../../src/ui/hud/Hud';
import { HUD_COVERAGE_CAP, hudSafeInsetPx } from '../../../src/ui/hud/layout';
import { focusStateOf, worstCaseAlertEvents, worstCaseRun, worstCaseTelemetry } from '../../ui/fixtures';

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Exact union area by coordinate compression; the boxes may overlap. */
function unionArea(boxes: readonly Box[]): number {
  const xs = [...new Set(boxes.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap((b) => [b.y0, b.y1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = ((xs[i] ?? 0) + (xs[i + 1] ?? 0)) / 2;
      const cy = ((ys[j] ?? 0) + (ys[j + 1] ?? 0)) / 2;
      if (boxes.some((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1)) {
        area += ((xs[i + 1] ?? 0) - (xs[i] ?? 0)) * ((ys[j + 1] ?? 0) - (ys[j] ?? 0));
      }
    }
  }
  return area;
}

function initialize(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (app === null) throw new Error('HUD probe mount missing');
  const runStore = createRunStore(worstCaseRun());
  const telemetry = createTelemetryStore(worstCaseTelemetry());
  const hud = new Hud({
    root: app,
    runStore,
    telemetry,
    clock: () => performance.now(),
    focusState: () => focusStateOf('free'),
  });
  for (const e of worstCaseAlertEvents()) hud.consume(e);
  hud.setHover('FrameVault');
  hud.frame(performance.now());
  hud.flush();

  const api = {
    info: () => ({ regions: hud.element.children.length, alerts: hud.alerts.length }),
    run: async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
        setTimeout(resolve, 200);
      });
      const width = window.innerWidth;
      const height = window.innerHeight;
      const safe = hudSafeInsetPx(height);
      const boxes: Box[] = [];
      const elements: { className: string; box: Box }[] = [];
      const violations: { className: string; box: Box }[] = [];
      for (const el of hud.element.querySelectorAll<HTMLElement>('*')) {
        if (el.tagName === 'STYLE') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const box = { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
        boxes.push(box);
        if (el.parentElement === hud.element) elements.push({ className: el.className, box });
        if (r.left < safe || r.top < safe || width - r.right < safe || height - r.bottom < safe) {
          violations.push({ className: el.className, box });
        }
      }
      const area = unionArea(boxes);
      const coverage = area / (width * height);
      const restOpacity = Number.parseFloat(getComputedStyle(hud.cell('legRail')).opacity);
      const result = { width, height, safe, coverage, percent: `${(coverage * 100).toFixed(2)}%`, restOpacity, elements, safeAreaViolations: violations };
      if (coverage >= HUD_COVERAGE_CAP) throw new Error(`HUD coverage ${result.percent} of ${width}x${height} exceeds ${HUD_COVERAGE_CAP * 100}%`);
      if (violations.length > 0) throw new Error(`HUD elements inside the ${safe}px safe area: ${JSON.stringify(violations)}`);
      return result;
    },
    dispose: () => hud.dispose(),
  };
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'ready', api } });
}

Object.assign(globalThis, { __kernelTrailProbe: { status: 'booting' } });
try {
  initialize();
} catch (cause: unknown) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'failed', error: { message: error.message, stack: error.stack ?? error.message } } });
  console.error('HUD probe initialization failed:', error.stack ?? error.message);
}
