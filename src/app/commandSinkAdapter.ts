/** KERNEL TRAIL - terminal writes through the recorded command bus. WP-19 R3. */
import type { Tick } from '@kernel/types';
import type { Command, CommandBus } from '@game/CommandBus';
import type { CommandSink, SinkResult, TerminalCommandRequest } from '@game/terminalHost';
import type { LegId } from '@game/types';

function toCommand(request: TerminalCommandRequest): Command | string {
  switch (request.kind) {
    case 'set_scheduler': {
      const unsupported = Object.keys(request.params ?? {}).filter((key) => key !== 'quantum').sort();
      if (unsupported.length > 0) return `Unsupported scheduler parameters: ${unsupported.join(', ')}. See man sched; only quantum can be recorded by this command bus.`;
      return request.params?.quantum === undefined
        ? { kind: 'set_scheduler', to: request.id }
        : { kind: 'set_scheduler', to: request.id, quantum: request.params.quantum };
    }
    case 'set_replacement': return { kind: 'set_replacement', to: request.id };
    case 'set_disk': return { kind: 'set_disk_policy', to: request.id };
    case 'set_allocation': return { kind: 'set_allocation', to: request.strategy };
    case 'set_pace': return { kind: 'set_pace', to: request.pace };
    case 'set_rations': return { kind: 'set_rations', to: request.rations };
    case 'set_degree': return { kind: 'set_degree', to: request.degree };
    case 'set_deadlock_strategy': return { kind: 'set_deadlock_strategy', to: request.strategy };
    case 'syscall': return { kind: 'syscall', request: request.request };
    default: return assertNever(request);
  }
}

/**
 * The shell runs on the main thread between frames, while the kernel is
 * between steps. Synchronous apply therefore stays at a tick boundary and
 * records its order relative to queued commands before that same step.
 * The getter follows the active kernel across leg boundaries.
 */
export function sinkOverBus(bus: CommandBus, legId: LegId, kernel: () => { readonly tick: Tick }): CommandSink {
  return {
    dispatch(request): SinkResult {
      const command = toCommand(request);
      if (typeof command === 'string') return { ok: false, message: command };
      const outcome = bus.apply(command, { source: 'terminal', legId }, kernel().tick);
      if (outcome.refused !== null) return { ok: false, message: outcome.refused };
      return outcome.syscall === null ? { ok: true } : { ok: true, syscall: outcome.syscall };
    },
  };
}

function assertNever(request: never): never {
  throw new Error(`Unknown terminal command: ${JSON.stringify(request)}`);
}
