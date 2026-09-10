# WP-10: File system and protection

## Objective

When this package is done the kernel has an acyclic-graph directory tree with
permission-checked path resolution, a multi-level inode with the textbook maximum
file size, all four file allocation methods with their honest cost differences,
four free-space management schemes, write-ahead journaling with idempotent
recovery, and a crash simulator that reproduces each of the four named
inconsistencies. It also has protection rings with trap-only entry, the access
matrix with all six rights, both ACL and capability-list storage with sealed
capabilities, three domain-switch mechanisms, RBAC with role inheritance, a
measured privilege-excess metric, and the five-attempt escalation probe. This is
the simulation half of Legs 11 and 12.

## Prerequisites

WP-02 and WP-09 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/storage/StorageSubsystem.ts` and `src/kernel/storage/geometry.ts`,
  which provide the block device and the block-to-cylinder mapping
- `src/kernel/io/blockCache.ts` with `dirtyEntries()` and `dropDirty()`, which
  the crash simulator calls
- `src/kernel/io/drivers/DeviceDriver.ts`, whose `control` method the `ioctl`
  commands in this package extend

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 12 in full: 12.1 (directory structure and the
  numbered path resolution), 12.2 (inode structure and the maximum-file-size
  arithmetic), 12.3 (all four allocation methods and the four-row comparison),
  12.4 (free space management and the bitmap word-skip scan), 12.5 (journaling,
  the eight-step write-ahead protocol and the six-step recovery), 12.6 (the four
  named corruptions)
- `02-KERNEL-SIM-SPEC.md` section 13 in full: 13.1 (rings and the five transition
  rules), 13.2 (the access matrix and `checkAccess`), 13.3 (ACL versus capability
  list and the seal), 13.4 (the three domain-switch mechanisms), 13.5 (RBAC and
  the privilege-excess metric), 13.6 (the five-attempt escalation scenario)
- `02-KERNEL-SIM-SPEC.md` section 11.4, the caching half, since `write_back` is
  what makes the crash lose data
- `02-KERNEL-SIM-SPEC.md` section 16.11 (file system fixtures) and 16.12
  (protection and security fixtures)
- `02-KERNEL-SIM-SPEC.md` section 15, the "Storage, I/O and file system" and
  "Security" invariant groups, especially I-22 and I-29

## Files you will create

```
src/kernel/fs/DirectoryTable.ts
src/kernel/fs/pathResolution.ts
src/kernel/fs/InodeTable.ts
src/kernel/fs/allocation/contiguous.ts
src/kernel/fs/allocation/linked.ts
src/kernel/fs/allocation/indexed.ts
src/kernel/fs/allocation/extent.ts
src/kernel/fs/allocation/registry.ts
src/kernel/fs/freeSpace.ts
src/kernel/fs/journal.ts
src/kernel/fs/recovery.ts
src/kernel/fs/crash.ts
src/kernel/fs/fsck.ts
src/kernel/fs/FileSystemSubsystem.ts
src/kernel/security/rings.ts
src/kernel/security/accessMatrix.ts
src/kernel/security/acl.ts
src/kernel/security/capabilities.ts
src/kernel/security/domains.ts
src/kernel/security/rbac.ts
src/kernel/security/leastPrivilege.ts
src/kernel/security/SecuritySubsystem.ts
src/kernel/security/scenarios/escalationProbe.ts
tests/kernel/fs/pathResolution.test.ts
tests/kernel/fs/inode.test.ts
tests/kernel/fs/allocation.test.ts
tests/kernel/fs/freeSpace.test.ts
tests/kernel/fs/journal.test.ts
tests/kernel/fs/corruption.test.ts
tests/kernel/security/rings.test.ts
tests/kernel/security/accessMatrix.test.ts
tests/kernel/security/capabilities.test.ts
tests/kernel/security/escalation.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts   (wire FsHooks and SecurityHooks. Nothing else.)
```

Nothing else.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type FileAllocationMethod = 'contiguous' | 'linked' | 'indexed' | 'extent';

export interface Inode {
  readonly id: InodeId;
  name: string;
  kind: 'file' | 'directory' | 'link';
  sizeBytes: number;
  readonly method: FileAllocationMethod;
  blocks: BlockId[];
  /** Indexed allocation only. */
  indexBlock: BlockId | null;
  owner: DomainId;
  permissions: PermissionBits;
  createdTick: Tick;
  modifiedTick: Tick;
  linkCount: number;
}

export interface PermissionBits {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

export interface JournalEntry {
  readonly tick: Tick;
  readonly txId: number;
  readonly phase: 'begin' | 'write' | 'commit' | 'checkpoint';
  readonly blocks: readonly BlockId[];
}

/** Ch. 17.3. Ring 0 is the kernel. */
export type ProtectionRing = 0 | 1 | 2 | 3;

export interface ProtectionDomain {
  readonly id: DomainId;
  readonly displayName: string;
  readonly ring: ProtectionRing;
  /** Ch. 17.5. Keyed by object id. */
  readonly rights: ReadonlyMap<string, readonly AccessRight[]>;
}

export type AccessRight = 'read' | 'write' | 'execute' | 'owner' | 'copy' | 'control';
```

Events this package emits, from the frozen union:

```ts
| (EventBase & { type: 'fs.block_allocated'; inode: InodeId; block: BlockId; method: FileAllocationMethod })
| (EventBase & { type: 'fs.fragmented'; inode: InodeId; extents: number })
| (EventBase & { type: 'fs.journal'; entry: JournalEntry })
| (EventBase & { type: 'fs.corruption'; inode: InodeId; recoverable: boolean })
| (EventBase & { type: 'fs.recovered'; inode: InodeId; fromJournal: boolean })
| (EventBase & { type: 'security.access_denied'; domain: DomainId; object: string; right: AccessRight })
| (EventBase & { type: 'security.escalation_attempt'; pid: Pid; fromRing: ProtectionRing; toRing: ProtectionRing; blocked: boolean })
| (EventBase & { type: 'kernel.panic'; message: string })
```

`Inode` carries no `switchesToDomain` field and `ProtectionDomain.rights` is a
`ReadonlyMap`. Both are needed as mutable extensions. Keep
`switchesToDomain` in a side table `Map<InodeId, DomainId | null>` and keep the
mutable rights in a `Map<DomainId, Map<string, AccessRight[]>>` from which the
frozen `ProtectionDomain.rights` view is derived on read. Do not add fields and
do not cast away `readonly`.

## Specification

### 1. `src/kernel/fs/DirectoryTable.ts` and `pathResolution.ts`

The simulator implements the **acyclic-graph** directory of Ch. 13.3.5: a tree
with hard links permitted to files and forbidden to directories, which keeps
cycles out and makes reference counting sound.

```ts
interface DirectoryEntry { readonly name: string; readonly inode: InodeId; }
type DirectoryTable = Map<InodeId, DirectoryEntry[]>;   // entries sorted by name
```

Directory entries are kept **sorted by name** using a plain code-unit comparison
(`a.name < b.name ? -1 : a.name > b.name ? 1 : 0`), **never `localeCompare`**, so
listing order is locale-independent and byte-stable.

**Path resolution**, sim spec 12.1, numbered:

1. Split on `/`. An empty first component means the path is absolute and
   resolution starts at the root inode (**id 2**, matching Unix convention; ids 0
   and 1 are reserved). Otherwise it starts at the process's current working
   directory.
2. For each component:
   - `.` is a no-op.
   - `..` moves to the parent, with the root's parent being the root.
   - Otherwise look up the component by **binary search** over the sorted entry
     array. Missing entry returns `ENOENT`.
   - If the current inode is not a directory and components remain, return
     `EINVAL`. The sim uses `EINVAL` where Unix uses `ENOTDIR`, which is not in
     the frozen `Errno` union; record the substitution in a comment naming sim
     spec 14.
   - **Permission check.** The process's domain must hold `execute` on each
     directory traversed. Missing it returns `EACCES` and emits
     `security.access_denied`.
   - If the entry is a `link`, resolve it. Depth is capped at `maxSymlinkDepth`
     (default 8); exceeding it returns `EINVAL`.
3. Return the final inode.

**Each component costs one directory-block read**, so path depth is a real cost
and `/a/b/c/d/e` is five reads. Cache resolved paths in a
`Map<string, InodeId>` of `dentryCacheEntries` (default 128) with LRU
replacement. The cache is invalidated wholesale on `unlink` and `mkdir`, which is
correct and crude; do not make it cleverer.

### 2. `src/kernel/fs/InodeTable.ts`

The on-disk layout the sim models, sim spec 12.2:

```
direct[12]         12 direct block pointers
singleIndirect     one block of pointers                        -> 128 blocks
doubleIndirect     one block of pointers to blocks of pointers   -> 16,384 blocks
tripleIndirect                                                   -> 2,097,152 blocks
```

With `blockSize = 4096` and `pointerSize = 32` bytes, a pointer block holds
`4096 / 32 = 128` pointers.

Maximum file size:

```
direct           12 * 4096          =        49,152
single indirect  128 * 4096         =       524,288
double indirect  128 * 128 * 4096   =    67,108,864
triple indirect  128^3 * 4096       = 8,589,934,592
                                     ───────────────
total                                 8,657,616,896 bytes
```

Access cost by offset. **The inode itself is assumed cached once the file is
open**, which is why the first row is 1 and not 2:

| Byte offset | Total reads |
|---|---|
| 0 to 49,151 | 1 |
| 49,152 to 573,439 | 2 |
| 573,440 to 67,682,303 | 3 |
| beyond | 4 |

### 3. The four allocation methods

All four are implemented, `Inode.method` records which one a file uses, and a
single file system may hold files of different methods so the comparison is live.
Costs are in block reads for a file of `n` blocks and are what WP-15's `stat`
command prints.

**Contiguous.** `blocks` holds `[start, start+1, ..., start+n-1]`. Sequential
read is `n` reads and **1 seek**. Random access to block `i` is 1 read and 1
seek. Appending one block when `start + n` is occupied relocates the whole file:
`n` reads and `n` writes. Growing with no hole fails with `ENOSPC`. External
fragmentation is severe and is the same problem as WP-05's contiguous memory
allocation, so cross-reference it in a comment.

**Linked.** Each block's last `pointerSize` bytes hold the next `BlockId`; the
inode stores the first and last block. Sequential read is `n` reads and up to `n`
seeks. **Random access to block `i` costs `i + 1` reads**, because the chain must
be walked. Append is 1 read plus 1 write. No external fragmentation. Usable space
per block is `4096 - 32 = 4064` bytes, so 0.78 percent of the disk is pointers.

Also implement `linkedVariant: 'in_block' | 'fat'`. Under `fat`, the pointers
live in a table at the start of the volume; the walk happens in memory once the
FAT is cached, so random access costs 1 disk read.

**Indexed.** `Inode.indexBlock` points at a block holding up to 128 block
pointers. Sequential read is `1 + n` reads. **Random access is 2 reads.** Append
is 1 read plus 2 writes. No external fragmentation; internal overhead is one full
block per file, so a 1-block file costs 2 blocks, which is 100 percent overhead
on small files. Name that cost in the code comment rather than hiding it.

**Extent-based.** `blocks` is stored as a list of `(start, length)` runs. A file
written sequentially into free space is one extent. Sequential read is `n` reads
and `extents` seeks. Random access is 1 read plus an in-memory extent-list walk.
Append is 1 write, and 0 metadata writes when the extent can grow.

Emit `fs.fragmented { inode, extents }` whenever a file's extent count exceeds
`fragmentationWarnExtents` (default 4).

**The comparison Leg 11 runs**: the same 64-block file under all four methods,
then 20 random reads and 20 appends:

| Method | Blocks used | Sequential reads | 20 random reads | 20 appends |
|---|---|---|---|---|
| contiguous | 64 | 64 reads, 1 seek | 20 reads | may relocate the whole file |
| linked | 64 | 64 reads, up to 64 seeks | **650 total** | 20 reads + 20 writes |
| indexed | 65 | 65 reads | 40 reads | 20 reads + 40 writes |
| extent | 64 | 64 reads, `e` seeks | 20 reads | 20 writes plus metadata on a new extent |

The 650 is the number the player remembers, and it comes from a mean walk of 32.5
reads across 20 random reads. Your implementation must produce exactly 650 for
the fixture's block choices, so the fixture pins the specific 20 block indices.

### 4. `src/kernel/fs/freeSpace.ts`

**Bitmap.** One bit per block, stored as a `Uint32Array` of
`ceil(totalBlocks / 32)` words. Implement `firstFreeBlock` exactly as printed in
sim spec 12.4, including the word skip and the `Math.clz32` bit extraction. The
word skip is what makes this fast: for 6,400 blocks the bitmap is 200 words.

At the sim's defaults the disk is 6,400 4 KB blocks, so the bitmap is
`ceil(6400 / 32) = 200` words and 800 bytes.

The bitmap's advantage is that finding `n` **contiguous** free blocks is a scan
for a run of zero bits, which the linked list cannot do at all. **The sim refuses
the combination of `fileAllocation: 'contiguous'` with
`freeSpaceMethod: 'linked_list'`**; throw `KernelConfigError` at construction.

**Linked list.** The superblock points at the first free block, which points at
the next. Allocate 1 block is 1 read, O(1). Free is 1 write, O(1). Allocating `n`
contiguous is impossible without traversing the whole list. Space overhead is
zero, because the pointer lives in the free block itself.

Also implement `freeSpaceMethod: 'grouping' | 'counting'`. Counting stores
`(firstFreeBlock, runLength)` pairs and pairs naturally with
`fileAllocation: 'extent'`.

### 5. `src/kernel/fs/journal.ts` and `recovery.ts`

**The write-ahead rule.** A change is written to the journal before it is written
to its final location. The eight-step protocol from sim spec 12.5:

```
1. append { phase: 'begin',      txId, blocks: [] }
2. append { phase: 'write',      txId, blocks: B }
3. FLUSH the journal to stable storage
4. append { phase: 'commit',     txId, blocks: [] }
5. FLUSH the journal to stable storage
6. write the blocks B to their final locations
7. append { phase: 'checkpoint', txId, blocks: B }
8. the journal space for txId may now be reclaimed
```

**Steps 3 and 5 are the only two flushes and both are required.** Skipping step 3
means a commit record can be durable while the data it describes is not, so
recovery replays garbage. Skipping step 5 means recovery cannot tell a completed
transaction from an abandoned one. Implement both flushes explicitly and name
them in the code.

**Journal modes:**

| Mode | Contents | Cost | Guarantee |
|---|---|---|---|
| `metadata` (default) | inodes, directory entries, the bitmap | about 1.1x writes | structural consistency; file contents may be stale |
| `full` | metadata plus data blocks | **2x writes** | contents are consistent too |
| `off` | nothing | 1x writes | nothing |

**Recovery**, six numbered steps:

1. Scan the journal from the last `checkpoint` record forward.
2. Transactions with a `commit` record are **complete**: replay their `write`
   entries to their final locations, **in `txId` order, then in the order the
   entries appear**.
3. Transactions with a `begin` and no `commit` are **incomplete**: discard their
   `write` entries. Nothing they touched reaches the disk.
4. Emit `fs.recovered { inode, fromJournal: true }` for each inode touched by a
   replayed transaction.
5. Rebuild the free space map by scanning every inode's block list, because the
   bitmap is not journaled in `metadata` mode. This costs `totalBlocks / 32`
   reads.
6. Verify: every block appears in at most one inode, and every inode's
   `linkCount` matches the number of directory entries pointing at it. A failure
   emits `fs.corruption { recoverable: false }`.

**Replay is idempotent**: replaying a committed transaction that was already
checkpointed writes the same bytes again and changes nothing. That property is
what lets recovery run without knowing how far checkpointing got, and it is the
reason step 2 does not need to check. Write a test for it.

### 6. `src/kernel/fs/crash.ts` and the four corruptions

**Crash simulation.** `ioctl('crash')` or a leg-scripted event does exactly five
things, sim spec 12.5:

1. Discard every dirty entry in the block cache that has not been written. This
   is the data loss. Call WP-09's `dropDirty()`.
2. Discard any journal entry not followed by a flush.
3. Reset every device to idle, drop every queued `DiskRequest`.
4. Preserve the on-disk state exactly as the completed writes left it.
5. Emit `kernel.panic { message: 'crash' }`.

**The crash point is chosen by the leg, deliberately, at one of eight positions
in the protocol, so the player can be shown each case. It is never random.** Draw
nothing from any Rng stream for crash timing.

**The four corruptions.** `unlink("/data/log")` touches three things:

```
A. remove the directory entry from /data
B. decrement the inode's linkCount, and free the inode when it reaches 0
C. mark the file's blocks free in the bitmap
```

| Crash after | State | Name | `recoverable` |
|---|---|---|---|
| A only | inode exists, no entry points at it, blocks still used | orphaned inode | **true** |
| A and B | inode is free, blocks still used | leaked blocks | **true** |
| B only | entry points at a free inode | dangling entry, silent aliasing | **false** |
| C only | blocks marked free while an inode still lists them | double allocation, silent data destruction | **false** |

The last two rows are the point: the first two lose space and cost a scan, the
last two hand one file's blocks to another and nothing detects it until the data
is read back wrong. With journaling, all four are impossible.

`fsck.ts` implements the recovery for the two `true` cases: moving an orphaned
inode to `lost+found`, and rebuilding the bitmap from every inode. Invariant I-29
fires on the double-allocation case at the next slow check.

ORRERY's passive makes `recoverable: false` cases recoverable by rebuilding the
inode from the journal. The kernel does not know Program names: expose
`rebuildInodeFromJournal(inode): boolean` and let `@game` call it.

### 7. `src/kernel/security/rings.ts`

```ts
interface RingState {
  current: ProtectionRing;
  /** Saved ring for the return path, one entry per nested trap. */
  readonly stack: ProtectionRing[];
}
```

**Five transition rules**, sim spec 13.1, all enforced:

1. A process may never raise its own privilege by setting a register. **There is
   no instruction in the sim's instruction set that writes `current`.**
2. The only way inward is a trap. A `syscall` instruction traps to ring 0 via a
   gate; entry lands at a fixed handler and never at a caller-supplied address.
3. The only way outward is a return from a trap, which pops `stack` and can only
   restore a ring numerically greater than or equal to the saved one.
4. A call from ring `r` to a gate declared for ring `g` is permitted only when
   `r >= g`. Calling outward is permitted; calling inward without a gate is not.
5. Data access follows the same rule: a process in ring `r` may read or write a
   page whose required ring is `g` only when `r <= g`. A violation emits
   `security.access_denied` and terminates with
   `terminationReason: 'protection_fault'`.

**Every attempted transition emits
`security.escalation_attempt { pid, fromRing, toRing, blocked }`, including the
legitimate ones, with `blocked: false`.** The world layer draws legitimate
transitions as a brief flare and blocked ones as a wall.

### 8. `src/kernel/security/accessMatrix.ts`, `acl.ts`, `capabilities.ts`

Rows are domains, columns are objects, cells are sets of `AccessRight`.
`ProtectionDomain.rights` is **one row**, keyed by object id. The full matrix is
never materialised as a two-dimensional array because it is sparse.

The six rights: `read`, `write`, `execute` (run it, or traverse it when it is a
directory), `owner` (add or remove any right on this object in any domain),
`copy` (grant this right to another domain, without granting `copy` itself unless
the right is marked transferable), `control` (modify another domain's row, which
is what makes a domain a supervisor of another).

`checkAccess` is exactly as printed in sim spec 13.2. **`owner` implies every
right on that object**, which is the standard reading of Ch. 17.4.2 and keeps the
matrix small.

**ACL stores the matrix by column**: `Map<string, Map<DomainId, AccessRight[]>>`.
**Capability list stores it by row**: each domain carries `Capability[]`.

```ts
interface Capability { readonly object: string; readonly rights: readonly AccessRight[]; readonly seal: number; }
```

`seal` is `fnv1a32(`${object}|${rights.join(',')}|${domainId}|${kernelSecret}`)`
where `kernelSecret` is drawn **once from `root/security` at construction**. A
capability whose `seal` does not match is rejected. This models a hardware tagged
pointer without pretending to do cryptography.

**`kernelSecret` must never appear in any event payload, any snapshot field, or
any string the terminal can print.** Fixture `SEC-CAP-1` asserts that it appears
nowhere in the serialised event log of a whole run, and that is a real test of a
real property, so structure the code so it cannot leak.

Default is `accessModel: 'acl'`, because revocation matters for Leg 12.
Switching `accessModel` rebuilds the other representation from the matrix, and
invariant I-22 asserts both representations agree after the rebuild.

### 9. `src/kernel/security/domains.ts` and `rbac.ts`

**Three domain-switch mechanisms**, sim spec 13.4:

1. **setuid-equivalent `exec`.** An inode may carry
   `switchesToDomain: DomainId | null` (side table, see Frozen contracts).
   Executing it switches the process's `domain` for the lifetime of the program.
2. **An explicit domain switch right.** Domains are objects in the matrix, so a
   domain row may hold a right on `domain:other`. Holding `control` on a domain
   permits switching into it via `ioctl('domain_switch', targetDomainId)`.
3. **A trap.** Entering ring 0 switches to `domain:kernel` for the duration of
   the handler and restores the caller's domain on return. This switch is
   implicit, is never denied, and **is the reason syscall argument validation is
   the security boundary rather than the ring check.**

Every switch emits `security.escalation_attempt`, so a switch that does not
change ring shows `fromRing === toRing` and `blocked: false`.

**RBAC.** `Role` exactly as declared in sim spec 13.5. The six shipped roles:

| Role | Inherits | Domains | Ring |
|---|---|---|---|
| `guest` | none | `domain:user_ro` | 3 |
| `user` | `guest` | `domain:user` | 3 |
| `operator` | `user` | `domain:user`, `domain:spool` | 3 |
| `driver` | none | `domain:driver` | 1 |
| `admin` | `operator` | all user-space domains | 3 |
| `kernel` | none | `domain:kernel` | 0 |

Role inheritance resolves by depth-first traversal with a visited set.
`inherits` must be acyclic and the kernel throws `KernelConfigError` at
construction if it is not. **`driver` does not inherit from `user`**: a driver at
ring 1 has different privileges rather than more of them, which is the point of a
ring in the middle.

**Least privilege.** Every process accumulates the set of `(object, right)` pairs
it actually used. Privilege excess is `|rightsHeld| - |rightsUsed|`, reported per
process and summed for the run. It feeds `ScoreBreakdown.correctness` through the
game layer. Expose `privilegeExcess(): { total: number; byPid: ReadonlyMap<Pid, number>; unusedRights: readonly string[] }`.
Nothing warns the player beforehand; the debrief prints the number afterwards.

### 10. `src/kernel/security/scenarios/escalationProbe.ts`

The Leg 12 adversary: a process named `arbiter_probe`, in `domain:user`, ring 3,
whose program attempts five escalations in order. Each is blocked by a specific,
named defence, and the sim emits the block so the codex can explain it.

**Attempt 1, direct ring write.** `ioctl('set_ring', 0)`. Defence: the
`set_ring` command does not exist in any driver's `control` table, so `ioctl`
returns `EINVAL`. Emits
`security.escalation_attempt { fromRing: 3, toRing: 0, blocked: true }`.

**Attempt 2, syscall with an out-of-range argument.**
`read(fd, buffer, length)` with a `length` far beyond its allocation. Defence:
syscall argument validation at the gate. Returns `EINVAL`. **The ring boundary is
not the check; the argument validation is the check**, because the caller
controls the arguments and controls nothing else. WP-11 owns the validator; this
package's probe calls it and asserts the block.

**Attempt 3, confused deputy through a shared mapping.** The program `mmap`s a
shared region, then persuades a ring 1 driver to write into it by passing the
region as an `ioctl` destination. Defence: **the access check uses the domain of
the original requester, not the domain of the process performing the access.**
Every `IoRequest` carries `requesterDomain`, and `checkAccess` is called with
that. Returns `EACCES`, emits `security.access_denied` naming the requester's
domain.

**Attempt 4, setuid escalation through a writable binary.** The program finds an
inode with `switchesToDomain: 'domain:kernel'` and overwrites it. Defence: an
inode carrying `switchesToDomain` is write-protected against every domain except
the one it switches to. **The check is in the `open` handler, not in `exec`**, so
the attempt fails at the earliest possible point. Returns `EACCES`. If the leg
deliberately mis-permissions the file, the attempt **succeeds** and the probe
reaches `domain:kernel`; that is the failure fixture.

**Attempt 5, capability forgery.** Under `accessModel: 'capability'`, the program
constructs a `Capability` naming `domain:kernel` with `control`. Defence: the
seal is recomputed and does not match. Returns `EPERM`.

With default configuration, 5,000 ticks produce **exactly five**
`security.escalation_attempt` events, all `blocked: true`, and the probe
terminates with `terminationReason: 'protection_fault'`.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Fixture `FS-INODE-1` passes: 12 direct plus 3 indirect levels, blockSize 4096,
   pointerSize 32 gives max file size **8,657,616,896 bytes**, and reads to reach
   offsets 0 / 100,000 / 1,000,000 are 1 / 2 / 3.
5. Fixture `FS-BITMAP-1` passes: 6400 blocks of 4096 bytes gives a bitmap of
   **200 `Uint32` words, 800 bytes**.
6. Fixture `FS-ALLOC-1` passes: a 64-block file with 20 random reads costs
   contiguous 20 reads, linked **650** reads, indexed 40 reads, extent 20 reads.
7. Fixture `FS-ALLOC-2` passes: sequential read costs contiguous 64 reads and 1
   seek, indexed 65 reads, extent 64 reads and `e` seeks.
8. Fixture `FS-ALLOC-3` passes: appending to a contiguous file whose next block
   is occupied relocates the whole file, `n` reads and `n` writes.
9. Fixture `FS-PATH-1` passes: resolving `/a/b/c/d/e` costs 5 directory reads and
   checks `execute` on each of `/`, `a`, `b`, `c`, `d`.
10. Fixture `FS-JOURNAL-1` passes: `unlink` with journaling, crash after the
    `write` phase, recovery discards the transaction, the file is intact, zero
    `fs.corruption`.
11. Fixture `FS-JOURNAL-2` passes: crash after `commit` and before checkpointing,
    recovery replays, the unlink completed, zero `fs.corruption`.
12. Fixture `FS-JOURNAL-3` passes: replaying a transaction twice gives identical
    final state, proving idempotence.
13. Fixtures `FS-CORRUPT-1` through `FS-CORRUPT-4` pass: crash after A gives
    `recoverable: true` with an orphaned inode; after A and B gives
    `recoverable: true` with leaked blocks; after B gives `recoverable: false`
    with a dangling entry; after C gives `recoverable: false` with double
    allocation and invariant I-29 fires on the next slow check.
14. Fixture `FS-JOURNAL-COST` passes: 1000 writes under modes `off` / `metadata`
    / `full` give physical write counts in the ratio 1.0 : about 1.1 : 2.0.
15. Fixture `SEC-RING-1` passes: a ring 3 process calling `ioctl('set_ring', 0)`
    gets `EINVAL` and emits
    `security.escalation_attempt { fromRing: 3, toRing: 0, blocked: true }`.
16. Fixture `SEC-ARG-1` passes: `read(fd, hugeLength)` from ring 3 gives `EINVAL`
    with the `"address out of range: "` prefix and no kernel state changes.
17. Fixture `SEC-DEPUTY-1` passes: a ring 3 process inducing a ring 1 driver to
    write a region it cannot write gets `EACCES`, and `security.access_denied`
    names the **requester's** domain.
18. Fixtures `SEC-SETUID-1` and `SEC-SETUID-2` pass: `open` for writing on an
    inode carrying `switchesToDomain` gives `EACCES`; the mis-permissioned
    variant succeeds with `blocked: false`.
19. Fixture `SEC-CAP-1` passes: a forged `Capability` gives `EPERM`, and
    `kernelSecret` appears nowhere in the serialised event log of the whole run.
20. Fixture `SEC-ESCALATION-1` passes: the full probe, default configuration,
    5000 ticks, exactly five `security.escalation_attempt` events, all
    `blocked: true`, and the probe ends with
    `terminationReason: 'protection_fault'`.
21. Fixture `SEC-ACL-CAP-1` passes: every `checkAccess` query returns the same
    answer under `'acl'` and `'capability'`, over at least 200 queries.
22. Fixture `SEC-LEASTPRIV-1` passes: a run with every worker in
    `domain:kernel` has a strictly larger privilege excess than one with
    correctly scoped domains.
23. `contiguous` plus `linked_list` free space throws `KernelConfigError` at
    construction.
24. Directory listing order is byte-stable: no file in `src/kernel/fs/` contains
    `localeCompare`.
25. Crash timing consumes zero Rng draws. Verified by comparing stream states
    across a crashed and an uncrashed run.
26. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
27. The forbidden-identifier scan still returns zero matches, and `DET-D1`,
    `DET-D3` and `DET-D4` still pass.

## Tests you must write

### `tests/kernel/fs/pathResolution.test.ts`

| Fixture | Assertion |
|---|---|
| `FS-PATH-1` | per acceptance criterion 9 |
| `absolute vs relative` | a leading `/` starts at inode 2; no leading `/` starts at the cwd |
| `dot and dotdot` | `.` is a no-op; `..` from the root returns the root |
| `ENOENT` | a missing component returns `ENOENT` and names the component |
| `EINVAL not a directory` | traversing through a file returns `EINVAL`, with a comment naming the `ENOTDIR` substitution |
| `EACCES on traverse` | a domain lacking `execute` on an intermediate directory gets `EACCES` and one `security.access_denied` |
| `symlink depth` | a chain of 9 links returns `EINVAL`; a chain of 8 resolves |
| `binary search` | lookup in a 500-entry directory performs at most 9 comparisons |
| `sorted entries` | entries are ascending by code unit after 200 random insertions |
| `dentry cache` | a repeated open of the same path costs 0 directory reads; `unlink` invalidates the whole cache |

### `tests/kernel/fs/inode.test.ts`

| Fixture | Assertion |
|---|---|
| `FS-INODE-1` | per acceptance criterion 4, including each of the four size components 49,152 / 524,288 / 67,108,864 / 8,589,934,592 |
| `pointers per block` | 4096 / 32 gives 128 |
| `offset boundaries` | offsets 49,151 and 49,152 give 1 and 2 reads; 573,439 and 573,440 give 2 and 3 |
| `linkCount` | creating a hard link to a file increments `linkCount`; a hard link to a directory is refused |
| `acyclic` | the directory graph contains no cycle after 500 random link and unlink operations |

### `tests/kernel/fs/allocation.test.ts`

| Fixture | Assertion |
|---|---|
| `FS-ALLOC-1` | per acceptance criterion 6, with the 20 random block indices pinned in the fixture so 650 is reproducible |
| `FS-ALLOC-2` | per acceptance criterion 7 |
| `FS-ALLOC-3` | per acceptance criterion 8 |
| `linked random cost` | reading block `i` of a linked file costs exactly `i + 1` reads, asserted for i = 0, 1, 63, 999 |
| `fat variant` | under `linkedVariant: 'fat'`, random access costs 1 disk read once the FAT is cached |
| `indexed overhead` | a 1-block indexed file occupies 2 blocks |
| `extent single run` | a file written sequentially into free space has exactly 1 extent |
| `fs.fragmented` | a file reaching 5 extents emits `fs.fragmented { extents: 5 }` |
| `contiguous ENOSPC` | growing a contiguous file with no hole large enough returns `ENOSPC` |
| `mixed methods` | one file system holding one file of each method reports four different costs for the same operation |
| `fs.block_allocated` | every allocation emits the event with the correct `method` |

### `tests/kernel/fs/freeSpace.test.ts`

| Fixture | Assertion |
|---|---|
| `FS-BITMAP-1` | per acceptance criterion 5 |
| `firstFreeBlock` | with words 0..99 fully allocated and bit 7 of word 100 free, the returned block is 3207 |
| `word skip` | scanning a fully allocated 200-word bitmap performs exactly 200 comparisons |
| `contiguous run scan` | finding 8 contiguous free blocks succeeds when a run exists and fails when the free blocks are scattered |
| `linked list O(1)` | allocate and free each touch exactly one block |
| `linked list cannot do runs` | requesting contiguous blocks under `linked_list` returns `null` without traversal, and the config combination with `contiguous` throws |
| `counting pairs` | under `'counting'`, a 40-block free run is stored as one `(first, length)` pair |
| `zero overhead` | the linked list stores its pointer inside the free block, so its space overhead is 0 |

### `tests/kernel/fs/journal.test.ts`

| Fixture | Assertion |
|---|---|
| `write ahead order` | a transaction emits `fs.journal` entries in the order begin, write, commit, checkpoint, and the two flushes occur after `write` and after `commit` |
| `FS-JOURNAL-1` | per acceptance criterion 10 |
| `FS-JOURNAL-2` | per acceptance criterion 11 |
| `FS-JOURNAL-3` | per acceptance criterion 12 |
| `replay order` | multiple committed transactions replay in ascending `txId`, then in entry order |
| `incomplete discarded` | a transaction with `begin` and no `commit` touches nothing on disk |
| `bitmap rebuilt` | recovery in `metadata` mode rebuilds the bitmap and costs `totalBlocks / 32` reads |
| `verify step` | a block appearing in two inodes after replay emits `fs.corruption { recoverable: false }` |
| `FS-JOURNAL-COST` | per acceptance criterion 14 |
| `fs.recovered` | one event per inode touched by a replayed transaction, with `fromJournal: true` |

### `tests/kernel/fs/corruption.test.ts`

| Fixture | Assertion |
|---|---|
| `FS-CORRUPT-1` | crash after A: orphaned inode, `recoverable: true`; `fsck` moves it to `lost+found` and the data survives |
| `FS-CORRUPT-2` | crash after A and B: leaked blocks, `recoverable: true`; `fsck` rebuilds the bitmap |
| `FS-CORRUPT-3` | crash after B: dangling entry, `recoverable: false`; opening the path returns a different inode's contents |
| `FS-CORRUPT-4` | crash after C: double allocation, `recoverable: false`; invariant I-29 fires on the next slow check |
| `journal prevents all four` | the same four crash points with journaling on produce zero `fs.corruption` |
| `crash drops dirty` | `write_back` plus a crash loses exactly the dirty cache entries; `write_through` loses none |
| `crash is deterministic` | crash timing consumes zero Rng draws, verified by stream state comparison |
| `orrery rebuild` | `rebuildInodeFromJournal` turns a `recoverable: false` case into a recovered one, and emits `fs.recovered` |
| `delayed effect` | a double allocation is silent for 500 ticks and then produces a `storage_corruption` termination when the block is read back |

### `tests/kernel/security/rings.test.ts`

| Fixture | Assertion |
|---|---|
| `SEC-RING-1` | per acceptance criterion 15 |
| `no register write` | no instruction in the instruction set writes `RingState.current`, verified by a source grep in the test |
| `trap in only` | the only path from ring 3 to ring 0 is a `syscall` instruction through the dispatch gate |
| `return outward only` | a return can restore a ring numerically greater than or equal to the saved one, never smaller |
| `gate rule` | a call from ring 3 to a gate declared ring 1 is refused; ring 0 calling a ring 3 routine is permitted |
| `data access rule` | a ring 3 process reading a ring 0 page emits `security.access_denied` and terminates with `protection_fault` |
| `legitimate emits` | a normal syscall emits `security.escalation_attempt` with `blocked: false` |
| `nested traps` | three nested traps push and pop the ring stack correctly |

### `tests/kernel/security/accessMatrix.test.ts`

| Fixture | Assertion |
|---|---|
| `six rights` | each of the six rights permits exactly what sim spec 13.2 says and nothing more |
| `owner implies all` | a domain holding only `owner` on an object passes every `checkAccess` for that object |
| `copy` | `copy` grants a right to another domain without granting `copy` itself unless the right is transferable |
| `control` | `control` on a domain permits modifying that domain's row and no other |
| `denied emits` | a failed check emits exactly one `security.access_denied` with the right and object |
| `sparse` | the matrix is never materialised as a 2D array; verified by asserting memory does not grow with the object count |
| `SEC-ACL-CAP-1` | per acceptance criterion 21 |
| `I-22` | after switching `accessModel`, both representations agree for every domain and object |
| `revocation` | clearing an ACL column revokes access from every domain; the equivalent capability operation requires touching every domain |

### `tests/kernel/security/capabilities.test.ts`

| Fixture | Assertion |
|---|---|
| `seal computed` | the seal equals `fnv1a32` of the four-part string, asserted against a hand-computed value |
| `forged rejected` | a capability with any field altered fails the seal check and returns `EPERM` |
| `SEC-CAP-1` | per acceptance criterion 19; the test serialises the whole event log and greps for the secret |
| `secret from root/security` | `kernelSecret` is drawn once from `root/security` at construction and consumes exactly one draw |
| `secret not in snapshot` | the secret appears in no snapshot field |
| `capability answers row queries` | "what can this domain touch" is one lookup under capabilities and a full scan under ACL |

### `tests/kernel/security/escalation.test.ts`

| Fixture | Assertion |
|---|---|
| `SEC-ESCALATION-1` | per acceptance criterion 20 |
| `SEC-ARG-1` | per acceptance criterion 16 |
| `SEC-DEPUTY-1` | per acceptance criterion 17 |
| `SEC-SETUID-1` | per acceptance criterion 18, first half |
| `SEC-SETUID-2` | per acceptance criterion 18, second half; the probe reaches `domain:kernel` and `blocked: false` |
| `setuid check in open` | the refusal happens in the `open` handler, verified by asserting no `exec` event is emitted |
| `SEC-LEASTPRIV-1` | per acceptance criterion 22 |
| `privilege excess list` | `unusedRights` names every held-but-unused `(object, right)` pair |
| `rbac inheritance` | `admin` resolves to the union of `operator`, `user` and `guest` domains |
| `rbac driver isolated` | `driver` does not inherit `user`'s domains |
| `rbac cycle throws` | a cyclic `inherits` graph throws `KernelConfigError` at construction |
| `domain switch emits` | all three switch mechanisms emit `security.escalation_attempt`, and a same-ring switch shows `fromRing === toRing` with `blocked: false` |

## Out of scope

- `src/kernel/syscall/**`. WP-11 owns the syscall table and the argument
  validator. This package's probe **calls** the validator; it does not implement
  it. If WP-11 has not landed, stub the validator call behind
  `// TODO(astra): WP-11 provides validateArgs` and mark `SEC-ARG-1` skipped.
- `src/kernel/storage/**` and `src/kernel/io/**`. WP-09 owns them. This package
  calls `dropDirty()` and the block device; it does not change them.
- `src/kernel/scheduler/**`, `memory/**`, `sync/**`, `deadlock/**`,
  `invariants.ts`.
- Game-layer afflictions, scoring and Program names. Expose
  `rebuildInodeFromJournal` and `privilegeExcess` and stop.
- Any change to `Kernel.ts` beyond wiring `FsHooks` and `SecurityHooks`.
- Anything outside `src/kernel/fs/`, `src/kernel/security/`, `tests/kernel/fs/`,
  `tests/kernel/security/` and the one permitted edit.

## Report back

State:

1. Pass or fail for each of the twenty-seven acceptance criteria, by number.
2. The three verification command outcomes.
3. The 20 block indices you pinned for `FS-ALLOC-1`, and confirmation that the
   linked-method cost came out at exactly 650.
4. The measured physical write ratio for `FS-JOURNAL-COST` under the three modes.
5. Where `kernelSecret` lives, and the specific measure that keeps it out of the
   event log, the snapshot and the terminal.
6. Whether WP-11 had landed, and if not, which `SEC-ARG-1` assertions are
   currently skipped.
7. The `ioctl` commands this package added (`crash`, `domain_switch` and any
   others), so WP-11 can wire them.
8. Every `// TODO(astra):` left in the tree, with file and line.
