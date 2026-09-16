/**
 * KERNEL TRAIL: the protection commands of Leg 12.
 *
 * `access`, `ring` and `audit` read the security payload the host exposes and
 * the shell's rings of denials and escalation attempts. `chmod` maps the inode
 * to a path through the directory table and issues the chmod syscall through
 * the sink on the player's behalf.
 */
import type { TerminalCommandDef } from '@game/types';
import type { AccessRight, InodeId, SecuritySnapshotState } from '@kernel/types';
import { table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, unavailable, type CommandFailure, type ShippedHandler } from '../registry';
import { callerPid, type ShellContext } from '../Shell';
import { pathsOf } from './filesystem';

export const ACCESS_DEF: TerminalCommandDef = {
  name: 'access',
  usage: 'access [--matrix] [--domain <id>] [--grant <domain> <object> <right>] [--revoke ...] [--impl acl|capability]',
  summary: 'Show and edit the access matrix, and choose how it is stored.',
  manual: [
    'access --matrix prints the access matrix: one row per protection domain, one column',
    'per object, and in each cell the rights that domain holds over that object.',
    '',
    'The matrix is the model, and it is the model everything else in protection is an',
    'implementation of. A process runs inside a domain; the domain is a row; every access',
    'is checked against a cell. Changing what a process may do means changing its row, or',
    'moving it to a different one.',
    '',
    'The matrix is mostly empty in any real system, so nobody stores it as a matrix.',
    '  acl         store each column with its object: this file, and the list of who may',
    '              do what to it. Answering "who can read this" is instant. Answering',
    '              "what can this process reach" requires scanning every object.',
    '  capability  store each row with its domain: this process, and the tokens it holds.',
    '              Checking an access is instant because the process presents the token.',
    '              Revoking one is hard, because the tokens have been handed out and',
    '              copied and you no longer know where they all are.',
    'The choice is a trade between the two questions you will need to answer quickly and',
    'the revocation you will eventually need to perform.',
    '',
    'The principle to apply while editing: give each domain the smallest set of rights',
    'that lets it finish its work. Not because extra rights will definitely be abused, but',
    'because the damage a compromised process can do is exactly the rights it holds, and',
    'you decide that number in advance. Over-restricting has a cost too, and it is paid in',
    'denied operations on work you needed done.',
    '',
    'See also: ring, audit, chmod, codex access_matrix.',
  ].join('\n'),
  chapter: { chapter: 17, title: 'Protection', sections: ['17.4.1', '17.5', '17.6.1', '17.6.2', '17.10'] },
};

export const RING_DEF: TerminalCommandDef = {
  name: 'ring',
  usage: 'ring [--list] [--set <pid> <0-3>] [--gates] [--attempts]',
  summary: 'Show and set the protection ring each process executes in.',
  manual: [
    'ring reports which protection ring each process runs in and lists the gates through',
    'which a ring can be changed.',
    '',
    'Ring 0 is the kernel and may execute any instruction. Ring 3 is where ordinary',
    'processes run, and a large set of instructions fault there instead of executing: the',
    'ones that touch I/O ports, load page tables, mask interrupts, or change the ring',
    'itself.',
    '',
    'The enforcement is in hardware, and that is the only reason it is worth anything. A',
    'check written in software can be bypassed by not calling it. A process in ring 3',
    'cannot decline to be in ring 3. It changes ring only by passing through a gate the',
    'kernel defined, arriving at an address the kernel chose, which is what a system call',
    'is.',
    '',
    'This distinction is where most reasoning about security goes wrong. An application',
    'that validates its own input is doing something useful and it is not enforcing',
    'anything, because an attacker who reaches the code after the check has skipped the',
    'check. Enforcement means a boundary that cannot be gone around, and there are very few',
    'of those: the ring boundary, the page protection bits, and the reference monitor that',
    'consults the access matrix.',
    '',
    '--attempts lists every ring transition attempt with its outcome. A blocked attempt is',
    'a process trying to do something it was never supposed to be able to do, and it',
    'deserves attention even though nothing broke.',
    '',
    'See also: mode, access, audit, codex protection_rings.',
  ].join('\n'),
  chapter: { chapter: 17, title: 'Protection', sections: ['17.3', '17.2'] },
};

export const AUDIT_DEF: TerminalCommandDef = {
  name: 'audit',
  usage: 'audit [--decisions <n>] [--rights <capability>] [--denied] [--why <event>]',
  summary: 'Replay access decisions with the rule that produced each, and trace delegated rights.',
  manual: [
    'audit replays access control decisions, showing for each the domain, the object, the',
    'right requested, the outcome, and the rule that decided it.',
    '',
    '--why on a denial names the exact cell that was consulted and what it contained. Use',
    'it before granting anything. The usual response to a denial is to add rights until it',
    'stops, which reliably grants far more than the operation needed and is how domains',
    'accumulate privilege that nobody can later justify. One denial should produce one',
    'grant of one right.',
    '',
    '--rights traces a capability through every domain that holds a copy. This is the',
    'question capability systems are bad at answering and it is the question revocation',
    'depends on. If a capability was delegated and the delegate copied it, revoking the',
    'original leaves the copy alive unless the implementation supports indirect revocation.',
    'Check here rather than assuming.',
    '',
    'The audit log is also the only way to notice a successful attack. A blocked attempt',
    'raises an event and gets attention. An attempt that succeeded because the rights were',
    'wrongly granted looks exactly like normal operation, and shows up here as a domain',
    'exercising a right you did not intend it to have.',
    '',
    'See also: access, ring --attempts, codex least_privilege.',
  ].join('\n'),
  chapter: { chapter: 17, title: 'Protection', sections: ['17.6.3', '17.7'] },
};

export const CHMOD_DEF: TerminalCommandDef = {
  name: 'chmod',
  usage: 'chmod <rwx> <inode> [--owner <domain>] [--sign] [--encrypt]',
  summary: 'Set file permissions, and sign or encrypt an object.',
  manual: [
    'chmod sets the read, write and execute bits on a file for its owner, and with --sign',
    'or --encrypt applies cryptographic protection to its contents.',
    '',
    'File permissions are one row and one column of the access matrix, stored with the',
    'object, which makes them an access list in the small. The same reasoning applies:',
    'grant what is needed, and remember that the execute bit on a data file is a right',
    'nobody needs and an attacker requires.',
    '',
    'On --sign against --encrypt, which are constantly confused and solve different',
    'problems:',
    '  encrypt  makes the contents unreadable without the key. It provides secrecy. It',
    '           does not tell a reader who produced the contents, and it does not stop',
    '            anyone from replacing the whole object with a different encrypted object.',
    '  sign     attaches a value computed from the contents and a private key. Anyone with',
    '           the public key can verify that these exact contents came from that key',
    '           holder and have not been altered. It provides authentication and integrity.',
    '           It does not hide anything; a signed file is fully readable.',
    '',
    'Choose by naming the threat. If the danger is that someone reads the manifest, encrypt',
    'it. If the danger is that someone rewrites the manifest and the wall accepts it,',
    'signing is the answer and encryption is not, because an arbiter that only checks',
    'whether a thing decrypts will accept anything encrypted with the key it was given.',
    '',
    'See also: access, inode, audit, codex cryptography.',
  ].join('\n'),
  chapter: { chapter: 16, title: 'Security', sections: ['16.4.1', '16.4.2', '16.4.3', '16.4.4'] },
};

type SecurityPayload = SecuritySnapshotState['payload'];

function security(ctx: ShellContext, topic: string): { readonly ok: true; readonly sec: SecurityPayload } | CommandFailure {
  const sec = ctx.host.security();
  return sec === null ? fail(topic, 'the security subsystem is not enabled on this leg.') : { ok: true, sec };
}

const LETTER: Readonly<Record<AccessRight, string>> = { read: 'r', write: 'w', execute: 'x', owner: 'o', copy: 'c', control: 'C' };
const letters = (rights: readonly AccessRight[]): string => (rights.length === 0 ? '-' : rights.map(right => LETTER[right]).join(''));

const accessHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('access', argv, { matrix: 0, domain: 1, grant: 3, revoke: 3, impl: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('grant')) return unavailable('access', '--grant', 'rights are granted by the leg; the shell has no write path into the matrix');
    if (bound.args.has('revoke')) return unavailable('access', '--revoke', 'rights are revoked by the leg; the shell has no write path into the matrix');
    if (bound.args.has('impl')) return unavailable('access', '--impl', 'the storage model is a kernel tuning value with no write path from the shell');
    const guard = security(ctx, 'access');
    if (!guard.ok) return guard;
    const { sec } = guard;
    if (bound.args.has('domain')) {
      const id = bound.args.value('domain') ?? '';
      const domain = sec.domains.find(row => row.id === id);
      if (domain === undefined) return fail('access', `no such domain ${id}; the domains are ${sec.domains.map(row => row.id).join(', ') || 'none'}.`, 'ENOENT');
      return ok([`${domain.id} (${domain.displayName}, ring ${domain.ring})`, ...table(['OBJECT', 'RIGHTS', 'TRANSFERABLE'], domain.rights.map(row => [row.object, letters(row.rights), letters(row.transferableRights)]))]);
    }
    const objects = [...new Set(sec.domains.flatMap(domain => domain.rights.map(row => row.object)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return ok([
      `model ${sec.accessModel}, ${sec.domains.length} domains, ${objects.length} objects (r read, w write, x execute, o owner, c copy, C control)`,
      ...table(['DOMAIN', 'RING', ...objects], sec.domains.map(domain => [domain.id, domain.ring, ...objects.map(object => letters(domain.rights.find(row => row.object === object)?.rights ?? []))])),
    ]);
  },
};

const ringHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('ring', argv, { list: 0, set: 2, gates: 0, attempts: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('set')) return unavailable('ring', '--set', 'a ring changes only through a gate the kernel defines, never by request');
    if (bound.args.has('gates')) return unavailable('ring', '--gates', 'the kernel keeps no gate table to list; the trap and domain_switch are its gates');
    if (bound.args.has('attempts')) {
      const attempts = ctx.rings.escalations.toArray();
      return ok([`${attempts.length} ring transition attempts recorded`, ...table(['TICK', 'PID', 'FROM', 'TO', 'BLOCKED'], attempts.map(event => [event.tick, `P${event.pid}`, event.fromRing, event.toRing, event.blocked ? 'yes' : 'no']))]);
    }
    const guard = security(ctx, 'ring');
    if (!guard.ok) return guard;
    const { sec } = guard;
    const active = sec.processes.filter(row => row.active);
    return ok([
      ...table(['PID', 'DOMAIN', 'RING', 'ROLES', 'TRAPS'], active.map(row => [`P${row.pid}`, row.domain, row.ring, row.roles.join(',') || '-', row.traps.length])),
      `${sec.domains.length} domains`,
      ...table(['DOMAIN', 'NAME', 'RING'], sec.domains.map(domain => [domain.id, domain.displayName, domain.ring])),
    ]);
  },
};

const auditHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('audit', argv, { decisions: 1, rights: 1, denied: 0, why: 1 });
    if (!bound.ok) return bound;
    const guard = security(ctx, 'audit');
    if (!guard.ok) return guard;
    const { sec } = guard;
    const denials = ctx.rings.denials.toArray();
    if (bound.args.has('why')) {
      const index = parseInteger(bound.args.value('why'));
      const denial = index === null ? undefined : denials[index - 1];
      if (denial === undefined) return fail('audit', `denial ${bound.args.value('why') ?? ''} is not on the list; ${denials.length} recorded so far.`);
      const domain = sec.domains.find(row => row.id === denial.domain);
      const cell = domain?.rights.find(row => row.object === denial.object);
      return ok([
        `denial ${index}: tick ${denial.tick}, domain ${denial.domain} asked ${denial.right} on ${denial.object}`,
        `cell [${denial.domain}, ${denial.object}] holds ${cell === undefined ? 'nothing' : letters(cell.rights)}; ${denial.right} is not among them`,
      ]);
    }
    if (bound.args.has('rights')) {
      const object = bound.args.value('rights') ?? '';
      const holders = sec.domains.filter(domain => domain.rights.some(row => row.object === object)).map(domain => [domain.id, letters(domain.rights.find(row => row.object === object)?.rights ?? [])] as const);
      const tokens = sec.capabilities.flatMap(row => row.entries.filter(entry => entry.object === object).map(entry => [row.domain, letters(entry.rights)] as const));
      return ok([
        `${holders.length} domains hold rights on ${object}; ${tokens.length} capability tokens`,
        ...table(['DOMAIN', 'RIGHTS', 'VIA'], [...holders.map(([domain, rights]) => [domain, rights, 'matrix']), ...tokens.map(([domain, rights]) => [domain, rights, 'capability'])]),
      ]);
    }
    const uses = sec.processes.flatMap(row => row.usedRights.map(use => ({ tick: '-', domain: row.domain, object: use.object, right: use.right, outcome: `allowed (P${row.pid})` })));
    const denied = denials.map(event => ({ tick: String(event.tick), domain: event.domain, object: event.object, right: event.right, outcome: 'denied' }));
    let rows = bound.args.has('denied') ? denied : [...denied, ...uses];
    if (bound.args.has('decisions')) {
      const count = parseInteger(bound.args.value('decisions'));
      if (count === null || count < 1) return fail('audit', '--decisions needs a positive count.');
      rows = rows.slice(-count);
    }
    return ok([`${denied.length} denials, ${uses.length} successful uses recorded`, ...table(['TICK', 'DOMAIN', 'OBJECT', 'RIGHT', 'OUTCOME'], rows.map(row => [row.tick, row.domain, row.object, row.right, row.outcome]))]);
  },
};

const chmodHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('chmod', argv, { owner: 1, sign: 0, encrypt: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('owner')) return unavailable('chmod', '--owner', 'ownership changes are made by the leg; the shell has no write path');
    if (bound.args.has('sign')) return unavailable('chmod', '--sign', 'the kernel models no signatures');
    if (bound.args.has('encrypt')) return unavailable('chmod', '--encrypt', 'the kernel models no encryption');
    const [bits, inodeText] = bound.args.positional;
    if (bits === undefined || !/^[r-][w-][x-]$/.test(bits)) return fail('chmod', 'chmod needs three characters over rwx-, such as rw- or r-x.');
    const id = parseInteger(inodeText);
    if (id === null) return fail('chmod', 'chmod needs a numeric inode id after the bits.');
    const fs = ctx.host.fs();
    if (fs === null) return fail('chmod', 'the file system is not enabled on this leg.');
    const path = pathsOf(fs, id as InodeId)[0];
    if (path === undefined) return fail('chmod', `no directory entry names inode ${id}.`, 'ENOENT');
    // Issued as the running process, else init (callerPid rule in Shell.ts).
    const caller = callerPid(ctx.host);
    const result = ctx.host.sink.dispatch({ kind: 'syscall', request: { name: 'chmod', pid: caller, args: [path, bits] } }, { source: 'terminal', line: ctx.line });
    if (!result.ok) return fail('chmod', `the command bus refused the call: ${result.message}.`);
    if (result.syscall === undefined) return fail('chmod', 'the command bus returned no result for the call.');
    if (!result.syscall.ok) return fail(result.syscall.errno, `chmod ${path} ${bits}: ${result.syscall.errno} (${result.syscall.message}).`, result.syscall.errno);
    return ok([`chmod ${path} (inode ${id}) ${bits} issued by P${caller}`]);
  },
};

export const SECURITY_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['access', accessHandler], ['ring', ringHandler], ['audit', auditHandler], ['chmod', chmodHandler],
]);
