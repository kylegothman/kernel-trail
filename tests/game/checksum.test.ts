/**
 * The checksum and its canonicalisation, WP-17 acceptance 24, 25 and 28.
 */
import { describe, expect, it } from 'vitest';
import { canonical } from '../kernel/canonical';
import { CHECKSUM_SALT, buildSaveFile, canonicalise, checksumOf, fnv1a64, verify } from '../../src/game/save';
import type { SaveFile } from '../../src/game/types';
import { worstCaseRun } from '../ui/fixtures';

function file(): SaveFile {
  return buildSaveFile({ run: worstCaseRun(), kernel: null, rngStates: [], savedAtIso: '2026-09-15T12:00:00.000Z' });
}

describe('canonicalise', () => {
  it('canonical: key order is irrelevant, -0 normalises, non-finite numbers and Map or Set are rejected', () => {
    const a = { z: 1, a: { d: [1, 2, { y: 2, x: 1 }], c: 'text' }, m: true, n: null };
    const b = { n: null, m: true, a: { c: 'text', d: [1, 2, { x: 1, y: 2 }] }, z: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(canonicalise({ v: -0 })).toBe('{"v":0}');
    expect(canonicalise({ v: 0 })).toBe(canonicalise({ v: -0 }));
    expect(canonicalise({ v: 1, u: undefined })).toBe('{"v":1}');
    expect(() => canonicalise({ v: Number.NaN })).toThrow(/Non-finite/);
    expect(() => canonicalise({ v: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
    expect(() => canonicalise(new Map([['a', 1]]))).toThrow(/Map\/Set/);
    expect(() => canonicalise(new Set([1]))).toThrow(/Map\/Set/);
    expect(() => canonicalise({ f: () => 1 })).toThrow(/Unserialisable/);
  });

  it('format: 16 lowercase hex characters, changed by any covered field, unchanged by key order and by savedAtIso', () => {
    const f = file();
    expect(f.checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(verify(f)).toBe(true);
    const reordered: SaveFile = { checksum: f.checksum, rngStates: f.rngStates, kernel: f.kernel, run: { ...f.run }, savedAtIso: f.savedAtIso, version: f.version };
    expect(checksumOf(reordered)).toBe(f.checksum);
    expect(checksumOf({ ...f, savedAtIso: '1999-01-01T00:00:00.000Z' })).toBe(f.checksum);
    const covered: (() => SaveFile)[] = [
      () => ({ ...f, run: { ...f.run, legIndex: f.run.legIndex + 1 } }),
      () => ({ ...f, run: { ...f.run, resources: { ...f.run.resources, cycles: f.run.resources.cycles + 1 } } }),
      () => ({ ...f, run: { ...f.run, score: { ...f.run.score, total: 999 } } }),
      () => ({ ...f, rngStates: [{ algorithm: 'sfc32', words: [1, 2, 3, 4], label: 'root' }] }),
    ];
    for (const change of covered) expect(checksumOf(change())).not.toBe(f.checksum);
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
    // Reference FNV-1a 64 over UTF-8 bytes, in BigInt, cross-checks the split arithmetic.
    const reference = (s: string): string => {
      let h = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(s)) {
        h ^= BigInt(byte);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return h.toString(16).padStart(16, '0');
    };
    for (const s of ['', 'a', 'foobar', 'KERNEL TRAIL', canonicalise(f), 'caf\u00e9 \u20ac \ud83d\ude80', 'x'.repeat(5000)]) {
      expect(fnv1a64(s), JSON.stringify(s.slice(0, 20))).toBe(reference(s));
    }
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('known vectors: the standard FNV-1a 64 test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('tamper detected: a hand-edited score fails verification', () => {
    const f = file();
    const edited: SaveFile = { ...f, run: { ...f.run, score: { ...f.run.score, total: f.run.score.total + 5000 } } };
    expect(verify(edited)).toBe(false);
    const resources: SaveFile = { ...f, run: { ...f.run, resources: { ...f.run.resources, cycles: 99_999 } } };
    expect(verify(resources)).toBe(false);
  });

  it('build id salt: the same state under two build ids gives two checksums', () => {
    const f = file();
    const a = checksumOf(f, 'build-a');
    const b = checksumOf(f, 'build-b');
    expect(a).not.toBe(b);
    expect(checksumOf(f, CHECKSUM_SALT)).toBe(f.checksum);
    expect(CHECKSUM_SALT).toBe('dev');
  });

  it('consistent with kernel canonical: both encoders agree on a shared fixture with no Map or Set', () => {
    const run = worstCaseRun();
    const fixture = {
      run,
      nested: { z: [3, 2, 1, { b: 'x', a: -0 }], a: 'first', empty: {}, list: [] },
      omitted: undefined,
      text: 'quote " and \\ backslash',
      number: 1e21,
    };
    expect(canonicalise(fixture)).toBe(canonical(fixture));
    expect(canonicalise(run)).toBe(canonical(run));
  });
});
