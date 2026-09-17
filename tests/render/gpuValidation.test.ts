import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGpuValidation } from './gpu/validation';

class Device extends EventTarget {
  readonly lost = new Promise<never>(() => undefined);
  readonly queue = { onSubmittedWorkDone: vi.fn(async () => undefined) };
  readonly group = {};
  scope: { message: string } | null = null;
  createBindGroup(_descriptor: unknown) { return this.group; }
  async popErrorScope() { return this.scope; }
}
class Adapter { async requestDevice() { return new Device(); } }
let observer: ReturnType<typeof installGpuValidation>;
beforeEach(() => {
  vi.stubGlobal('GPUAdapter', Adapter); vi.stubGlobal('GPUDevice', Device);
  observer = installGpuValidation();
});
afterEach(() => {
  observer.restore(); vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__kernelTrailGpuValidation');
});

describe('boot native GPU validation capture', () => {
  it('observes every device before renderer handlers and preserves native delivery', async () => {
    const benchmark = await new Adapter().requestDevice();
    const session = await new Adapter().requestDevice();
    const rendererListener = vi.fn();
    session.addEventListener('uncapturederror', rendererListener);
    benchmark.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'benchmark binding' } }));
    observer.setPhase('boot-sector:medium');
    session.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'session binding' } }));
    expect(observer.snapshot()).toEqual([
      { phase: 'startup', device: 1, source: 'uncaptured', message: 'benchmark binding', count: 1 },
      { phase: 'boot-sector:medium', device: 2, source: 'uncaptured', message: 'session binding', count: 1 },
    ]);
    expect(rendererListener).toHaveBeenCalledOnce();
    await observer.flush();
    expect(benchmark.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(session.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  });

  it('records resolved error scopes without swallowing or replacing their result', async () => {
    const device = await new Adapter().requestDevice();
    device.scope = { message: 'scoped validation failure' };
    expect(await device.popErrorScope()).toBe(device.scope);
    expect(observer.snapshot()[0]).toMatchObject({ source: 'scope', message: 'scoped validation failure' });
  });

  it('detects zero-sized bindings even when no console or device error arrives', async () => {
    const device = await new Adapter().requestDevice();
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(device.createBindGroup({ label: 'bindGroup_object', entries: [
        { binding: 2, resource: { buffer: { size: 0, label: 'empty-instance-matrix' } } },
      ] })).toBe(device.group);
    }
    expect(observer.snapshot()).toEqual([{
      phase: 'startup', device: 1, source: 'zero-buffer-binding', count: 2,
      message: 'bindGroup_object binding 2: empty-instance-matrix, buffer size 0, offset 0, binding size 0',
    }]);
  });

  it('accepts nonempty buffers and respects binding offset and explicit size', async () => {
    const device = await new Adapter().requestDevice();
    const buffer = { size: 64, label: 'matrix' };
    device.createBindGroup({ entries: [{ binding: 0, resource: { buffer, offset: 16, size: 32 } }] });
    expect(observer.snapshot()).toEqual([]);
    device.createBindGroup({ entries: [{ binding: 0, resource: { buffer, offset: 64 } }] });
    device.createBindGroup({ entries: [{ binding: 0, resource: { buffer, size: 0 } }] });
    expect(observer.snapshot()).toHaveLength(2);
  });
});
