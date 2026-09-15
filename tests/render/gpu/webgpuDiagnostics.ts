/** Installed before page scripts, including Three's native error-scope calls. */
export function installWebGPUDiagnostics(): void {
  const devices = new WeakMap<GPUDevice, { id: number; loss: GPUDeviceLostInfo | null }>();
  let nextId = 0;
  const losses: { id: number; reason: GPUDeviceLostReason; message: string }[] = [];
  Object.assign(globalThis, { __kernelTrailDeviceLosses: losses });
  function watch(device: GPUDevice) {
    let record = devices.get(device);
    if (!record) {
      record = { id: ++nextId, loss: null }; devices.set(device, record);
      const entry = record;
      void device.lost.then(info => {
        entry.loss = info;losses.push({id:entry.id,reason:info.reason,message:info.message});
        console.warn(`[WebGPU device ${entry.id}.lost] reason=${info.reason}; message=${info.message}`);
      });
    }
    return record;
  }
  if (typeof GPUAdapter !== 'undefined' && typeof GPUDevice !== 'undefined') {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(descriptor?: GPUDeviceDescriptor) {
      const device = await request.call(this, descriptor);
      const record = watch(device);
      console.info(`[WebGPU device ${record.id}] requested; adapter=${JSON.stringify({vendor:this.info.vendor,architecture:this.info.architecture,device:this.info.device,description:this.info.description})}`);
      return device;
    };
    const pop = GPUDevice.prototype.popErrorScope;
    GPUDevice.prototype.popErrorScope = async function() {
      const record = watch(this);
      try { return await pop.call(this); }
      catch (cause) {
        // An OperationError may precede delivery of device.lost. Bound that wait.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const loss = record.loss ?? await Promise.race([
          this.lost,
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
        ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
        const detail = loss ? `reason=${loss.reason}; message=${loss.message}` : 'device.lost has not settled within 1000 ms';
        const original = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        const message = `WebGPU device ${record.id} popErrorScope failed: ${detail}; original=${original}`;
        console.error(message);
        throw new Error(message, { cause });
      }
    };
  }
  // Identify the warning's caller without changing readback ordering or results.
  for (const [name, constructor] of [['WebGL2', globalThis.WebGL2RenderingContext], ['WebGL', globalThis.WebGLRenderingContext]] as const) {
    if (!constructor) continue;
    const prototype = constructor.prototype;
    const original = prototype.readPixels;
    let reported = 0;
    Object.defineProperty(prototype, 'readPixels', { configurable: true, writable: true,
      value: function(this: WebGLRenderingContext | WebGL2RenderingContext, ...args: unknown[]) {
        if (reported++ < 4) console.info(`[${name} readPixels] ${JSON.stringify(args.slice(0, 4))}\n${new Error('readPixels call site').stack}`);
        return Reflect.apply(original, this, args);
      },
    });
  }
}

/** Runs in a dedicated page kept alive until both backend probes finish. */
export async function checkWebGPUEnvironment() {
  if (!navigator.gpu) return { status: 'no-adapter' as const, detail: 'navigator.gpu is unavailable' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { status: 'no-adapter' as const, detail: 'requestAdapter returned null' };
  const info = {vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description};
  console.info('WebGPU preflight adapter:', JSON.stringify(info));
  const device = await adapter.requestDevice();
  Object.assign(globalThis, { __kernelTrailEnvironmentDevice: { adapter, device } });
  device.pushErrorScope('validation');
  await device.popErrorScope();
  device.queue.submit([]);
  await device.queue.onSubmittedWorkDone();
  // Do not interpret a pending lost promise as evidence of future device health.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = await Promise.race([
    device.lost.then(loss => ({ reason: loss.reason, message: loss.message })),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  return { status: lost ? 'device-lost' as const : 'available' as const, info, lost };
}
