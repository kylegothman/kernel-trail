import { afterEach, expect, it, vi } from 'vitest';
import { checkWebGPUEnvironment, installWebGPUDiagnostics } from './gpu/webgpuDiagnostics';

afterEach(() => { vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers(); });

function fakeDevice(lost: Promise<{reason:string;message:string}>, pop: () => Promise<unknown>) {
  // Use a real prototype method, as the browser does.
  class NativeDevice {
    readonly lost = lost;
    popErrorScope() { return pop(); }
  }
  class Adapter {
    readonly info = {vendor:'test',architecture:'test',device:'test',description:'test'};
    async requestDevice() { return new NativeDevice(); }
  }
  vi.stubGlobal('GPUAdapter', Adapter);vi.stubGlobal('GPUDevice', NativeDevice);
  vi.spyOn(console,'info').mockImplementation(()=>{});
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  vi.spyOn(console,'error').mockImplementation(()=>{});
  installWebGPUDiagnostics();
  return new Adapter().requestDevice();
}

it('missing headless adapter is an environment result, not a renderer failure', async () => {
  vi.stubGlobal('navigator',{gpu:{requestAdapter:async()=>null}});
  expect(await checkWebGPUEnvironment()).toEqual({status:'no-adapter',detail:'requestAdapter returned null'});
});

it('popErrorScope reports the settled device loss instead of an opaque OperationError', async () => {
  const device=await fakeDevice(Promise.resolve({reason:'unknown',message:'Instance dropped'}),async()=>{throw new DOMException('Instance dropped in popErrorScope','OperationError');});
  await expect(device.popErrorScope()).rejects.toThrow('reason=unknown; message=Instance dropped');
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('device 1.lost'));
});

it('popErrorScope retains validation results on a healthy device', async () => {
  const validation={message:'invalid shader binding'};
  const device=await fakeDevice(new Promise(()=>{}),async()=>validation);
  expect(await device.popErrorScope()).toBe(validation);
});

it('popErrorScope bounds the wait when device.lost never settles', async () => {
  vi.useFakeTimers();
  const device=await fakeDevice(new Promise(()=>{}),async()=>{throw new DOMException('scope failed','OperationError');});
  const assertion=expect(device.popErrorScope()).rejects.toThrow('device.lost has not settled within 1000 ms');
  await vi.advanceTimersByTimeAsync(1000);await assertion;
});
