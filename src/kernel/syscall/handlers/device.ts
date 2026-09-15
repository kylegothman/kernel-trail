import type { DeviceId, SyscallName } from '../../types';
import type { SyscallHandler } from '../table';

export const DEVICE_HANDLERS: Readonly<Pick<Record<SyscallName, SyscallHandler>, 'ioctl'>> = Object.freeze({
  ioctl: (request, state, pcb) => state.ioctl(pcb, String(request.args[0]) as DeviceId, String(request.args[1]), request.args.slice(2)),
});
