import type {Matrix4} from 'three/webgpu';
import type {InstancedBatchHandle} from '@render';
import {SlotAllocator} from './SlotAllocator';
export interface InstanceData {readonly colorGain:readonly [number,number,number,number];readonly statePhase:readonly [number,number,number,number];readonly patternId:readonly [number,number,number,number];}
export class InstancedBatch {
  readonly slots:SlotAllocator;
  constructor(readonly handle:InstancedBatchHandle){this.slots=new SlotAllocator(handle.capacity);}
  allocate():number {const slot=this.slots.allocate();this.handle.count=this.slots.highWater;return slot;}
  release(slot:number):void {
    this.check(slot);const start=slot*16;this.handle.matrices.fill(0,start,start+16);this.handle.touch(slot,slot+1,'matrix');
    this.slots.free(slot);this.handle.count=this.slots.highWater;
  }
  private check(slot:number):void {if(!this.slots.has(slot))throw new Error('Instance slot is not live');}
  write(slot:number,data:InstanceData):void {
    this.check(slot);const offset=slot*4;
    this.handle.colorGain.set(data.colorGain,offset);this.handle.statePhase.set(data.statePhase,offset);this.handle.patternId.set(data.patternId,offset);
    this.handle.touch(slot,slot+1,'colorGain');this.handle.touch(slot,slot+1,'statePhase');this.handle.touch(slot,slot+1,'patternId');
  }
  setFocusWeight(slot:number,weight:number):void {
    this.check(slot);const offset=slot*4+3;if(this.handle.statePhase[offset]===Math.fround(weight))return;
    this.handle.statePhase[offset]=weight;this.handle.touch(slot,slot+1,'statePhase');
  }
  move(slot:number,matrix:Matrix4):boolean {
    this.check(slot);const offset=slot*16;let changed=false;
    for(let i=0;i<16;i++)if(this.handle.matrices[offset+i]!==Math.fround(matrix.elements[i]!)){changed=true;break;}
    if(changed){for(let i=0;i<16;i++)this.handle.matrices[offset+i]=matrix.elements[i]!;this.handle.touch(slot,slot+1,'matrix');}
    return changed;
  }
  dispose():void{this.handle.dispose();}
}
