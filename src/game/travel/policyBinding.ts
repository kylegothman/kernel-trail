import type { PolicyBinding } from '../replay/types';
import { PACE_TABLE } from './paceRations';

/** One binding for live play and replay, applied once after each command batch. */
export const livePolicyBinding: PolicyBinding = {
  apply(kernel, policy) {
    const view = kernel.invariantState();
    const quantum = PACE_TABLE[policy.pace].quantum;
    if (view.schedulerParams.quantum !== quantum) {
      kernel.setScheduler(view.schedulerId, { quantum });
    }
    const memory = kernel.memorySubsystem;
    const framePolicy = memory.framePolicy;
    if (framePolicy.rations !== policy.rations) {
      memory.setFramePolicy(
        policy.rations, framePolicy.allocationScheme, framePolicy.replacementScope,
      );
    }
    // TODO(astra): kernel track adds a per-process frame floor API; rations then reserves ceil(framesPerProgram) per bound Program
    const control = memory.pager.control;
    const degree = Math.max(1, Math.min(control.maximumDegree,
      Math.trunc(policy.degreeOfMultiprogramming)));
    if (control.degreeOfMultiprogramming !== degree) {
      kernel.setDegreeOfMultiprogramming(degree);
    }
  },
};
