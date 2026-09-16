/**
 * Small DOM helpers shared by the HUD regions. Every node is created through
 * the mount's own document, so `src/ui` never touches the `document` global.
 */

export interface HudRegion<P> {
  readonly el: HTMLElement;
  /** Apply new props. Returns true when a displayed value changed. */
  update(props: P): boolean;
  dispose(): void;
}

export function el(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `textContent` only when the string actually changed; setting identical text still dirties the node. */
export function setText(node: HTMLElement, text: string): boolean {
  if (node.textContent === text) return false;
  node.textContent = text;
  return true;
}

/** A 0 to 1 fill expressed as a scaleX custom property the bar's CSS reads. */
export function setFill(node: HTMLElement, fraction: number): boolean {
  const clamped = Math.max(0, Math.min(1, fraction));
  const value = clamped.toFixed(4);
  if (node.style.getPropertyValue('--kt-fill') === value) return false;
  node.style.setProperty('--kt-fill', value);
  return true;
}

export function setColour(node: HTMLElement, css: string): boolean {
  if (node.style.color === css) return false;
  node.style.color = css;
  return true;
}
