/**
 * KERNEL TRAIL: the terminal's DOM (WP-15 spec 6, architecture 7.5).
 *
 * Batched writes, no layout reads, no per-frame mutation. Lines queue in
 * `append` and reach the document in `flush`, as one document fragment
 * appended once; when the queue is empty, flush touches nothing. Scrollback
 * is capped at `maxScrollbackLines` and trimmed from the head. The view knows
 * keys and lines, not commands: the terminal facade wires its callbacks to
 * the shell. Text goes in through textContent, never innerHTML.
 */
import { TERMINAL_CLASS, terminalStyles } from './terminal.css';

export type LineKind = 'output' | 'error' | 'echo';

export interface TerminalViewOptions {
  readonly document?: Document;
  readonly maxScrollbackLines?: number;
  readonly prompt?: string;
  /** Enter with the current input. */
  readonly onSubmit?: (line: string) => void;
  /** Up and Down; return the line to show, or null to leave the input alone. */
  readonly onHistory?: (direction: 'up' | 'down') => string | null;
  /** Tab; return the replacement span and its candidates. */
  readonly onComplete?: (input: string) => { readonly candidates: readonly string[]; readonly start: number; readonly end: number };
  /** Escape. */
  readonly onClose?: () => void;
}

export const DEFAULT_MAX_SCROLLBACK_LINES = 2000;
export const DEFAULT_PROMPT = 'kt> ';

export class TerminalView {
  readonly root: HTMLElement;
  private readonly output: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly doc: Document;
  private readonly queue: { readonly text: string; readonly kind: LineKind }[] = [];
  private readonly listener: (event: KeyboardEvent) => void;
  readonly maxScrollbackLines: number;

  constructor(private readonly options: TerminalViewOptions = {}) {
    const doc = options.document ?? globalThis.document;
    if (doc === undefined) throw new Error('TerminalView needs a document');
    this.doc = doc;
    this.maxScrollbackLines = options.maxScrollbackLines ?? DEFAULT_MAX_SCROLLBACK_LINES;
    if (!Number.isSafeInteger(this.maxScrollbackLines) || this.maxScrollbackLines < 1) throw new RangeError('maxScrollbackLines must be a positive integer');
    this.root = doc.createElement('section');
    this.root.className = TERMINAL_CLASS;
    this.root.setAttribute('role', 'log');
    this.root.setAttribute('aria-label', 'terminal');
    const style = doc.createElement('style');
    style.textContent = terminalStyles();
    this.output = doc.createElement('div');
    this.output.className = `${TERMINAL_CLASS}-output`;
    const row = doc.createElement('div');
    row.className = `${TERMINAL_CLASS}-row`;
    const prompt = doc.createElement('span');
    prompt.className = `${TERMINAL_CLASS}-prompt`;
    prompt.textContent = options.prompt ?? DEFAULT_PROMPT;
    this.input = doc.createElement('input');
    this.input.className = `${TERMINAL_CLASS}-input`;
    this.input.setAttribute('type', 'text');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('aria-label', 'terminal input');
    this.status = doc.createElement('div');
    this.status.className = `${TERMINAL_CLASS}-status`;
    row.append(prompt, this.input);
    this.root.append(style, this.output, row, this.status);
    this.listener = event => this.onKey(event);
    this.input.addEventListener('keydown', this.listener as EventListener);
  }

  get element(): HTMLElement { return this.root; }
  get inputElement(): HTMLInputElement { return this.input; }
  get outputElement(): HTMLElement { return this.output; }
  /** Lines currently in the document. */
  get lineCount(): number { return this.output.childElementCount; }
  get pendingCount(): number { return this.queue.length; }
  get value(): string { return this.input.value; }
  set value(text: string) { this.input.value = text; }

  /** Queue lines; nothing reaches the DOM until flush. */
  append(lines: readonly string[], kind: LineKind = 'output'): void {
    for (const text of lines) this.queue.push({ text, kind });
  }

  echo(line: string): void { this.append([`${this.options.prompt ?? DEFAULT_PROMPT}${line}`], 'echo'); }

  /** One batch: trim the head past the cap, then append every queued line as a single fragment. */
  flush(): void {
    if (this.queue.length === 0) return;
    const incoming = this.queue.splice(0, this.queue.length);
    const keep = Math.max(0, this.maxScrollbackLines - incoming.length);
    while (this.output.childElementCount > keep) {
      const first = this.output.firstElementChild;
      if (first === null) break;
      first.remove();
    }
    const fragment = this.doc.createDocumentFragment();
    for (const line of incoming.slice(-this.maxScrollbackLines)) {
      const element = this.doc.createElement('div');
      element.className = line.kind === 'output' ? `${TERMINAL_CLASS}-line` : `${TERMINAL_CLASS}-line ${TERMINAL_CLASS}-line-${line.kind}`;
      element.textContent = line.text;
      fragment.appendChild(element);
    }
    this.output.appendChild(fragment);
    this.output.scrollTop = this.output.scrollHeight;
  }

  setStatus(text: string): void { this.status.textContent = text; }

  open(): void { this.root.removeAttribute('hidden'); this.input.focus(); }
  close(): void { this.root.setAttribute('hidden', ''); }
  get isOpen(): boolean { return !this.root.hasAttribute('hidden'); }

  clear(): void {
    this.queue.length = 0;
    while (this.output.firstChild !== null) this.output.firstChild.remove();
  }

  dispose(): void {
    this.input.removeEventListener('keydown', this.listener as EventListener);
    this.root.remove();
  }

  private onKey(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Enter': {
        event.preventDefault();
        const line = this.input.value;
        this.input.value = '';
        this.options.onSubmit?.(line);
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const recalled = this.options.onHistory?.(event.key === 'ArrowUp' ? 'up' : 'down');
        if (recalled !== null && recalled !== undefined) this.input.value = recalled;
        else if (event.key === 'ArrowDown' && recalled === null) this.input.value = '';
        return;
      }
      case 'Tab': {
        event.preventDefault();
        const completion = this.options.onComplete?.(this.input.value);
        if (completion === undefined || completion.candidates.length === 0) return;
        const [only] = completion.candidates;
        if (completion.candidates.length === 1 && only !== undefined) {
          this.input.value = `${this.input.value.slice(0, completion.start)}${only} `;
          return;
        }
        const prefix = commonPrefix(completion.candidates);
        if (prefix.length > completion.end - completion.start) this.input.value = `${this.input.value.slice(0, completion.start)}${prefix}`;
        this.append([completion.candidates.join('  ')]);
        return;
      }
      case 'Escape':
        event.preventDefault();
        this.options.onClose?.();
        return;
      default:
        return;
    }
  }
}

export function commonPrefix(words: readonly string[]): string {
  const [first, ...rest] = words;
  if (first === undefined) return '';
  let prefix = first;
  for (const word of rest) {
    let index = 0;
    while (index < prefix.length && index < word.length && prefix.charAt(index) === word.charAt(index)) index += 1;
    prefix = prefix.slice(0, index);
    if (prefix.length === 0) break;
  }
  return prefix;
}
