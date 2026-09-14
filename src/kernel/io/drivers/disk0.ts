import type { DeviceId } from '../../types';
import type { DeviceDriver, DeviceSnapshot, IoContext, IoRequest } from './DeviceDriver';

export function disk0Driver(device: DeviceId, snapshot: () => DeviceSnapshot): DeviceDriver {
  return { device, kind: 'block', snapshot,
    submit: (req, ctx) => ctx.start(req),
    complete: (req: IoRequest, ctx: IoContext) => ctx.complete(req, ctx.result(req)),
    onInterrupt: ctx => ctx.interrupt(device),
    control: (command, args, ctx) => ctx.control(device, command, args),
  };
}
