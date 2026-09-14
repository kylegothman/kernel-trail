import type { DeviceId } from '../../types';
import type { DeviceDriver, DeviceSnapshot } from './DeviceDriver';

export function characterOutputDriver(device: DeviceId, snapshot: () => DeviceSnapshot): DeviceDriver {
  return { device, kind: 'character', snapshot,
    submit: (req, ctx) => ctx.start(req),
    complete: (req, ctx) => {
      const result = ctx.result(req);
      if (result.kind === 'ok' && req.command.kind === 'character') ctx.output(device, req.command.contents);
      ctx.complete(req, result);
    },
    onInterrupt: ctx => ctx.interrupt(device),
    control: (command, args, ctx) => ctx.control(device, command, args),
  };
}
