import type {Object3D,Scene} from 'three/webgpu';
import type {Pid,Tick,ProcessControlBlock} from '@kernel/types';
import type {QualityTier} from '@platform';
import type {FocusCamera,FocusTarget,InstancedBatchDesc,InstancedBatchHandle} from '@render';
import type {SdfAtlas} from './labels/SdfAtlas';
import {LAYER} from '@design';
export interface WorldEventContext {readonly elapsedSeconds:number;readonly tick:number;readonly suppressEffects:boolean;}
export type MaterialLibrary=Pick<typeof import('@render'),'getMaterial'|'acquireGlass'|'releaseGlass'|'holoLabel'|'createLabelPlateMaterial'>;
export interface WorldContext extends WorldEventContext {
  readonly scene:Scene;readonly quality:QualityTier;readonly focus:FocusCamera;readonly materials:MaterialLibrary;readonly labels:SdfAtlas;
  readonly time:{readonly elapsedSeconds:number;readonly alpha:number};
  readonly kernel:{process(pid:Pid):Readonly<ProcessControlBlock>|undefined;readonly tick:Tick};
}
export type AnchorId=string;
export interface StructureHandle {readonly id:string;readonly root:Object3D;readonly focusTarget:FocusTarget;update(dtSeconds:number,alpha:number):void;dispose():void;}
export const GROUP_NAMES=['env','terrain','structures','actors','beams','effects','labels','lights'] as const;
export type WorldGroup=typeof GROUP_NAMES[number];
export const GROUP_LAYERS={env:LAYER.ENV,terrain:LAYER.TERRAIN,structures:LAYER.STRUCTURES,actors:LAYER.ACTORS,beams:LAYER.BEAMS,effects:LAYER.EFFECTS,labels:LAYER.TEXT,lights:LAYER.LIGHTS} as const;
export interface StageServices {
  createBatch(desc:InstancedBatchDesc):InstancedBatchHandle;
  readonly postFocus:{focusBlend:number;focusDistanceM:number};
}
/** Sum is a conservative overlap bound. A cell is a region whose entries may overlap. */
export interface TransparencyPlacement {readonly cell:string;readonly layers:number;}
