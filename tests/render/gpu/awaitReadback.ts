/**
 * WP-23 section 2: the runner appends `scale=4` to every fixture URL under
 * --ci, and every in-page deadline multiplies by it, so a software rasteriser
 * gets four times as long to reach the same state. Nothing asserted changes.
 */
export function fixtureTimeScale(): number {
  // The Node suite exercises awaitReadback with no window; the scale is a browser-only knob.
  if (typeof location === 'undefined') return 1;
  const raw = new URLSearchParams(location.search).get('scale');
  const scale = raw === null ? 1 : Number(raw);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Service GPU completion callbacks without advancing the fixture's simulation. */
export async function awaitReadback<T>(
  readback: Promise<T>, clock: { step(ms: number): void },
): Promise<T> {
  let settled = false;
  // Observe both outcomes immediately. Return the original promise below so a
  // rejection without a reason, as in Three's WebGL fence poll, stays a failure.
  void readback.then(() => { settled = true; }, () => { settled = true; });
  const budgetMs = 10_000 * fixtureTimeScale();
  const deadline = Date.now() + budgetMs;
  await Promise.resolve();
  while (!settled) {
    if (Date.now() >= deadline) throw new Error(`GPU readback did not settle within ${budgetMs}ms (scale ${fixtureTimeScale()})`);
    // WebGL2 polls clientWaitSync through RAF. Awaiting without servicing the
    // controlled RAF queue would deadlock; a zero-time frame cannot tick the run.
    clock.step(0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return readback;
}
