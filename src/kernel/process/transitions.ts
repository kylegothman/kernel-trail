import { KernelInvariantError } from '../errors';
import type { EmittableEvent } from '../EventBus';
import type { BlockReason, Pid, ProcessControlBlock, ProcessState, Tick } from '../types';

// T1 is PCB construction, before there is a ProcessState. The frozen event's
// `from` cannot encode that absence; creation emits process.created instead.
const LEGAL_EDGES: ReadonlySet<string> = Object.freeze(new Set([
  'new->ready', 'ready->running', 'running->ready', 'running->waiting',
  'waiting->ready', 'running->zombie', 'ready->zombie', 'waiting->zombie',
  'zombie->terminated', 'new->terminated',
]));

export interface TransitionOptions {
  readonly reason?: 'reparent';
  readonly blockReason?: BlockReason;
  readonly quantumExpired?: boolean;
  readonly reapedBy?: Pid;
}

export interface TransitionContext extends TransitionOptions {
  readonly tick: Tick;
  emit(event: EmittableEvent): void;
  parentOf?(pid: Pid): Pid | null;
  markCreated?(pid: Pid): boolean;
  onAdmit?(pcb: ProcessControlBlock): void;
  onDispatch?(pcb: ProcessControlBlock): void;
  onReady?(pcb: ProcessControlBlock): void;
  onBlock?(pcb: ProcessControlBlock): void;
  onUnblock?(pcb: ProcessControlBlock): void;
  onExit?(pcb: ProcessControlBlock): void;
  onReap?(pcb: ProcessControlBlock): void;
  onDiscard?(pcb: ProcessControlBlock): void;
}

/** The only state mutation point, including explicit reparent notifications. */
export function transition(
  pcb: ProcessControlBlock,
  to: ProcessState,
  ctx: TransitionContext,
): void {
  const from = pcb.state;
  if (from === to) {
    if (ctx.reason !== 'reparent') {
      throw new KernelInvariantError(11, `illegal transition ${from}->${to}`);
    }
    ctx.emit({ type: 'process.state_changed', pid: pcb.pid, from, to });
    return;
  }
  if (!LEGAL_EDGES.has(`${from}->${to}`) || ctx.reason === 'reparent') {
    throw new KernelInvariantError(11, `illegal transition ${from}->${to}`);
  }
  if (to === 'waiting' && ctx.blockReason === undefined) {
    throw new KernelInvariantError(11, 'blocking transition requires a block reason');
  }
  if (to === 'zombie') ctx.onExit?.(pcb);
  pcb.state = to;
  pcb.readySince = to === 'ready' ? ctx.tick : null;
  if (from === 'new' && to === 'ready') {
    ctx.onAdmit?.(pcb);
    if (ctx.markCreated?.(pcb.pid) ?? true) {
      ctx.emit({ type: 'process.created', pid: pcb.pid,
        parent: ctx.parentOf?.(pcb.pid) ?? pcb.parent, name: pcb.name });
    }
  } else if (to === 'running') {
    pcb.lastScheduledTick = ctx.tick;
    pcb.priority = pcb.basePriority;
    ctx.onDispatch?.(pcb);
  } else if (from === 'running' && to === 'ready') {
    ctx.onReady?.(pcb);
    if (ctx.quantumExpired === true) {
      ctx.emit({ type: 'quantum.expired', pid: pcb.pid, level: pcb.queueLevel });
    }
  } else if (to === 'waiting') {
    pcb.blockedOn = ctx.blockReason ?? null;
    ctx.onBlock?.(pcb);
  } else if (from === 'waiting' && to === 'ready') {
    pcb.blockedOn = null;
    ctx.onUnblock?.(pcb);
  } else if (from === 'zombie' && to === 'terminated') {
    ctx.onReap?.(pcb);
    ctx.emit({ type: 'process.reaped', pid: pcb.pid,
      by: ctx.reapedBy ?? ctx.parentOf?.(pcb.pid) ?? pcb.parent ?? pcb.pid });
  } else if (from === 'new' && to === 'terminated') {
    ctx.onDiscard?.(pcb);
  }
  ctx.emit({ type: 'process.state_changed', pid: pcb.pid, from, to });
}
