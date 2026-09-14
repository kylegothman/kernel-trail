import type { DeviceId } from '../../types';
import { check } from './DeviceDriver';
import type { DeviceDriver, DeviceSnapshot } from './DeviceDriver';

export function net0Driver(device: DeviceId, snapshot: () => DeviceSnapshot): DeviceDriver {
  return { device, kind: 'network', snapshot,
    submit: (req, ctx) => ctx.start(req),
    complete: (req, ctx) => {
      const state = ctx.state(device); check(state.driver.kind === 'net0', 'network driver state');
      // One draw per completed packet, including the endpoints zero and one.
      const lost = ctx.rng.next() < state.driver.lossProbability;
      ctx.complete(req, lost ? { kind: 'lost' } : ctx.result(req));
    },
    onInterrupt: ctx => ctx.interrupt(device),
    control: (command, args, ctx) => ctx.control(device, command, args),
  };
}
