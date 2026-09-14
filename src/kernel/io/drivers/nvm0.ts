import type { DeviceId } from '../../types';
import type { DeviceDriver, DeviceSnapshot } from './DeviceDriver';

export function nvm0Driver(device: DeviceId, snapshot: () => DeviceSnapshot): DeviceDriver {
  return { device, kind: 'block', snapshot,
    submit: (req, ctx) => ctx.start(req), complete: (req, ctx) => ctx.complete(req, ctx.result(req)),
    onInterrupt: ctx => ctx.interrupt(device),
    control: (command, args, ctx) => ctx.control(device, command, args),
  };
}
