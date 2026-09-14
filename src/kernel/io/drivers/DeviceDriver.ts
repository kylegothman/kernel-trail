import type { DeviceId, IoSnapshotDevice, IoSnapshotRequest, IoSnapshotResult, Rng, SyscallResult, Tick } from '../../types';

export type IoRequest = IoSnapshotRequest;
export type DeviceSnapshot = IoSnapshotDevice;
export interface IoSubmission { readonly acceptedTicks: number; readonly blocks: boolean; readonly queuePosition: number }
export interface IoContext {
  readonly rng: Rng;
  tick(): Tick;
  state(device: DeviceId): DeviceSnapshot;
  start(req: IoRequest): IoSubmission;
  result(req: IoRequest): IoSnapshotResult;
  complete(req: IoRequest, result: IoSnapshotResult): void;
  output(device: DeviceId, bytes: readonly number[]): void;
  interrupt(device: DeviceId): void;
  control(device: DeviceId, command: string, args: readonly (string | number | boolean)[]): SyscallResult;
}
export interface DeviceDriver {
  readonly device: DeviceId;
  readonly kind: 'block' | 'character' | 'network';
  submit(req: IoRequest, ctx: IoContext): IoSubmission;
  complete(req: IoRequest, ctx: IoContext): void;
  onInterrupt(ctx: IoContext): void;
  control(command: string, args: readonly (string | number | boolean)[], ctx: IoContext): SyscallResult;
  snapshot(): DeviceSnapshot;
}
export type Mutable<T> = T extends number | string | boolean | null ? T
  : T extends readonly (infer U)[] ? Mutable<U>[]
  : { -readonly [K in keyof T]: Mutable<T[K]> };
export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error('invalid I/O state: ' + message);
}
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const validInteger = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
export const failure = (message: string): SyscallResult => ({ ok: false, errno: 'EINVAL', message });
export const success = (value: number | null = null): SyscallResult => ({ ok: true, value });
export function bytesFor(request: Pick<IoRequest, 'command'>): number {
  return request.command.kind === 'read' ? request.command.bytes : request.command.contents.length;
}
export function plainData(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'non-finite number'); return; }
  check(typeof value === 'object' && !ancestors.has(value), 'non-data or cyclic payload');
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'non-plain object');
  ancestors.add(value);
  for (const item of Object.values(value)) plainData(item, ancestors);
  ancestors.delete(value);
}
