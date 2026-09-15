import {Vector3} from 'three/webgpu';
import type {Object3D} from 'three/webgpu';
import {holoLabel,type FocusCameraRig,type FocusTarget} from '@render';
import {MIN_GLYPH_PX,WORLD_CAP_HEIGHT_M,type WorldLabelClass,type SemanticId} from '@design';
import {PROFILES,type QualityTier} from '@platform';
import {orientLabel} from './Billboard';
import {scratch} from '../scratch';
type LabelAsset=Awaited<ReturnType<typeof holoLabel>>;
interface PlacedLabel {asset:LabelAsset;anchor:Object3D;offset:Vector3;capHeight:number;}
/** Historical filename. Atlas creation/loading stays entirely in @render. */
export class SdfAtlas {
  private readonly labels:PlacedLabel[]=[];
  private reservations=0;
  private disposed=false;
  constructor(readonly tier:QualityTier,private readonly focus:FocusCameraRig,private viewportHeightPx:number,private readonly load:typeof holoLabel=holoLabel){}
  setViewport(heightPx:number):void{this.viewportHeightPx=heightPx;}
  /** Density belongs to placement, never to the frozen FocusTarget shape. */
  frameDensity(target:FocusTarget,rows:number):void {
    if(!Number.isInteger(rows)||rows<1)throw new Error('Label rows must be positive');
    const available=target.extents.y/rows;
    this.focus.setLabelGlyphHeight(target.id,Math.min(target.minGlyphHeight,available));
  }
  async place(text:string,semantic:SemanticId,labelClass:WorldLabelClass,anchor:Object3D,parent:Object3D,offset:Vector3):Promise<LabelAsset> {
    if(this.disposed)throw new Error('Label placement disposed');
    if(this.labels.length+this.reservations>=PROFILES[this.tier].labelBudget)throw new Error('Label budget exceeded');
    this.reservations++;
    try {
      const capHeight=WORLD_CAP_HEIGHT_M[labelClass],asset=await this.load(text,semantic,this.tier,capHeight);
      if(this.disposed){asset.dispose();throw new Error('Label placement disposed during loading');}
      parent.add(asset.object);asset.object.name=`kt.labels.${anchor.name}.text`;
      asset.object.traverse(o=>{o.updateMatrix();o.matrixAutoUpdate=false;});
      this.labels.push({asset,anchor,offset:offset.clone(),capHeight});return asset;
    } finally {this.reservations--;}
  }
  update():void {
    const camera=this.focus.camera;camera.updateMatrixWorld();
    for(const label of this.labels){
      label.anchor.updateWorldMatrix(true,false);scratch.position.copy(label.offset).applyMatrix4(label.anchor.matrixWorld);
      label.asset.object.position.copy(scratch.position);
      if(label.asset.object.parent)label.asset.object.parent.worldToLocal(label.asset.object.position);
      const viewDepth=-scratch.position.applyMatrix4(camera.matrixWorldInverse).z;
      label.asset.object.visible=viewDepth>camera.near&&viewDepth<camera.far;
      if(!label.asset.object.visible)continue;
      label.asset.object.scale.setScalar(1);
      orientLabel(label.asset.object,label.anchor,camera,this.focus);
      label.asset.object.updateWorldMatrix(true,false);
      const local=label.asset.object.matrixWorld.elements;
      const worldCap=label.capHeight*Math.hypot(local[4]!,local[5]!,local[6]!);
      const target=this.focus.state.target;
      const worldMinimum=target&&this.focus.focusWeight(label.anchor)===1?target.minGlyphHeight:label.capHeight;
      scratch.matrix.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).multiply(label.asset.object.matrixWorld);
      const e=scratch.matrix.elements,w=e[15]!,qw=e[7]!*label.capHeight;
      const dx=(e[4]!-e[12]!*e[7]!/w)*label.capHeight*this.viewportHeightPx*camera.aspect*0.5;
      const dy=(e[5]!-e[13]!*e[7]!/w)*label.capHeight*this.viewportHeightPx*0.5;
      const denominator=Math.hypot(dx,dy)-MIN_GLYPH_PX*qw;
      if(denominator<=0){label.asset.object.visible=false;continue;}
      const scale=Math.max(1,worldMinimum/worldCap,MIN_GLYPH_PX*w/denominator);
      label.asset.object.scale.setScalar(scale);orientLabel(label.asset.object,label.anchor,camera,this.focus);

    }
  }
  dispose():void{if(this.disposed)return;this.disposed=true;for(const label of this.labels)label.asset.dispose();this.labels.length=0;}
}
