import { describe, expect, it } from 'vitest';
import { AccessMatrix, type MutableSecurityPayload } from '../../../src/kernel/security/accessMatrix';
import { ACCESS_RIGHTS, aclCheck } from '../../../src/kernel/security/acl';
import { capabilityCheck, sealCapability, verifyCapability } from '../../../src/kernel/security/capabilities';
import { defaultRoles, roleDomains, validateRoles } from '../../../src/kernel/security/rbac';
import { privilegeExcess, recordUse } from '../../../src/kernel/security/leastPrivilege';
import { asPid, asTick, type DomainId } from '../../../src/kernel/types';
import { createRng } from '../../../src/kernel/rng';

function fixture() {
  const state: MutableSecurityPayload = { tick: asTick(0), accessModel: 'acl', nextTrapId: 1, domains: [], acl: [], capabilities: [], roles: [],
    processes: [], inodeDomains: [], pageProtection: [], sharedProtection: [], requests: [], probes: [] };
  const seal: ConstructorParameters<typeof AccessMatrix>[1] = (domain, object, rights) => sealCapability(object, rights, domain, 123);
  const verify: ConstructorParameters<typeof AccessMatrix>[2] = (domain, capability) => verifyCapability(capability, domain, 123);
  const matrix = new AccessMatrix(() => state, seal, verify);
  for (const id of ['domain:kernel', 'domain:user', 'domain:other']) matrix.defineDomain(id as DomainId, id, id === 'domain:kernel' ? 0 : 3);
  return { state, matrix, verify };
}
const user = 'domain:user' as DomainId, other = 'domain:other' as DomainId;

describe('sparse access matrix, ACL and capability projections', () => {
  it('owner implies every one of the six rights; missing objects remain denied', () => {
    const f = fixture(); f.matrix.grant(user, 'inode:4', ['owner']);
    for (const right of ACCESS_RIGHTS) expect(f.matrix.check(user, 'inode:4', right)).toBe(true);
    expect(f.matrix.check('kernel' as DomainId, 'unknown', 'read')).toBe(false);
    expect(f.state.domains.find(domain => domain.id === user)!.rights[0]!.rights).toEqual(['owner']);
  });
  it('stores only occupied sparse cells while presenting stable domain objects', () => {
    const f = fixture(), view = f.matrix.domains.get(user)!;
    f.matrix.grant(user, 'inode:4', ['read']); f.matrix.grant(other, 'inode:9999', ['write']);
    expect(f.state.domains.reduce((sum, domain) => sum + domain.rights.length, 0)).toBe(2);
    expect(f.state.acl).toHaveLength(2); expect(f.matrix.domains.get(user)).toBe(view); expect(view.rights.get('inode:4')).toEqual(['read']);
  });
  it('restricts row edits to object owners or supervisors with control', () => {
    const f = fixture(); f.matrix.grant(user, 'inode:4', ['read']);
    expect(f.matrix.grantAs(user, other, 'inode:4', ['write'])).toBe(false);
    f.matrix.grant(user, 'inode:4', ['owner']); expect(f.matrix.grantAs(user, other, 'inode:4', ['write'])).toBe(true);
    f.matrix.grant(user, other, ['control']); expect(f.matrix.grantAs(user, other, 'inode:5', ['read'])).toBe(true);
    expect(f.matrix.revokeAs(user, other, 'inode:5', ['read'])).toBe(true); expect(f.matrix.check(other, 'inode:5', 'read')).toBe(false);
  });
  it('copies only held rights and never propagates copy unless marked transferable', () => {
    const f = fixture(); f.matrix.grant(user, 'inode:4', ['read', 'copy']);
    expect(f.matrix.copy(user, other, 'inode:4', ['read'])).toBe(false);
    f.matrix.grant(user, 'inode:4', ['read'], ['read']);
    expect(f.matrix.copy(user, other, 'inode:4', ['write'])).toBe(false);
    expect(f.matrix.copy(user, other, 'inode:4', ['read'])).toBe(true);
    expect(f.matrix.copy(user, other, 'inode:4', ['copy'])).toBe(false);
    f.matrix.grant(user, 'inode:4', ['copy'], ['copy']); expect(f.matrix.copy(user, other, 'inode:4', ['copy'])).toBe(true);
  });
  it('ACL-MATRIX runs 600 seeded queries identically across representations and model switches', () => {
    const f = fixture(), rng = createRng(0x4b54524c);
    for (let i = 0; i < 20; i++) f.matrix.grant(i % 2 === 0 ? user : other, `inode:${i}`, [ACCESS_RIGHTS[rng.int(0, 6)]!]);
    const queries = Array.from({ length: 600 }, () => ({ domain: rng.int(0, 2) === 0 ? user : other, object: `inode:${rng.int(0, 30)}`, right: ACCESS_RIGHTS[rng.int(0, 6)]! }));
    const acl = queries.map(query => f.matrix.check(query.domain, query.object, query.right)); f.matrix.switchModel('capability');
    expect(queries.map(query => f.matrix.check(query.domain, query.object, query.right))).toEqual(acl);
    for (const query of queries) expect(aclCheck(f.state.acl, query.domain, query.object, query.right)).toBe(capabilityCheck(f.state.capabilities, query.domain, query.object, query.right, f.verify));
    expect(() => f.matrix.assertEquivalent()).not.toThrow(); f.matrix.switchModel('acl'); expect(queries.map(query => f.matrix.check(query.domain, query.object, query.right))).toEqual(acl);
  });
  it('I-36 catches tampered materialized authority', () => {
    const f = fixture(); f.matrix.grant(user, 'inode:4', ['read']); f.state.acl[0]!.entries[0]!.rights.push('write');
    expect(() => f.matrix.assertEquivalent()).toThrow('I-36');
  });
});

describe('roles and actual-use accounting', () => {
  it('resolves the six roles with isolated driver authority', () => {
    const roles = defaultRoles(); expect(roles).toHaveLength(6);
    expect(roleDomains(roles, ['operator'])).toEqual(['domain:spool', 'domain:user', 'domain:user_ro']);
    expect(roleDomains(roles, ['driver'])).toEqual(['domain:driver']);
    expect(roleDomains(roles, ['admin'])).not.toContain('domain:driver'); expect(roleDomains(roles, ['admin'])).not.toContain('domain:kernel');
  });
  it('rejects cyclic, missing and duplicate role definitions', () => {
    expect(() => validateRoles([{ id: 'a', displayName: 'a', domains: [], inherits: ['b'] }, { id: 'b', displayName: 'b', domains: [], inherits: ['a'] }])).toThrow('cyclic');
    expect(() => validateRoles([{ id: 'a', displayName: 'a', domains: [], inherits: ['missing'] }])).toThrow('unknown');
    expect(() => validateRoles([defaultRoles()[0]!, defaultRoles()[0]!])).toThrow('duplicate');
  });
  it('SEC-LEAST-1 counts effective unused pairs without treating inspection as actual use', () => {
    const f = fixture(); f.matrix.grant(user, 'inode:4', ['read', 'write']); f.matrix.grant(other, 'inode:4', ['owner']);
    f.state.processes.push({ pid: asPid(2), active: true, domain: user, ring: 3, roles: ['user'], usedRights: [], traps: [] },
      { pid: asPid(3), active: true, domain: other, ring: 3, roles: ['admin'], usedRights: [], traps: [] });
    f.matrix.check(user, 'inode:4', 'read'); expect(privilegeExcess(f.state).byPid.get(asPid(2))).toBe(2);
    recordUse(f.state, asPid(2), 'inode:4', 'read'); recordUse(f.state, asPid(3), 'inode:4', 'read');
    expect(privilegeExcess(f.state).byPid.get(asPid(2))).toBe(1); expect(privilegeExcess(f.state).byPid.get(asPid(3))).toBe(5);
    recordUse(f.state, asPid(2), 'inode:4', 'read'); f.matrix.revoke(user, 'inode:4', ['read', 'write']); f.state.processes[0]!.active = false;
    expect(privilegeExcess(f.state).byPid.get(asPid(2))).toBe(0); expect(f.state.processes[0]!.usedRights).toHaveLength(1);
  });
});
