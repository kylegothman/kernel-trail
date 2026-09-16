/** WP-15: the strict line parser (spec 3). Parse errors are values with positions; nothing throws. */
import { describe, expect, it } from 'vitest';
import { bindFlags, classify, parse, parseInteger, parseNumber } from '@terminal/parser';

function line(input: string) {
  const result = parse(input);
  if (!result.ok || result.line === null) throw new Error(`expected a parsed line for ${JSON.stringify(input)}`);
  return result.line;
}

describe('parser', () => {
  it('bare command', () => {
    expect(line('ps')).toMatchObject({ command: 'ps', argv: [] });
    expect(line('  ps  ')).toMatchObject({ command: 'ps', argv: [], positional: [], flags: [] });
  });

  it('arguments', () => {
    expect(line('kill 7')).toMatchObject({ command: 'kill', argv: ['7'], positional: ['7'] });
    expect(line('kill 7').argv[0]).toBeTypeOf('string');
  });

  it('quotes', () => {
    expect(line("exec 'a  b'").positional).toEqual(['a  b']);
    expect(line('exec "a  b" c').positional).toEqual(['a  b', 'c']);
    expect(line('exec "--not-a-flag"').flags).toEqual([]);
    expect(line('exec "a $b *"').positional).toEqual(['a $b *']);
    const open = parse("exec 'unterminated");
    expect(open.ok).toBe(false);
    if (!open.ok) { expect(open.position).toBe(5); expect(open.unsupported).toBe('unterminated quote'); }
  });

  it('long flags', () => {
    const parsed = line('mode --history');
    expect(parsed.flags).toEqual(['history']);
    expect(parsed.positional).toEqual([]);
    expect(parsed.argv).toEqual(['--history']);
    expect(line('sched --policy rr').flags).toEqual(['policy']);
    expect(line('sched --policy rr').positional).toEqual(['rr']);
    expect(classify('--policy=rr')).toEqual({ kind: 'flag', name: 'policy', value: 'rr' });
  });

  it('short flags', () => {
    expect(line('ps -a').flags).toEqual(['a']);
    expect(line('nice -12').flags).toEqual([]);
    expect(line('nice -12').positional).toEqual(['-12']);
    expect(line('seek -').positional).toEqual(['-']);
  });

  it('double dash', () => {
    const parsed = line('kill -- -a -b');
    expect(parsed.flags).toEqual([]);
    expect(parsed.positional).toEqual(['-a', '-b']);
    expect(parsed.argv).toEqual(['--', '-a', '-b']);
  });

  it('unsupported', () => {
    const cases: readonly [string, string][] = [
      ['ps | grep x', 'pipes'], ['ps > out', 'redirection'], ['ps < in', 'redirection'], ['ls *', 'globbing'],
      ['echo $VAR', 'variable expansion'], ['echo `ps`', 'subshells'], ['echo $(ps)', 'variable expansion'],
      ['ps; top', 'command chaining'], ['ps && top', 'command chaining'],
    ];
    for (const [input, feature] of cases) {
      const result = parse(input);
      expect(result.ok, input).toBe(false);
      if (result.ok) continue;
      expect(result.unsupported, input).toBe(feature);
      expect(result.message, input).toContain(feature);
      expect(result.message, input).toMatch(/See man man\.$/);
    }
  });

  it('error position', () => {
    const result = parse('ps -l | top');
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.position).toBe(6); expect(result.message).toContain('position 6'); }
    const later = parse('kill 7 ; wait');
    if (!later.ok) expect(later.position).toBe(7);
  });

  it('empty input', () => {
    expect(parse('')).toEqual({ ok: true, line: null });
    expect(parse('   \t ')).toEqual({ ok: true, line: null });
  });
});

describe('bindFlags', () => {
  it('pairs each flag with the values the command declares', () => {
    const bound = bindFlags(['--policy', 'rr', '--quantum', '4', 'extra'], { policy: 1, quantum: 1 });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.args.value('policy')).toBe('rr');
    expect(bound.args.value('quantum')).toBe('4');
    expect(bound.args.positional).toEqual(['extra']);
    expect(bound.args.has('policy')).toBe(true);
    expect(bound.args.has('aging')).toBe(false);
  });

  it('takes several values, honours -- and --flag=value, and refuses unknown flags and missing values', () => {
    const three = bindFlags(['--check', '3', 'gate_c', '1'], { check: 3 });
    expect(three.ok && three.args.values('check')).toEqual(['3', 'gate_c', '1']);
    const stopped = bindFlags(['--', '-9'], { s: 1 });
    expect(stopped.ok && stopped.args.positional).toEqual(['-9']);
    const equals = bindFlags(['--policy=sjf'], { policy: 1 });
    expect(equals.ok && equals.args.value('policy')).toBe('sjf');
    expect(bindFlags(['--nope'], { policy: 1 })).toEqual({ ok: false, message: 'unknown flag --nope' });
    expect(bindFlags(['--policy'], { policy: 1 })).toEqual({ ok: false, message: 'flag --policy expects 1 value' });
    expect(bindFlags(['--policy', '--quantum', '4'], { policy: 1, quantum: 1 })).toEqual({ ok: false, message: 'flag --policy expects 1 value' });
    expect(bindFlags(['--history=1'], { history: 0 })).toEqual({ ok: false, message: 'flag --history takes no value' });
  });

  it('converts numbers only when asked', () => {
    expect(parseInteger('7')).toBe(7);
    expect(parseInteger('-5')).toBe(-5);
    expect(parseInteger('7.5')).toBeNull();
    expect(parseInteger('abc')).toBeNull();
    expect(parseInteger(undefined)).toBeNull();
    expect(parseNumber('0.3')).toBe(0.3);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('x')).toBeNull();
  });
});
