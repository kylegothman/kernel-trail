/**
 * The replay probe's own worker entry (WP-18 scope correction U8, pre-flight
 * ruling 15). The production registry cannot know the synthetic leg, a
 * phase 1 fixture, so this entry registers it inside a real worker and
 * installs the production worker functions. It also answers the bake probe:
 * the production bake handler posts with its transfer list, and only the
 * worker side can see whether the source buffer was detached afterwards,
 * which is acceptance 26.
 */
import { registerSynthetic } from '../../game/fixtures/syntheticLeg';
import { workerScope } from '../../../src/game/workers/protocol';
import { createReplayWorker } from '../../../src/game/workers/replay.worker';
import { createBakeWorker } from '../../../src/game/workers/bake.worker';

registerSynthetic();
const scope = workerScope();
const replay = createReplayWorker((message) => scope.postMessage(message));
const bake = createBakeWorker((message, transfer) => {
  const set = message.kind === 'done' && message.payload.kind === 'audio_buffers' ? message.payload.set : null;
  scope.postMessage(message, transfer);
  if (set !== null) {
    scope.postMessage({ id: 0, kind: 'probe', payload: { detachedAfterTransfer: set.white.byteLength === 0 && set.white.buffer.byteLength === 0, transferred: transfer?.length ?? 0 } });
  }
});
scope.onmessage = (event) => {
  replay.handle(event.data);
  bake.handle(event.data);
};
