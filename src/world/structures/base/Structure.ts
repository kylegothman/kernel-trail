import {Group} from 'three/webgpu';
import type {BufferGeometry} from 'three/webgpu';
import type {FocusTarget} from '@render';
import type {SemanticId} from '@design';
import {acquireGlass,releaseGlass} from '@render';
import {GeometryLeases} from '../../forms';
import type {WorldContext,StructureHandle} from '../../contracts';
export abstract class Structure implements StructureHandle {
  readonly root=new Group();
  readonly focusTarget:FocusTarget;
  protected readonly geometry=new GeometryLeases();
  private disposed=false;
  constructor(readonly id:string,protected readonly context:WorldContext,target:Omit<FocusTarget,'id'|'anchor'>) {
    this.root.name=`kt.structures.${id}.root`;this.root.matrixAutoUpdate=false;
    this.focusTarget={...target,id,anchor:this.root};
  }
  protected shared(geometry:BufferGeometry):BufferGeometry{return this.geometry.take(geometry);}
  protected glass(semantic:SemanticId){return acquireGlass(this,semantic,this.context.quality);}
  abstract update(dtSeconds:number,alpha:number):void;
  protected releaseOwned():void {}
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.context.focus.unregister(this.id);
    this.releaseOwned();releaseGlass(this);this.geometry.dispose();this.root.removeFromParent();this.root.clear();
  }
}
