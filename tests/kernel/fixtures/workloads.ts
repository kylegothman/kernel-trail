import { createKernel, type KernelImpl, type KernelOptions } from '@kernel/Kernel';
import { asPageId, asResourceId } from '@kernel/types';
import type { KernelConfig, Pid } from '@kernel/types';
import { REFERENCE_CONFIG } from './referenceConfig';

/**
 * The reference workload the WP-11 invariant and sweep suites drive: eight
 * processes with one to three threads (the stepOrder shape), plus one shared
 * region with two attachers and one mailbox holding a message (pre-flight D10).
 */
/**
 * `longLived` gives the region owner and its two attachers a service that outlasts
 * the run: an owner exiting with live attachers leaves their aliases pointing at
 * freed frames, a WP-02 and WP-05 hazard reported by WP-11 and not fixed here.
 */
export function referenceWorkload(config: KernelConfig = REFERENCE_CONFIG, options: KernelOptions = {}, service = 50, longLived = 0): { kernel: KernelImpl; pids: Pid[] } {
  const kernel = createKernel(config, options);
  kernel.installHooks({ security: { rights: () => ['read', 'write'] } });
  const pids: Pid[] = [];
  for (let index = 0; index < 8; index++) {
    pids.push(kernel.spawn({ name: `p${index}`, priority: index, arrival: index * 3, burst: 10, service: index < 3 && longLived > 0 ? longLived : service, pages: 8 }, { threadCount: index % 3 + 1 }));
  }
  const first = pids[0]; const second = pids[1]; const third = pids[2]; const fourth = pids[3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) throw new Error('workload spawn failed');
  const owner = kernel.process(first);
  if (owner === undefined) throw new Error('missing region owner');
  const region = asResourceId('region:sweep');
  kernel.ipc.createSharedRegion({ id: region, pages: [asPageId(0)], space: owner.addressSpaceId, attached: [], value: 0 });
  kernel.ipc.mmap(second, region, true); kernel.ipc.mmap(third, region, false);
  kernel.ipc.createMailbox(asResourceId('box:sweep'), 2);
  kernel.ipc.send(fourth, asResourceId('box:sweep'), 5, kernel.tick);
  return { kernel, pids };
}
