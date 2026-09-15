import type { SecurityVisuals as SecurityContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class SecurityVisuals extends DomainVisuals implements SecurityContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onAccessDenied(e: KernelEventOf<'security.access_denied'>, _c: WorldEventContext): void { this.spawn('denial_ward', this.amber(), 0.18, e.domain === 'security' ? 1 : 0.85); }
  onEscalation(e: KernelEventOf<'security.escalation_attempt'>, _c: WorldEventContext): void {
    if (e.blocked) this.spawn('denial_ward', this.amber(), 0.4, 1, e.fromRing, e.toRing);
    else { this.state(`security:${e.pid as number}:escalated`, 1); this.state('security:fatal', 1); }
  }
}
