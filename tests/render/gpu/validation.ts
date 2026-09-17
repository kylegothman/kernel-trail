/** Install before app scripts so benchmark and session devices are both observed. */
export function installGpuValidation() {
  let phase = 'startup';
  let nextId = 0;
  const errors: { phase: string; device: number; source: string; message: string; count: number }[] = [];
  const devices = new Map<GPUDevice, { id: number; lost: boolean }>();
  function record(device: GPUDevice, source: string, message: string): void {
    const id = watch(device).id;
    const previous = errors.find(error => error.phase === phase && error.device === id && error.source === source && error.message === message);
    if (previous) previous.count++;
    else errors.push({ phase, device: id, source, message, count: 1 });
  }
  function watch(device: GPUDevice) {
    const existing = devices.get(device);
    if (existing) return existing;
    const state = { id: ++nextId, lost: false };
    devices.set(device, state);
    device.addEventListener('uncapturederror', event => record(device, 'uncaptured', event.error.message));
    void device.lost.then(() => { state.lost = true; });
    return state;
  }
  const restore: (() => void)[] = [];
  if (typeof GPUAdapter !== 'undefined' && typeof GPUDevice !== 'undefined') {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(descriptor) {
      const device = await request.call(this, descriptor);
      watch(device);
      return device;
    };
    const pop = GPUDevice.prototype.popErrorScope;
    GPUDevice.prototype.popErrorScope = async function() {
      const error = await pop.call(this);
      if (error) record(this, 'scope', error.message);
      return error;
    };
    const bind = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function(descriptor) {
      for (const entry of descriptor.entries) {
        if ('buffer' in entry.resource) {
          const { buffer, offset = 0, size = buffer.size - offset } = entry.resource;
          if (size === 0) record(this, 'zero-buffer-binding', `${descriptor.label ?? 'unlabelled group'} binding ${entry.binding}: ${buffer.label}, buffer size ${buffer.size}, offset ${offset}, binding size ${size}`);
        }
      }
      return bind.call(this, descriptor);
    };
    restore.push(() => {
      GPUAdapter.prototype.requestDevice = request;
      GPUDevice.prototype.popErrorScope = pop;
      GPUDevice.prototype.createBindGroup = bind;
    });
  }
  const observer = {
    setPhase(value: string): void { phase = value; },
    snapshot: () => errors.map(error => ({ ...error })),
    async flush(): Promise<void> {
      await Promise.all(Array.from(devices, async ([device, state]) => {
        if (!state.lost) await device.queue.onSubmittedWorkDone();
      }));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
    restore(): void { for (const undo of restore.splice(0).reverse()) undo(); },
  };
  Object.assign(globalThis, { __kernelTrailGpuValidation: observer });
  return observer;
}
