/** Service GPU completion callbacks without advancing the fixture's simulation. */
export async function awaitReadback<T>(
  readback: Promise<T>, clock: { step(ms: number): void },
): Promise<T> {
  let settled = false;
  // Observe both outcomes immediately. Return the original promise below so a
  // rejection without a reason, as in Three's WebGL fence poll, stays a failure.
  void readback.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 10_000;
  await Promise.resolve();
  while (!settled) {
    if (Date.now() >= deadline) throw new Error('GPU readback did not settle within 10000ms');
    // WebGL2 polls clientWaitSync through RAF. Awaiting without servicing the
    // controlled RAF queue would deadlock; a zero-time frame cannot tick the run.
    clock.step(0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return readback;
}
