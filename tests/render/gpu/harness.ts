import type { Page } from 'playwright';

export interface ProbeBootState {
  status: 'booting' | 'ready' | 'failed';
  api?: { info: () => unknown };
  error?: { message: string; stack: string };
}

/** Serialized into the page by Playwright; deliberately has no module dependencies. */
export function probeSettled(value: unknown = (globalThis as typeof globalThis & {
  __kernelTrailProbe?: ProbeBootState;
}).__kernelTrailProbe): boolean {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false;
  if (value.status === 'failed') return true;
  return value.status === 'ready' && 'api' in value && typeof value.api === 'object' &&
    value.api !== null && 'info' in value.api && typeof value.api.info === 'function';
}

export interface PageDiagnostics {
  messages: string[];
  pageErrors: Error[];
  firstPageError: Promise<Error>;
}

/** Install before navigation, including debug/info/warnings and failed requests. */
export function capturePageDiagnostics(page: Page): PageDiagnostics {
  let firstError: (error: Error) => void = () => {};
  const diagnostics: PageDiagnostics = {
    messages: [], pageErrors: [],
    firstPageError: new Promise(resolve => { firstError = resolve; }),
  };
  page.on('console', message => {
    const location = message.location();
    if(message.text().startsWith('[WebGPU device')) console.log(message.text());
    diagnostics.messages.push(`[console.${message.type()}] ${message.text()}\n` +
      `  ${location.url}:${location.lineNumber}:${location.columnNumber}`);
  });
  page.on('pageerror', error => {
    diagnostics.pageErrors.push(error);
    if (diagnostics.pageErrors.length === 1) firstError(error);
  });
  page.on('requestfailed', request => {
    diagnostics.messages.push(`[requestfailed] ${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) diagnostics.messages.push(`[http ${response.status()}] ${response.url()}`);
  });
  return diagnostics;
}

export function formatPageDiagnostics(diagnostics: Pick<PageDiagnostics, 'messages' | 'pageErrors'>): string {
  const first = diagnostics.pageErrors[0];
  return [
    '--- Captured page messages ---',
    ...diagnostics.messages,
    diagnostics.messages.length ? '--- End page messages ---' : '(none)',
    '--- First pageerror and stack ---',
    first ? first.stack || `${first.name}: ${first.message}` : '(no pageerror event received)',
    ...diagnostics.pageErrors.slice(1).map(error => `Additional pageerror:\n${error.stack || `${error.name}: ${error.message}`}`),
  ].join('\n');
}

export async function navigateAndWaitForProbe(page: Page, url: string, diagnostics: PageDiagnostics): Promise<void> {
  await Promise.race([
    (async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(probeSettled, undefined, { timeout: 60_000 });
      const failure = await page.evaluate(() => {
        const state = (globalThis as typeof globalThis & { __kernelTrailProbe?: ProbeBootState }).__kernelTrailProbe;
        return state?.status === 'failed' ? state.error : null;
      });
      if (failure) throw new Error(`Probe initialization failed: ${failure.message}\n${failure.stack}`);
    })(),
    diagnostics.firstPageError.then(error => { throw error; }),
  ]);
}
