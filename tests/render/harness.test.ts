import { expect, it } from 'vitest';
import { probeSettled, formatPageDiagnostics } from './gpu/harness';
import { instrumentAllocations } from './gpu/allocationProbe';

it('readiness ignores DOM named properties and incomplete APIs', () => {
  expect(probeSettled({ tagName: 'CANVAS', id: 'probe' })).toBe(false);
  expect(probeSettled({ status: 'booting' })).toBe(false);
  expect(probeSettled({ status: 'ready', api: { info: 'not callable' } })).toBe(false);
  expect(probeSettled({ status: 'ready', api: { info() {} } })).toBe(true);
  expect(probeSettled({ status: 'failed', error: { message: 'shader' } })).toBe(true);
});

it('failure diagnostics retain every console severity and the first pageerror stack', () => {
  const first = new Error('shader initialization'); first.stack = 'Error: shader initialization\n    at initializeProbe (probe.gpu.ts:12:3)';
  const second = new Error('later failure');
  const messages = ['[console.debug] boot', '[console.warning] adapter', '[console.error] shader'];
  const report = formatPageDiagnostics({ messages, pageErrors: [first, second] });
  for (const message of messages) expect(report).toContain(message);
  expect(report).toContain(first.stack);
  expect(report.indexOf('at initializeProbe')).toBeLessThan(report.indexOf('later failure'));
  expect(formatPageDiagnostics({ messages: [], pageErrors: [] })).toContain('no pageerror event received');
});

it('allocation transform preserves source lines and maps constructor insertions', () => {
  const code = 'class Vector3 {\n  constructor() { this.x = 0; }\n}\n';
  const result = instrumentAllocations(code, '/node_modules/three/src/math/Vector3.js');
  expect(result).not.toBeNull();
  expect(result!.code).toContain("constructor() {globalThis.__ktAlloc?.('Vector3'); this.x");
  expect(result!.map.sourcesContent).toEqual([code]);
  expect(result!.map.mappings.split(';')).toHaveLength(code.split('\n').length);
  expect(result!.map.mappings.split(';')[1]?.split(',')).toHaveLength(3);
  expect(instrumentAllocations(code, '/application/Vector3.js')).toBeNull();
  expect(instrumentAllocations('export const value = 1;', '/node_modules/three/src/other.js')).toBeNull();
});
