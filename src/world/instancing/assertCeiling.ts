import type {InstanceClass,RenderQualityProfile} from '@platform';
export function assertCeiling(cls:InstanceClass,requested:number,profile:RenderQualityProfile,dev=import.meta.env.DEV):number {
  if(!Number.isInteger(requested)||requested<0)throw new Error('Invalid requested instance count');
  const max=profile.maxInstances[cls];if(requested>max&&dev)throw new Error(`${cls} exceeds ${profile.tier} instance ceiling ${max}`);
  return Math.min(requested,max);
}
