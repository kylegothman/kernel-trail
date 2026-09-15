import { Vector3 } from 'three/webgpu';
import { AMBER, CYAN, SLATE } from '@design';
import type { EffectKind, EffectSpawn } from '../effects/types';

export interface DomainRuntime {
  readonly spawn?: (effect: EffectSpawn) => void;
  readonly write?: (key: string, value: number | string) => void;
  readonly panic?: (message: string) => void;
  readonly stopHost?: () => void;
}
export interface DomainReaction { readonly kind: EffectKind | 'state' | 'label' | 'panic'; readonly effect?: EffectSpawn; readonly key?: string; readonly value?: number | string; }

export class DomainVisuals {
  readonly reactions: DomainReaction[] = [];
  protected readonly origin = new Vector3();
  protected constructor(protected readonly runtime: DomainRuntime = {}) {}
  protected spawn(kind: EffectKind, colour: number, lifetimeSeconds: number, intensity = 1, a?: number, b?: number, c?: number, d?: number): void {
    const effect = { kind, at: this.origin, lifetimeSeconds, intensity, colour } as { -readonly [K in keyof EffectSpawn]: EffectSpawn[K] };
    if (a !== undefined) effect.a = a;
    if (b !== undefined) effect.b = b;
    if (c !== undefined) effect.c = c;
    if (d !== undefined) effect.d = d;
    this.reactions.push({ kind, effect });
    this.runtime.spawn?.(effect);
  }
  protected state(key: string, value: number | string): void { this.reactions.push({ kind: 'state', key, value }); this.runtime.write?.(key, value); }
  protected label(value: string): void { this.reactions.push({ kind: 'label', value }); this.runtime.write?.('label', value); }
  protected panic(message: string): void { this.reactions.push({ kind: 'panic', value: message }); this.runtime.panic?.(message); this.runtime.stopHost?.(); }
  protected cyan(): number { return CYAN.core; }
  protected amber(): number { return AMBER.core; }
  protected slate(): number { return SLATE.primary; }
}
