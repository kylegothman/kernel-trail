import type {FocusTarget,InstancedBatchDesc} from '@render';
import type {InstanceClass} from '@platform';
import {PROFILES} from '@platform';
import type {WorldContext,StageServices} from '../../contracts';
import {InstancedBatch} from '../../instancing/InstancedBatch';
import {assertCeiling} from '../../instancing/assertCeiling';
import {Structure} from './Structure';
export abstract class InstancedStructure extends Structure {
  readonly batch:InstancedBatch;
  constructor(id:string,context:WorldContext,target:Omit<FocusTarget,'id'|'anchor'>,services:StageServices,cls:InstanceClass,desc:InstancedBatchDesc){
    super(id,context,target);assertCeiling(cls,desc.capacity,PROFILES[context.quality]);
    this.batch=new InstancedBatch(services.createBatch(desc));this.batch.handle.object.name=`kt.structures.${id}.batch`;this.root.add(this.batch.handle.object);
  }
  protected override releaseOwned():void{this.batch.dispose();}
}
