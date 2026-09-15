import type {WorldContext,StructureHandle,StageServices} from '../../contracts';
export type StructureFactory=(id:string,context:WorldContext,services:StageServices)=>StructureHandle;
export const STRUCTURE_NAMES=['FrameVault','ReadyQueueProcession','WaitForRing','PlatterStack','PageOcean','BusSpine','ArchiveShelves','DomainRings'] as const;
export class StructureRegistry {
  private readonly factories=new Map<string,StructureFactory>();
  constructor(){for(const name of STRUCTURE_NAMES)this.factories.set(name,()=>{
    // TODO(astra): phase 2 leg packages implement this structure
    throw new Error(`${name}: phase 2 leg packages implement this structure`);
  });}
  register(name:string,factory:StructureFactory):void{this.factories.set(name,factory);}
  create(name:string,id:string,context:WorldContext,services:StageServices):StructureHandle {
    const factory=this.factories.get(name);if(!factory)throw new Error(`Unknown structure: ${name}`);return factory(id,context,services);
  }
}
