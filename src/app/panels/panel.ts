/** Plain DOM stand-ins for world decisions. A later UI pass replaces these views. */
import { CYAN, FONT_STACK, SLATE, VOID, cssColor } from '@design';

export interface PanelOptions {
  readonly document: Document;
  readonly overlay: HTMLElement;
  /**
   * WP-24 section 1: a panel that asks the player a question holds the clock
   * while it is open. Supplied by the host as `pacing.hold`; the panel takes
   * the hold on `show` and releases it on `close`, so it pauses by
   * construction. Left out by the interactions panel, which is always open.
   */
  readonly hold?: (reason: string) => () => void;
}

export interface PanelShell {
  readonly element: HTMLElement;
  readonly heading: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  dispose(): void;
}

/** Called only during a panel's commit step. No backdrop or focus trap. */
export function createPanel(doc: Document, variant: string, label: string, overlay: HTMLElement): PanelShell {
  const element = doc.createElement('section');
  element.className = `kt-panel kt-panel--${variant}`;
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', label);
  element.style.pointerEvents = 'auto';
  const style = doc.createElement('style');
  style.textContent = `
    .kt-panel { position:absolute; top:18%; right:24px; width:min(44rem,calc(100% - 48px));
      max-height:64%; overflow:auto; box-sizing:border-box; padding:16px;
      color:${cssColor(SLATE.primary)}; background:${cssColor(VOID.base, 0.96)};
      border:1px solid ${cssColor(CYAN.dim)}; border-radius:2px; font:14px/1.5 ${FONT_STACK.sans}; }
    .kt-panel h2 { margin:0 0 12px; font-size:18px; font-weight:500; }
    .kt-panel h3 { margin:12px 0 6px; font-size:14px; }
    .kt-panel p { margin:4px 0 8px; }
    .kt-panel footer { display:flex; gap:8px; margin-top:12px; }
    .kt-panel button,.kt-panel input,.kt-panel select { font:inherit; color:inherit;
      background:${cssColor(VOID.base)}; border:1px solid ${cssColor(CYAN.dim)}; border-radius:2px; padding:5px 8px; }
    .kt-panel button { cursor:pointer; } .kt-panel button:disabled { opacity:0.45; cursor:default; }
    .kt-panel button:focus-visible,.kt-panel input:focus-visible,.kt-panel select:focus-visible { outline:2px solid ${cssColor(CYAN.core)}; }
    .kt-panel table { width:100%; border-collapse:collapse; font:12px/1.5 ${FONT_STACK.mono}; }
    .kt-panel th,.kt-panel td { text-align:left; padding:5px; border-bottom:1px solid ${cssColor(CYAN.dim, 0.3)}; }
    .kt-panel pre { white-space:pre-wrap; font-family:${FONT_STACK.mono}; }
    .kt-panel--interactions { left:24px; right:auto; width:min(22rem,calc(100% - 48px)); }
    .kt-panel--requisition { top:max(24px,2.5vh); max-height:calc(100% - 2 * max(24px,2.5vh)); display:flex; flex-direction:column; overflow:hidden; }
    .kt-panel--requisition > h2 { flex:0 0 auto; }
    .kt-panel--requisition > div { flex:1 1 auto; min-height:0; overflow:auto; }
    .kt-panel--requisition > footer { flex:0 0 auto; flex-wrap:wrap; align-items:center; border-top:1px solid ${cssColor(CYAN.dim, 0.3)}; padding-top:8px; }
    .kt-panel-row { padding:8px 0; border-bottom:1px solid ${cssColor(CYAN.dim, 0.3)}; }
    .kt-panel-error { color:${cssColor(SLATE.protected)}; }
    .kt-panel-search { width:100%; box-sizing:border-box; margin-bottom:8px; }
    .kt-panel-codex-list { display:flex; flex-wrap:wrap; gap:6px; }
  `;
  const heading = doc.createElement('h2');
  heading.textContent = label;
  const body = doc.createElement('div');
  const footer = doc.createElement('footer');
  element.append(style, heading, body, footer);
  overlay.append(element);
  return { element, heading, body, footer, dispose: () => element.remove() };
}

/** Model changes mark views dirty; the host calls flush after rendering. */
export abstract class DeferredPanel {
  private visible = false;
  private dirty = false;
  private disposed = false;
  private shell: PanelShell | null = null;
  private release: (() => void) | null = null;

  protected constructor(protected readonly options: PanelOptions, private readonly variant: string, private readonly label: string) {}

  get isOpen(): boolean { return this.visible; }
  get element(): HTMLElement | null { return this.shell?.element ?? null; }
  protected show(): void {
    if (this.disposed) return;
    this.visible = true; this.dirty = true;
    if (this.release === null && this.options.hold !== undefined) this.release = this.options.hold(this.variant);
  }
  protected invalidate(): void { if (!this.disposed) this.dirty = true; }
  close(): void {
    this.visible = false; this.dirty = true;
    const release = this.release; this.release = null; release?.();
  }

  flush(): void {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    if (!this.visible) { this.shell?.dispose(); this.shell = null; return; }
    this.shell ??= createPanel(this.options.document, this.variant, this.label, this.options.overlay);
    this.render(this.shell);
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.flush();
    this.disposed = true;
  }

  protected abstract render(shell: PanelShell): void;
}

export function paragraph(doc: Document, text: string, className = ''): HTMLElement {
  const p = doc.createElement('p'); p.textContent = text; p.className = className; return p;
}

export function button(doc: Document, label: string, action: () => void): HTMLButtonElement {
  const result = doc.createElement('button'); result.type = 'button'; result.textContent = label;
  result.addEventListener('click', action); return result;
}

export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function resourcesText(resources: Readonly<Record<string, number | undefined>>): string {
  const values = Object.entries(resources).filter(([, amount]) => amount !== undefined && amount !== 0);
  return values.length === 0 ? 'none' : values.map(([name, amount]) => `${name}: ${amount}`).join(', ');
}
