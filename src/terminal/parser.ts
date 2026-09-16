/**
 * KERNEL TRAIL: the terminal's line parser (WP-15 spec 3).
 *
 * A small strict grammar: a command word, whitespace-separated arguments,
 * single and double quoted strings, long flags (`--history`), short flags
 * (`-a`), and `--` to stop flag parsing. Pipes, redirection, globbing, variable
 * expansion, subshells and command chaining are refused with the offending
 * position rather than half-implemented. Parse errors are values, never
 * exceptions, and the shell turns them into a CommandResult.
 *
 * Flag arity is the command's business, not the parser's: `sched --policy rr`
 * is three words to the parser, and `bindFlags` pairs the value with its flag
 * once the command says how many values `--policy` takes.
 */

export interface ParsedLine {
  readonly command: string;
  /** Every word after the command, quotes removed, in order. `--` is kept so a command can bind flags itself. */
  readonly argv: readonly string[];
  /** Words that are not flags, plus everything after `--`. */
  readonly positional: readonly string[];
  /** Flag names before `--`, without their dashes, in order. */
  readonly flags: readonly string[];
}

export interface ParseError {
  readonly ok: false;
  readonly message: string;
  /** Character index of the offending character in the input. */
  readonly position: number;
  /** The feature the input asked for and the shell refuses. */
  readonly unsupported: string;
}

export type ParseResult = { readonly ok: true; readonly line: ParsedLine | null } | ParseError;

/** The topic every parse error names: the man page that explains what the shell is. */
export const PARSER_TOPIC = 'man';

const UNSUPPORTED: Readonly<Record<string, string>> = {
  '|': 'pipes', '>': 'redirection', '<': 'redirection',
  '*': 'globbing', '?': 'globbing', '[': 'globbing', ']': 'globbing',
  '$': 'variable expansion', '`': 'subshells', '(': 'subshells', ')': 'subshells',
  ';': 'command chaining', '&': 'command chaining',
};

interface Word { readonly text: string; readonly quoted: boolean; readonly position: number }

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function refuse(feature: string, detail: string, position: number): ParseError {
  return { ok: false, message: `${feature} not supported by this shell: ${detail} at position ${position}. See man ${PARSER_TOPIC}.`, position, unsupported: feature };
}

function tokenize(input: string): { readonly ok: true; readonly words: readonly Word[] } | ParseError {
  const words: Word[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (isSpace(input.charAt(i))) { i += 1; continue; }
    const position = i;
    let text = '';
    let quoted = false;
    while (i < n && !isSpace(input.charAt(i))) {
      const ch = input.charAt(i);
      if (ch === '\'' || ch === '"') {
        const end = input.indexOf(ch, i + 1);
        if (end === -1) return refuse('unterminated quote', `opening ${ch}`, i);
        text += input.slice(i + 1, end);
        quoted = true;
        i = end + 1;
        continue;
      }
      const feature = UNSUPPORTED[ch];
      if (feature !== undefined) return refuse(feature, `'${ch}'`, i);
      text += ch;
      i += 1;
    }
    words.push({ text, quoted, position });
  }
  return { ok: true, words };
}

export type WordKind =
  | { readonly kind: 'flag'; readonly name: string; readonly value: string | null }
  | { readonly kind: 'stop' }
  | { readonly kind: 'word' };

/** `--x` and `--x=v` are long flags, `-a` is a short flag, `-12` and `-` are words, `--` stops flag parsing. */
export function classify(word: string): WordKind {
  if (word === '--') return { kind: 'stop' };
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    return eq === -1 ? { kind: 'flag', name: word.slice(2), value: null } : { kind: 'flag', name: word.slice(2, eq), value: word.slice(eq + 1) };
  }
  if (word.length >= 2 && word.startsWith('-') && !/[0-9.]/.test(word.charAt(1))) return { kind: 'flag', name: word.slice(1), value: null };
  return { kind: 'word' };
}

export function parse(input: string): ParseResult {
  const tokens = tokenize(input);
  if (!tokens.ok) return tokens;
  const [first, ...rest] = tokens.words;
  if (first === undefined) return { ok: true, line: null };
  const argv = rest.map(word => word.text);
  const positional: string[] = [];
  const flags: string[] = [];
  let stopped = false;
  for (const word of rest) {
    const kind = word.quoted ? { kind: 'word' as const } : classify(word.text);
    if (stopped || kind.kind === 'word') { positional.push(word.text); continue; }
    if (kind.kind === 'stop') { stopped = true; continue; }
    flags.push(kind.name);
  }
  return { ok: true, line: { command: first.text, argv, positional, flags } };
}

/** Values each flag consumes; a flag absent from the spec is an error. */
export type FlagSpec = Readonly<Record<string, number>>;

export interface BoundArgs {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
  has(name: string): boolean;
  /** The first value of a flag, or undefined when it is absent or takes none. */
  value(name: string): string | undefined;
  values(name: string): readonly string[];
}

export type BindResult = { readonly ok: true; readonly args: BoundArgs } | { readonly ok: false; readonly message: string };

/** Pair flags with the values the command says they take. Unknown flags and missing values are errors, not guesses. */
export function bindFlags(argv: readonly string[], spec: FlagSpec): BindResult {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let stopped = false;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index] ?? '';
    const kind = stopped ? { kind: 'word' as const } : classify(word);
    if (kind.kind === 'word') { positional.push(word); continue; }
    if (kind.kind === 'stop') { stopped = true; continue; }
    const arity = spec[kind.name];
    if (arity === undefined) return { ok: false, message: `unknown flag ${word}` };
    const values: string[] = kind.value === null ? [] : [kind.value];
    while (values.length < arity) {
      index += 1;
      const next = argv[index];
      if (next === undefined || (!stopped && classify(next).kind !== 'word')) {
        return { ok: false, message: `flag --${kind.name} expects ${arity} value${arity === 1 ? '' : 's'}` };
      }
      values.push(next);
    }
    if (values.length > arity) return { ok: false, message: `flag --${kind.name} takes no value` };
    flags.set(kind.name, values);
  }
  return { ok: true, args: {
    positional, flags,
    has: name => flags.has(name),
    value: name => flags.get(name)?.[0],
    values: name => flags.get(name) ?? [],
  } };
}

/** A decimal integer, or null. Conversion is the command's job, so the parser never guesses. */
export function parseInteger(text: string | undefined): number | null {
  if (text === undefined || !/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A finite decimal number, or null. */
export function parseNumber(text: string | undefined): number | null {
  if (text === undefined || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
