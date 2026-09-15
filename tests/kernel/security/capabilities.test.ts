import { describe, expect, it } from 'vitest';
import { AccessMatrix, type MutableSecurityPayload } from '../../../src/kernel/security/accessMatrix';
import { capabilityCheck, fnv1a32, sealCapability, verifyCapability, type Capability } from '../../../src/kernel/security/capabilities';
import { createKernel } from '../../../src/kernel/Kernel';
import { createStreamRegistry } from '../../../src/kernel/rng';
import { asTick, type DomainId } from '../../../src/kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

function fixture() {
  const state: MutableSecurityPayload = { tick: asTick(0), accessModel: 'capability', nextTrapId: 1, domains: [], acl: [], capabilities: [], roles: [],
    processes: [], inodeDomains: [], pageProtection: [], sharedProtection: [], requests: [], probes: [] };
  const verify = (domain: DomainId, capability: Capability) => verifyCapability(capability, domain, 0x12345678);
  const matrix = new AccessMatrix(() => state, (domain, object, rights) => sealCapability(object, rights, domain, 0x12345678), verify);
  matrix.defineDomain('domain:user' as DomainId, 'User', 3); matrix.defineDomain('domain:other' as DomainId, 'Other', 3);
  matrix.grant('domain:user' as DomainId, 'inode:4', ['copy', 'read'], ['read']);
  return { state, matrix, verify, capability: state.capabilities.find(row => row.domain === 'domain:user')!.entries[0]! };
}
const user = 'domain:user' as DomainId, other = 'domain:other' as DomainId;

describe('sealed active capabilities', () => {
  it('uses the specified FNV-1a32 seal and canonical rights order', () => {
    const f = fixture(); expect(f.capability.rights).toEqual(['read', 'copy']);
    expect(fnv1a32('hello')).toBe(0x4f9f2cab);
    expect(f.capability.seal).toBe(fnv1a32('inode:4|read,copy|domain:user|305419896'));
    expect(f.verify(user, f.capability)).toBe(true);
  });
  it('SEC-CAP-1 refuses changed seal, object, rights and recipient', () => {
    const f = fixture();
    for (const cap of [{ ...f.capability, seal: f.capability.seal ^ 1 }, { ...f.capability, object: 'inode:5' },
      { ...f.capability, rights: ['read', 'write'] as const }, { ...f.capability, rights: ['copy', 'read'] as const }]) {
      expect(capabilityCheck(f.state.capabilities, user, cap.object, 'read', f.verify, cap)).toBe(false);
    }
    expect(capabilityCheck(f.state.capabilities, other, 'inode:4', 'read', f.verify, f.capability)).toBe(false);
  });
  it('copies with a fresh recipient seal instead of copying sealed bytes', () => {
    const f = fixture(); expect(f.matrix.copy(user, other, 'inode:4', ['read'])).toBe(true);
    const received = f.state.capabilities.find(row => row.domain === other)!.entries[0]!;
    expect(received.seal).not.toBe(f.capability.seal); expect(f.verify(other, received)).toBe(true);
    expect(f.matrix.check(other, 'inode:4', 'read')).toBe(true); expect(f.matrix.check(other, 'inode:4', 'copy')).toBe(false);
  });
  it('revocation defeats a still mathematically valid old seal', () => {
    const f = fixture(), old = structuredClone(f.capability); f.matrix.revoke(user, 'inode:4', ['read']);
    expect(f.verify(user, old)).toBe(true); expect(capabilityCheck(f.state.capabilities, user, 'inode:4', 'read', f.verify, old)).toBe(false);
  });
  it('draws kernelSecret exactly once from root/security at construction and keeps it out of every snapshot field', () => {
    const kernel = createKernel(REFERENCE_CONFIG), reference = createStreamRegistry(REFERENCE_CONFIG.seed);
    const material = reference.stream('security').int(0, 0x100000000), securityState = (states: readonly { label: string }[]) => states.find(state => state.label === 'root/security');
    expect(securityState(kernel.snapshot().rng)).toEqual(securityState(reference.saveAll()));
    const snapshot = JSON.stringify(kernel.snapshot());
    expect(snapshot).not.toContain('kernelSecret'); expect(snapshot).not.toContain(String(material));
    expect(Object.keys(kernel.securitySubsystem)).not.toContain('kernelSecret'); expect('kernelSecret' in kernel.securitySubsystem).toBe(false);
    const disabled = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(id => id !== 'security') });
    expect(securityState(disabled.snapshot().rng)).toEqual(securityState(createStreamRegistry(REFERENCE_CONFIG.seed).saveAll()));
  });
  it('round-trips active public capabilities without retaining sealing material in the helpers', () => {
    const f = fixture(), json = JSON.stringify(f.state), restored = JSON.parse(json) as MutableSecurityPayload;
    expect(json).not.toContain('kernelSecret'); expect(json).not.toContain('305419896');
    expect(capabilityCheck(restored.capabilities, user, 'inode:4', 'read', f.verify, f.capability)).toBe(true);
    expect(Object.keys(f.matrix)).not.toContain('kernelSecret');
  });
});
