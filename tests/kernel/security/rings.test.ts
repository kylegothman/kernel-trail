import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../sourceScan';
import { Rings } from '../../../src/kernel/security/rings';
import { callerIdentity, commitDomainReturn } from '../../../src/kernel/security/domains';
import { defaultRoles } from '../../../src/kernel/security/rbac';
import type { MutableSecurityPayload } from '../../../src/kernel/security/accessMatrix';
import type { EmittableEvent } from '../../../src/kernel/EventBus';
import { asPid, asTick, type DomainId } from '../../../src/kernel/types';

function fixture() {
  const state: MutableSecurityPayload = { tick: asTick(0), accessModel: 'acl', nextTrapId: 1,
    domains: [{ id: 'domain:kernel' as DomainId, displayName: 'Kernel', ring: 0, rights: [] },
      { id: 'domain:user' as DomainId, displayName: 'User', ring: 3, rights: [] },
      { id: 'domain:spool' as DomainId, displayName: 'Spool', ring: 3, rights: [] }],
    acl: [], capabilities: [], roles: structuredClone(defaultRoles()) as MutableSecurityPayload['roles'],
    processes: [{ pid: asPid(2), active: true, domain: 'domain:user' as DomainId, ring: 3, roles: ['operator'], usedRights: [], traps: [] }],
    inodeDomains: [], pageProtection: [], sharedProtection: [], requests: [], probes: [] };
  const events: EmittableEvent[] = [], host = { state: () => state, emit: (event: EmittableEvent) => { events.push(event); } };
  return { state, events, host, rings: new Rings(host) };
}

describe('caller-ceiling gates and trap continuation', () => {
  it('refuses a ring register change and emits one blocked decision without changing state', () => {
    const f = fixture(), before = structuredClone(f.state.processes[0]);
    expect(f.rings.setRing(asPid(2), 0)).toBe(false); expect(f.state.processes[0]).toEqual(before);
    expect(f.events).toEqual([{ type: 'security.escalation_attempt', pid: 2, fromRing: 3, toRing: 0, blocked: true }]);
  });
  it('no instruction in the instruction set writes the current ring, and only the security subsystem assigns it', () => {
    const root = join(__dirname, '../../../src/kernel');
    const program = stripComments(readFileSync(join(root, 'process/Program.ts'), 'utf8'), false);
    const union = program.slice(program.indexOf('export type Instruction'), program.indexOf('export interface Program'));
    expect(union.length).toBeGreaterThan(100); expect(union).not.toMatch(/ring/i);
    // The instruction executor and the process code never assign a protection ring; only security does.
    const executors = ['Kernel.ts', ...readdirSync(join(root, 'process')).map(name => join('process', name))].filter(name => name.endsWith('.ts'));
    for (const name of executors) expect(stripComments(readFileSync(join(root, name), 'utf8'), false)).not.toMatch(/\.ring\s*=[^=]/);
  });
  it('rejects ring 3 at a gate whose caller ceiling is 1', () => {
    const f = fixture(); expect(f.rings.callGate(asPid(2), 1, 0)).toBe(false);
    expect(f.state.processes[0]!.ring).toBe(3); expect(f.state.processes[0]!.traps).toEqual([]);
  });
  it('permits ring 0 to call a routine at ring 3 while retaining its execution ring', () => {
    const f = fixture(); f.rings.enterTrap(asPid(2)); expect(f.rings.callGate(asPid(2), 3, 3)).toBe(true);
    expect(f.state.processes[0]!.ring).toBe(0); expect(f.state.processes[0]!.traps).toHaveLength(1);
  });
  it('enters the fixed syscall handler and restores the saved domain and ring', () => {
    const f = fixture(); expect(f.rings.enterTrap(asPid(2))).toBe(1);
    expect(f.state.processes[0]).toMatchObject({ domain: 'domain:kernel', ring: 0 });
    expect(callerIdentity(f.state, asPid(2))).toEqual({ domain: 'domain:user', ring: 3 });
    expect(f.rings.returnTrap(asPid(2))).toBe(true); expect(f.state.processes[0]).toMatchObject({ domain: 'domain:user', ring: 3, traps: [] });
    expect(f.events.map(event => event.type === 'security.escalation_attempt' && event.blocked)).toEqual([false, false]);
  });
  it('pops nested saved domains and rings without allocating new continuation on restore', () => {
    const f = fixture(); f.rings.enterTrap(asPid(2)); f.rings.enterTrap(asPid(2));
    const restored = new Rings(f.host); restored.assertInvariants(); restored.returnTrap(asPid(2));
    expect(f.state.processes[0]).toMatchObject({ domain: 'domain:kernel', ring: 0 });
    restored.returnTrap(asPid(2)); expect(f.state.processes[0]).toMatchObject({ domain: 'domain:user', ring: 3 });
  });
  it('refuses an inward return without consuming its frame', () => {
    const f = fixture(); f.rings.enterTrap(asPid(2)); expect(f.rings.returnTrap(asPid(2), 1)).toBe(false);
    expect(f.state.processes[0]!.traps).toHaveLength(1); expect(f.rings.returnTrap(asPid(2))).toBe(true);
  });
  it('refuses an arbitrary outward return instead of changing the saved domain privilege', () => {
    const f = fixture(); f.state.processes[0]!.ring = 1; f.rings.enterTrap(asPid(2));
    expect(f.rings.returnTrap(asPid(2), 3)).toBe(false); expect(f.state.processes[0]!.traps).toHaveLength(1);
    expect(f.rings.returnTrap(asPid(2))).toBe(true); expect(f.state.processes[0]!.ring).toBe(1);
  });
  it('checks page access using r <= requiredRing', () => {
    const f = fixture(); expect(f.rings.canAccessPage(asPid(2), 1)).toBe(false); expect(f.rings.canAccessPage(asPid(2), 3)).toBe(true);
    f.rings.enterTrap(asPid(2)); expect(f.rings.canAccessPage(asPid(2), 1)).toBe(true);
  });
  it('persists an explicitly authorized switch through the enclosing syscall return', () => {
    const f = fixture(); f.rings.enterTrap(asPid(2));
    expect(commitDomainReturn({ ...f.host, check: () => true }, asPid(2), 'domain:spool' as DomainId, 'explicit_switch')).toBe(true);
    f.rings.returnTrap(asPid(2)); expect(f.state.processes[0]).toMatchObject({ domain: 'domain:spool', ring: 3 });
  });
  it('requires both control and role eligibility for explicit switches', () => {
    const f = fixture(); expect(commitDomainReturn({ ...f.host, check: () => false }, asPid(2), 'domain:spool' as DomainId, 'explicit_switch')).toBe(false);
    expect(commitDomainReturn({ ...f.host, check: () => true }, asPid(2), 'domain:kernel' as DomainId, 'explicit_switch')).toBe(false);
    expect(f.state.processes[0]!.domain).toBe('domain:user');
  });
  it('rejects non-monotonic saved rings and ring-zero user execution outside a trap', () => {
    const f = fixture(), process = f.state.processes[0]!;
    process.traps.push({ id: 1, savedDomain: process.domain, savedRing: 1, committedReturn: null }, { id: 2, savedDomain: process.domain, savedRing: 3, committedReturn: null });
    expect(() => f.rings.assertInvariants()).toThrow('I-34'); process.traps = []; process.ring = 0;
    expect(() => f.rings.assertInvariants()).toThrow('I-35');
  });
});
