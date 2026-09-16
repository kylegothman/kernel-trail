/**
 * KERNEL TRAIL: the terminal (WP-15).
 *
 * A base shell over a TerminalHost plus a batched DOM view, wired together:
 * Enter echoes the line, runs it, and queues the result; Up and Down walk
 * the history; Tab completes from the registry and the live host; Escape
 * closes. The app loop calls `flush` once per frame, after rendering, so the
 * DOM sees one batch per frame and nothing when the terminal is idle.
 */
import type { TerminalHost } from './host';
import type { CommandResult } from './registry';
import { createBaseShell, Shell, type ShellOptions } from './Shell';
import { DEFAULT_PROMPT, TerminalView } from './render/TerminalView';

export interface TerminalOptions extends ShellOptions {
  readonly document?: Document;
  readonly maxScrollbackLines?: number;
  readonly prompt?: string;
  /** A shell to drive instead of a fresh base shell. */
  readonly shell?: Shell;
  readonly onClose?: () => void;
}

export interface Terminal {
  readonly shell: Shell;
  readonly view: TerminalView;
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Echo, run and queue one line, as Enter does. */
  submit(line: string): CommandResult;
  /** Publish queued output. Once per frame, after rendering. */
  flush(): void;
  dispose(): void;
}

export function createTerminal(host: TerminalHost, options: TerminalOptions = {}): Terminal {
  const shellOptions: ShellOptions = { ...(options.rings === undefined ? {} : { rings: options.rings }), ...(options.handlers === undefined ? {} : { handlers: options.handlers }) };
  const shell = options.shell ?? createBaseShell(host, shellOptions);
  const prompt = options.prompt ?? DEFAULT_PROMPT;
  let view: TerminalView;
  const submit = (line: string): CommandResult => {
    view.echo(line);
    const result = shell.execute(line);
    if (result.ok) view.append(result.lines, 'output');
    else view.append(result.message.split('\n'), 'error');
    view.setStatus(`tick ${host.kernel.tick}  ${shell.registry.names().length} commands  ${result.ok ? 'ok' : `see man ${result.topic}`}`);
    return result;
  };
  view = new TerminalView({
    ...(options.document === undefined ? {} : { document: options.document }),
    ...(options.maxScrollbackLines === undefined ? {} : { maxScrollbackLines: options.maxScrollbackLines }),
    prompt,
    onSubmit: submit,
    onHistory: direction => (direction === 'up' ? shell.history.up() : shell.history.down()),
    onComplete: input => shell.complete(input),
    onClose: () => { view.close(); options.onClose?.(); },
  });
  view.close();
  return {
    shell, view,
    get element() { return view.element; },
    get isOpen() { return view.isOpen; },
    open: () => { view.open(); },
    close: () => { view.close(); },
    toggle: () => { if (view.isOpen) view.close(); else view.open(); },
    submit,
    flush: () => { view.flush(); },
    dispose: () => { view.dispose(); shell.dispose(); },
  };
}
