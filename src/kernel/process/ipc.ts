import { KernelInvariantError } from '../errors';
import { asPageId, asResourceId } from '../types';
import type {
  AccessRight,
  AddressSpaceId,
  BlockReason,
  Frame,
  FrameId,
  IpcSnapshot,
  PageId,
  PageTableEntry,
  Pid,
  ProcessControlBlock,
  ResourceId,
  SyscallResult,
  Tick,
} from '../types';

export interface SharedRegion {
  readonly id: ResourceId;
  readonly pages: readonly PageId[];
  readonly space: AddressSpaceId;
  attached: Pid[];
  /** The single integer the region holds, for the race detector in section 8.6. */
  value: number;
}

export interface Mailbox {
  readonly id: ResourceId;
  readonly capacity: number;
  queue: Message[];
  sendWaiters: Pid[];
  recvWaiters: Pid[];
}

export interface Message {
  readonly from: Pid;
  readonly tick: Tick;
  readonly payload: number;
}

export interface SharedMapping {
  readonly region: ResourceId;
  readonly space: AddressSpaceId;
  readonly page: PageId;
  readonly backingSpace: AddressSpaceId;
  readonly backingPage: PageId;
}

export interface IpcHooks {
  readonly process: (pid: Pid) => ProcessControlBlock | undefined;
  readonly pageTable: (space: AddressSpaceId) => PageTableEntry[];
  readonly frame: (id: FrameId) => Frame | undefined;
  readonly rights: (pid: Pid, region: ResourceId) => readonly AccessRight[];
  readonly onAccessDenied?: (pid: Pid, region: ResourceId, right: 'read' | 'write') => void;
  readonly block: (pid: Pid, reason: BlockReason) => void;
  readonly onSharedMap?: (pid: Pid, mapping: SharedMapping) => void;
  readonly onSharedUnmap?: (pid: Pid, mapping: SharedMapping) => void;
}

interface RegionMapping {
  readonly space: AddressSpaceId;
  readonly pages: readonly PageId[];
}

type PendingOperation =
  | { readonly kind: 'send'; readonly mailbox: ResourceId; readonly message: Message }
  | { readonly kind: 'recv'; readonly mailbox: ResourceId };

const completed: SyscallResult = Object.freeze({ ok: true, value: null });

/** Owns IPC state; process transitions and protection decisions stay with their owners. */
export class IpcManager {
  private readonly regions = new Map<ResourceId, SharedRegion>();
  private readonly regionOrder: ResourceId[] = [];
  private readonly mappings = new Map<ResourceId, Map<Pid, RegionMapping>>();
  private readonly mailboxes = new Map<ResourceId, Mailbox>();
  private readonly mailboxOrder: ResourceId[] = [];
  private readonly pending = new Map<Pid, PendingOperation>();
  private readonly completions = new Map<Pid, SyscallResult>();
  private readonly completedWaits = new Map<Pid, ResourceId>();
  private readonly originalPins = new Map<FrameId, boolean>();

  constructor(private readonly hooks: IpcHooks) {}

  get hasState(): boolean { return this.regions.size > 0 || this.mailboxes.size > 0; }

  /** Detached, deterministically ordered copies of every IPC table (WP-11, amendment 14). */
  snapshotContribution(): IpcSnapshot {
    const byPid = (a: Pid, b: Pid): number => a - b;
    const sharedRegions = this.regionOrder.map(id => {
      const region = this.requireRegion(id);
      const attachments = [...(this.mappings.get(id) ?? new Map<Pid, RegionMapping>())].sort(([a], [b]) => byPid(a, b))
        .map(([pid, mapping]) => ({ pid, space: mapping.space, pages: [...mapping.pages] }));
      const sourceTable = this.hooks.pageTable(region.space);
      const frames: FrameId[] = [];
      for (const page of region.pages) {
        const entry = sourceTable.find(row => row.page === page);
        if (entry?.valid === true && entry.frame !== null) frames.push(entry.frame);
      }
      return { id: region.id as string, frames, attached: attachments.map(row => row.space), value: region.value,
        space: region.space, pages: [...region.pages], attachments };
    });
    const mailboxes = this.mailboxOrder.map(id => {
      const mailbox = this.requireMailbox(id);
      return { id: mailbox.id as string, capacity: mailbox.capacity,
        messages: mailbox.queue.map(message => ({ from: message.from as number, tick: message.tick as number, payload: message.payload })),
        waiters: [...mailbox.sendWaiters, ...mailbox.recvWaiters], sendWaiters: [...mailbox.sendWaiters], recvWaiters: [...mailbox.recvWaiters] };
    });
    const pending = [...this.pending].sort(([a], [b]) => byPid(a, b)).map(([pid, operation]) => ({
      pid, kind: operation.kind, mailbox: operation.mailbox as string,
      message: operation.kind === 'send' ? { from: operation.message.from, tick: operation.message.tick, payload: operation.message.payload } : null,
    }));
    const completions = [...this.completions].sort(([a], [b]) => byPid(a, b)).map(([pid, result]) => ({ pid, result: { ...result } }));
    const completedWaits = [...this.completedWaits].sort(([a], [b]) => byPid(a, b)).map(([pid, resource]) => [pid, resource as string] as const);
    const originalPins = [...this.originalPins].sort(([a], [b]) => a - b).map(([frame, pinned]) => [frame, pinned] as const);
    return { sharedRegions, mailboxes, pending, completions, completedWaits, originalPins };
  }

  /** Replace every IPC table from a contribution. Validation runs before any mutation. */
  restoreContribution(data: IpcSnapshot): void {
    const invalid = (message: string): never => { throw new KernelInvariantError(11, `invalid IPC contribution: ${message}`); };
    const count = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
    const ascendingUnique = (values: readonly string[]): boolean => values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
    if (!ascendingUnique(data.sharedRegions.map(row => row.id)) || !ascendingUnique(data.mailboxes.map(row => row.id))) invalid('regions and mailboxes must be ascending and unique');
    for (const region of data.sharedRegions) {
      if (region.id.length === 0 || region.pages.length === 0 || !count(region.space) || !Number.isSafeInteger(region.value)) invalid(`region ${region.id}`);
      if (region.pages.some((page, index) => !count(page) || region.pages.indexOf(page) !== index)) invalid(`region ${region.id} pages`);
      const pids = region.attachments.map(row => row.pid);
      if (pids.some((pid, index) => !count(pid, 1) || pids.indexOf(pid) !== index)) invalid(`region ${region.id} attachers`);
      for (const row of region.attachments) {
        if (!count(row.space) || row.pages.length !== region.pages.length || row.pages.some(page => !count(page))) invalid(`region ${region.id} attachment ${row.pid}`);
      }
    }
    for (const mailbox of data.mailboxes) {
      if (mailbox.id.length === 0 || !count(mailbox.capacity)) invalid(`mailbox ${mailbox.id}`);
      for (const message of mailbox.messages) {
        if (message === null || typeof message !== 'object' || Array.isArray(message)) invalid(`mailbox ${mailbox.id} message`);
        const { from: sender, tick: at, payload } = message as { readonly [key: string]: unknown };
        if (!count(sender, 1) || !count(at) || typeof payload !== 'number' || !Number.isFinite(payload)) invalid(`mailbox ${mailbox.id} message`);
      }
      if (mailbox.messages.length > mailbox.capacity) invalid(`mailbox ${mailbox.id} overfull`);
      for (const pid of [...mailbox.sendWaiters, ...mailbox.recvWaiters]) if (!count(pid, 1)) invalid(`mailbox ${mailbox.id} waiter`);
    }
    const mailboxIds = new Set(data.mailboxes.map(row => row.id));
    const pendingPids = new Set<number>();
    for (const row of data.pending) {
      if (!count(row.pid, 1) || pendingPids.has(row.pid) || !mailboxIds.has(row.mailbox)) invalid(`pending operation ${row.pid}`);
      if ((row.kind === 'send') !== (row.message !== null)) invalid(`pending operation ${row.pid} message`);
      if (row.message !== null && (!count(row.message.from, 1) || !count(row.message.tick) || !Number.isFinite(row.message.payload))) invalid(`pending message ${row.pid}`);
      const mailbox = data.mailboxes.find(box => box.id === row.mailbox);
      const queue = row.kind === 'send' ? mailbox?.sendWaiters : mailbox?.recvWaiters;
      if (queue?.includes(row.pid) !== true) invalid(`pending operation ${row.pid} is not queued`);
      pendingPids.add(row.pid);
    }
    for (const mailbox of data.mailboxes) for (const [kind, queue] of [['send', mailbox.sendWaiters], ['recv', mailbox.recvWaiters]] as const) {
      for (const pid of queue) if (!data.pending.some(row => row.pid === pid && row.kind === kind && row.mailbox === mailbox.id)) invalid(`waiter ${pid} has no pending operation`);
    }
    const completionPids = new Set<number>();
    for (const row of data.completions) {
      if (!count(row.pid, 1) || completionPids.has(row.pid) || pendingPids.has(row.pid)) invalid(`completion ${row.pid}`);
      completionPids.add(row.pid);
    }
    for (const [pid, resource] of data.completedWaits) if (!completionPids.has(pid) || typeof resource !== 'string' || !resource.startsWith('mbox:')) invalid(`completed wait ${pid}`);
    for (const [frame, pinned] of data.originalPins) if (!count(frame) || typeof pinned !== 'boolean') invalid(`original pin ${frame}`);

    this.regions.clear(); this.regionOrder.length = 0; this.mappings.clear();
    this.mailboxes.clear(); this.mailboxOrder.length = 0;
    this.pending.clear(); this.completions.clear(); this.completedWaits.clear(); this.originalPins.clear();
    for (const region of data.sharedRegions) {
      const id = asResourceId(region.id);
      this.regions.set(id, { id, pages: region.pages.map(page => asPageId(page)), space: region.space, attached: region.attachments.map(row => row.pid), value: region.value });
      this.mappings.set(id, new Map(region.attachments.map(row => [row.pid, { space: row.space, pages: row.pages.map(page => asPageId(page)) }])));
      this.regionOrder.push(id);
    }
    for (const mailbox of data.mailboxes) {
      const id = asResourceId(mailbox.id);
      this.mailboxes.set(id, { id, capacity: mailbox.capacity,
        queue: mailbox.messages.map(message => { const row = message as { readonly from: number; readonly tick: number; readonly payload: number };
          return { from: row.from as Pid, tick: row.tick as Tick, payload: row.payload }; }),
        sendWaiters: [...mailbox.sendWaiters], recvWaiters: [...mailbox.recvWaiters] });
      this.mailboxOrder.push(id);
    }
    for (const row of data.pending) {
      this.pending.set(row.pid, row.kind === 'send' && row.message !== null
        ? { kind: 'send', mailbox: asResourceId(row.mailbox), message: { from: row.message.from, tick: row.message.tick, payload: row.message.payload } }
        : { kind: 'recv', mailbox: asResourceId(row.mailbox) });
    }
    for (const row of data.completions) this.completions.set(row.pid, { ...row.result });
    for (const [pid, resource] of data.completedWaits) this.completedWaits.set(pid, asResourceId(resource));
    for (const [frame, pinned] of data.originalPins) this.originalPins.set(frame, pinned);
  }

  private requireRegion(id: ResourceId): SharedRegion {
    const region = this.regions.get(id);
    if (region === undefined) throw new KernelInvariantError(11, 'shared region disappeared');
    return region;
  }

  createSharedRegion(region: SharedRegion): SharedRegion {
    if (this.regions.has(region.id)) throw new Error(`shared region already exists: ${region.id}`);
    if (region.pages.length === 0 || !Number.isSafeInteger(region.value)) {
      throw new Error('shared region requires pages and an integer value');
    }
    if (region.attached.length !== 0) throw new Error('shared region must start unattached');
    const pages = [...region.pages];
    if (pages.some((page, index) => !Number.isSafeInteger(page) || page < 0 || pages.indexOf(page) !== index)) {
      throw new Error('shared region pages must be distinct nonnegative integers');
    }
    const stored: SharedRegion = { ...region, pages, attached: [] };
    this.regions.set(region.id, stored);
    this.mappings.set(region.id, new Map());
    insertResource(this.regionOrder, region.id);
    return stored;
  }

  sharedRegion(id: ResourceId): SharedRegion | undefined {
    return this.regions.get(id);
  }

  /** Resolve the attachment independently of whether its backing page is resident. */
  sharedMapping(pid: Pid, page: PageId): Readonly<SharedMapping> | undefined {
    for (const id of this.regionOrder) {
      const mapping = this.mappings.get(id)?.get(pid);
      const offset = mapping?.pages.indexOf(page) ?? -1;
      const region = this.regions.get(id);
      const backingPage = region?.pages[offset];
      if (mapping !== undefined && region !== undefined && backingPage !== undefined) {
        return Object.freeze({ region: id, space: mapping.space, page, backingSpace: region.space, backingPage });
      }
    }
    return undefined;
  }

  createMailbox(id: ResourceId, capacity: number): Mailbox {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new Error('mailbox capacity must be a nonnegative integer');
    }
    if (this.mailboxes.has(id)) throw new Error(`mailbox already exists: ${id}`);
    const mailbox: Mailbox = { id, capacity, queue: [], sendWaiters: [], recvWaiters: [] };
    this.mailboxes.set(id, mailbox);
    insertResource(this.mailboxOrder, id);
    return mailbox;
  }

  mailbox(id: ResourceId): Mailbox | undefined {
    return this.mailboxes.get(id);
  }

  mmap(pid: Pid, id: ResourceId, writable?: boolean): SyscallResult {
    const pcb = this.hooks.process(pid);
    if (!isLive(pcb)) return noProcess();
    const region = this.regions.get(id);
    const mappings = this.mappings.get(id);
    if (region === undefined || mappings === undefined) return noRegion();
    const rights = this.hooks.rights(pid, id);
    if (!rights.includes('read') || (writable === true && !rights.includes('write'))) {
      this.hooks.onAccessDenied?.(pid, id, !rights.includes('read') ? 'read' : 'write');
      return { ok: false, errno: 'EACCES', message: 'shared region access denied' };
    }
    const existing = mappings.get(pid);
    if (existing !== undefined) {
      return { ok: false, errno: 'EBUSY', message: 'shared region already attached' };
    }
    const sourceTable = this.hooks.pageTable(region.space);
    const sources = region.pages.map(page => sourceTable.find(entry => entry.page === page));
    if (sources.some(entry => entry === undefined)) {
      return { ok: false, errno: 'ENOMEM', message: 'shared region page table is unavailable' };
    }
    const targetTable = this.hooks.pageTable(pcb.addressSpaceId);
    const firstPage = targetTable.reduce((next, entry) => Math.max(next, entry.page + 1), 0);
    if (!Number.isSafeInteger(firstPage + region.pages.length - 1)) {
      return { ok: false, errno: 'ENOMEM', message: 'address space exhausted' };
    }
    const mappedPages: PageId[] = [];
    for (const source of sources) {
      if (source === undefined) throw new KernelInvariantError(11, 'shared region source disappeared');
      const page = asPageId(firstPage + mappedPages.length);
      targetTable.push({
        ...source,
        page,
        readable: true,
        writable: writable ?? rights.includes('write'),
        executable: rights.includes('execute'),
      });
      mappedPages.push(page);
    }
    mappings.set(pid, { space: pcb.addressSpaceId, pages: mappedPages });
    insertPid(region.attached, pid);
    this.refreshSharedMappings();
    for (const page of mappedPages) {
      const mapping = this.sharedMapping(pid, page);
      if (mapping !== undefined) this.hooks.onSharedMap?.(pid, mapping);
    }
    return { ok: true, value: firstPage };
  }

  munmap(pid: Pid, id: ResourceId): SyscallResult {
    const region = this.regions.get(id);
    const mappings = this.mappings.get(id);
    if (region === undefined || mappings === undefined) return noRegion();
    const mapping = mappings.get(pid);
    if (mapping === undefined) return { ok: false, errno: 'EINVAL', message: 'shared region is not attached' };
    const detached = mapping.pages.map(page => this.sharedMapping(pid, page));
    const table = this.hooks.pageTable(mapping.space);
    for (let index = table.length - 1; index >= 0; index -= 1) {
      const entry = table[index];
      if (entry !== undefined && mapping.pages.includes(entry.page)) table.splice(index, 1);
    }
    mappings.delete(pid);
    removePid(region.attached, pid);
    this.refreshSharedMappings();
    for (const page of detached) {
      if (page !== undefined) this.hooks.onSharedUnmap?.(pid, page);
    }
    return completed;
  }

  munmapRange(pid: Pid, firstPage: PageId, count: number): SyscallResult {
    for (const id of this.regionOrder) {
      const mapping = this.mappings.get(id)?.get(pid);
      if (mapping !== undefined && mapping.pages[0] === firstPage && mapping.pages.length === count) {
        return this.munmap(pid, id);
      }
    }
    return { ok: false, errno: 'EINVAL', message: 'range does not match an attached shared region' };
  }

  /** WP-05 calls this after loading a previously invalid shared page. */
  refreshSharedMappings(): void {
    const activeFrames: FrameId[] = [];
    for (const id of this.regionOrder) {
      const region = this.regions.get(id);
      const mappings = this.mappings.get(id);
      if (region === undefined || mappings === undefined || region.attached.length === 0) continue;
      const sourceTable = this.hooks.pageTable(region.space);
      for (let offset = 0; offset < region.pages.length; offset += 1) {
        const page = region.pages[offset];
        const source = sourceTable.find(entry => entry.page === page);
        if (source === undefined) throw new KernelInvariantError(11, 'attached shared region lost a page');
        if (source.frame !== null && !activeFrames.includes(source.frame)) activeFrames.push(source.frame);
        for (const pid of region.attached) {
          const mapping = mappings.get(pid);
          if (mapping === undefined) throw new KernelInvariantError(11, 'shared region mapping is missing');
          const mappedPage = mapping.pages[offset];
          const target = this.hooks.pageTable(mapping.space).find(entry => entry.page === mappedPage);
          if (target === undefined) throw new KernelInvariantError(11, 'attached shared page is missing');
          target.frame = source.frame;
          target.valid = source.valid;
          target.swapped = source.swapped;
        }
      }
    }
    activeFrames.sort((a, b) => a - b);
    const previousFrames = [...this.originalPins.keys()].sort((a, b) => a - b);
    for (const id of previousFrames) {
      if (activeFrames.includes(id)) continue;
      const frame = this.hooks.frame(id);
      const original = this.originalPins.get(id);
      if (frame !== undefined && original !== undefined) frame.pinned = original;
      this.originalPins.delete(id);
    }
    for (const id of activeFrames) {
      const frame = this.hooks.frame(id);
      if (frame === undefined) throw new KernelInvariantError(11, 'shared region frame is missing');
      if (!this.originalPins.has(id)) this.originalPins.set(id, frame.pinned);
      frame.pinned = true;
    }
  }

  send(pid: Pid, id: ResourceId, payload: number, tick: Tick): SyscallResult {
    const failure = this.operationFailure(pid, id);
    if (failure !== undefined) return failure;
    if (!Number.isFinite(payload)) {
      return { ok: false, errno: 'EINVAL', message: 'message payload must be finite' };
    }
    const mailbox = this.requireMailbox(id);
    const message: Message = { from: pid, tick, payload };
    const receiver = mailbox.recvWaiters.shift();
    if (receiver !== undefined) {
      this.finish(receiver, { ok: true, value: payload });
      return completed;
    }
    if (mailbox.queue.length < mailbox.capacity) {
      mailbox.queue.push(message);
      return completed;
    }
    mailbox.sendWaiters.push(pid);
    this.pending.set(pid, { kind: 'send', mailbox: id, message });
    this.hooks.block(pid, { kind: 'semaphore', resource: asResourceId(`mbox:${id}:send`) });
    return completed;
  }

  receive(pid: Pid, id: ResourceId): SyscallResult {
    const failure = this.operationFailure(pid, id);
    if (failure !== undefined) return failure;
    const mailbox = this.requireMailbox(id);
    const queued = mailbox.queue.shift();
    if (queued !== undefined) {
      this.fillVacancy(mailbox);
      return { ok: true, value: queued.payload };
    }
    const sender = mailbox.sendWaiters.shift();
    if (sender !== undefined) {
      const pending = this.pending.get(sender);
      if (pending?.kind !== 'send' || pending.mailbox !== id) {
        throw new KernelInvariantError(11, 'mailbox sender has no pending message');
      }
      this.finish(sender, completed);
      return { ok: true, value: pending.message.payload };
    }
    mailbox.recvWaiters.push(pid);
    this.pending.set(pid, { kind: 'recv', mailbox: id });
    this.hooks.block(pid, { kind: 'semaphore', resource: asResourceId(`mbox:${id}:recv`) });
    return completed;
  }

  matchesWait(pid: Pid, reason: BlockReason): boolean {
    if (reason.kind !== 'semaphore') return false;
    const operation = this.pending.get(pid);
    const resource = operation === undefined ? this.completedWaits.get(pid)
      : asResourceId(`mbox:${operation.mailbox}:${operation.kind === 'send' ? 'send' : 'recv'}`);
    return resource === reason.resource;
  }

  hasCompletion(pid: Pid): boolean {
    return this.completions.has(pid);
  }

  hasMailboxWait(pid: Pid): boolean {
    return this.pending.has(pid) || this.completions.has(pid);
  }

  /** Consumed by phase 4, so phase 8 never inserts a woken peer in the ready queue. */
  takeCompletion(pid: Pid): SyscallResult | undefined {
    const result = this.completions.get(pid);
    this.completions.delete(pid);
    this.completedWaits.delete(pid);
    return result;
  }

  removeProcess(pid: Pid): void {
    for (const id of this.regionOrder) {
      if (this.mappings.get(id)?.has(pid) === true) this.munmap(pid, id);
    }
    for (const id of this.mailboxOrder) {
      const mailbox = this.requireMailbox(id);
      removePid(mailbox.sendWaiters, pid);
      removePid(mailbox.recvWaiters, pid);
    }
    this.pending.delete(pid);
    this.completions.delete(pid);
    this.completedWaits.delete(pid);
  }

  private operationFailure(pid: Pid, id: ResourceId): SyscallResult | undefined {
    if (!isLive(this.hooks.process(pid))) return noProcess();
    if (!this.mailboxes.has(id)) return { ok: false, errno: 'ENOENT', message: 'no such mailbox' };
    if (this.hasMailboxWait(pid)) {
      return { ok: false, errno: 'EBUSY', message: 'process already has a pending mailbox operation' };
    }
    return undefined;
  }

  private fillVacancy(mailbox: Mailbox): void {
    const sender = mailbox.sendWaiters.shift();
    if (sender === undefined) return;
    const pending = this.pending.get(sender);
    if (pending?.kind !== 'send' || pending.mailbox !== mailbox.id) {
      throw new KernelInvariantError(11, 'mailbox sender has no pending message');
    }
    mailbox.queue.push(pending.message);
    this.finish(sender, completed);
  }

  private finish(pid: Pid, result: SyscallResult): void {
    const operation = this.pending.get(pid);
    if (operation !== undefined) this.completedWaits.set(pid, asResourceId(`mbox:${operation.mailbox}:${operation.kind === 'send' ? 'send' : 'recv'}`));
    this.pending.delete(pid);
    this.completions.set(pid, result);
  }

  private requireMailbox(id: ResourceId): Mailbox {
    const mailbox = this.mailboxes.get(id);
    if (mailbox === undefined) throw new KernelInvariantError(11, 'mailbox disappeared');
    return mailbox;
  }
}

function isLive(pcb: ProcessControlBlock | undefined): pcb is ProcessControlBlock {
  return pcb !== undefined && pcb.state !== 'zombie' && pcb.state !== 'terminated';
}

function noProcess(): SyscallResult {
  return { ok: false, errno: 'ESRCH', message: 'no such process' };
}

function noRegion(): SyscallResult {
  return { ok: false, errno: 'ENOENT', message: 'no such shared region' };
}

function insertResource(order: ResourceId[], id: ResourceId): void {
  const index = order.findIndex(existing => existing > id);
  order.splice(index === -1 ? order.length : index, 0, id);
}

function insertPid(order: Pid[], pid: Pid): void {
  const index = order.findIndex(existing => existing > pid);
  order.splice(index === -1 ? order.length : index, 0, pid);
}

function removePid(order: Pid[], pid: Pid): void {
  const index = order.indexOf(pid);
  if (index !== -1) order.splice(index, 1);
}
