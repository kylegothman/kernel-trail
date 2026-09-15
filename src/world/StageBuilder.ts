import {Group,Mesh} from 'three/webgpu';
import {LineSegments2} from 'three/addons/lines/LineSegments2.js';
import {HORIZON,LAYER} from '@design';
import {GeometryLeases,makeGridFloor,makeHorizon,recenterGrid} from './forms';
import type {Object3D} from 'three/webgpu';
import type {LegStage} from '@game/types';
import {validateScene,assertTransparencyDepth,getMaterial,acquireFocusMaterial,releaseFocusMaterials,type FocusCameraRig} from '@render';
import {GROUP_NAMES,GROUP_LAYERS,type WorldGroup,type WorldContext,type StageServices,type StructureHandle,type TransparencyPlacement} from './contracts';
import {StructureRegistry} from './structures/base/StructureRegistry';
export class StageBuilder {
  readonly groups:Readonly<Record<WorldGroup,Group>>;
  private readonly structures:StructureHandle[]=[];
  private readonly anchors=new Map<string,Object3D>();
  private readonly transparency=new Map<string,number>();
  private built=false;
  private readonly geometry=new GeometryLeases();
  private floor:Mesh|null=null;
  constructor(private readonly context:WorldContext,private readonly services:StageServices,private readonly camera:FocusCameraRig,readonly registry=new StructureRegistry()){
    if(context.scene.children.length)throw new Error('Stage scene must start empty');
    const groups={} as Record<WorldGroup,Group>;
    for(const name of GROUP_NAMES){const group=new Group();group.name=`kt.${name}`;group.layers.set(GROUP_LAYERS[name]);group.matrixAutoUpdate=false;groups[name]=group;context.scene.add(group);}
    this.groups=groups;context.scene.matrixAutoUpdate=false;
  }
  /** Optional common ground. WP-L00 supplies the separate band and columns. */
  addEnvironment():void {
    if(this.built||this.floor)throw new Error('Environment already built');
    const floor=new Mesh(this.geometry.take(makeGridFloor()),getMaterial('reflective-floor','frame_free',this.context.quality));
    floor.layers.set(LAYER.ENV);floor.name='kt.env.ground.grid';this.floor=floor;this.groups.env.add(floor);
    const material=acquireFocusMaterial(this,getMaterial('emissive-line','frame_free',this.context.quality));
    if('linewidth' in material)material.linewidth=HORIZON.ringWidthM;
    const horizon=new LineSegments2(this.geometry.take(makeHorizon()) as import('three/addons/lines/LineSegmentsGeometry.js').LineSegmentsGeometry,material as import('three/addons/lines/LineMaterial.js').LineMaterial);
    horizon.layers.set(LAYER.ENV);horizon.name='kt.env.horizon.line';this.groups.env.add(horizon);
  }
  addNamed(factory:string,id:string,group:WorldGroup='structures',placement:readonly TransparencyPlacement[]=[]):StructureHandle {
    return this.add(this.registry.create(factory,id,this.context,this.services),group,placement);
  }
  add(structure:StructureHandle,group:WorldGroup='structures',placement:readonly TransparencyPlacement[]=[]):StructureHandle {
    if(this.built)throw new Error('Stage already built');
    if(this.anchors.has(structure.id)||structure.focusTarget.id!==structure.id)throw new Error('Anchor identity mismatch or duplicate');
    const proposed=new Map(this.transparency);
    let supplied=0;
    for(const p of placement){if(!Number.isInteger(p.layers)||p.layers<0)throw new Error('Invalid transparency placement');const depth=(proposed.get(p.cell)??0)+p.layers;assertTransparencyDepth(depth);proposed.set(p.cell,depth);supplied+=p.layers;}
    let required=0;
    structure.root.traverse(object=>{
      const mesh=object as Object3D & {material?:{transparent:boolean}|{transparent:boolean}[];geometry?:{userData:Record<string,unknown>};count?:number};
      if(!mesh.material)return;
      const transparent=Array.isArray(mesh.material)?mesh.material.some(m=>m.transparent):mesh.material.transparent;
      if(!transparent)return;
      const layers=mesh.geometry?.userData['transparencyLayers'];
      if(typeof layers!=='number')throw new Error('Transparent form requires conservative layer metadata');
      required+=layers*(mesh.count??1);
    });
    if(supplied<required)throw new Error('Transparency placement does not cover form metadata');
    this.transparency.clear();for(const [cell,layers] of proposed)this.transparency.set(cell,layers);
    this.groups[group].add(structure.root);this.structures.push(structure);this.anchors.set(structure.id,structure.focusTarget.anchor);this.context.focus.register(structure.focusTarget);
    return structure;
  }
  build():LegStage {
    if(this.built)throw new Error('Stage already built');
    const scene=this.context.scene;
    if(scene.children.length!==GROUP_NAMES.length||GROUP_NAMES.some((name,i)=>scene.children[i]!==this.groups[name]))throw new Error('Unexpected top-level stage child');
    scene.traverse(object=>{object.updateMatrix();object.matrixAutoUpdate=false;object.castShadow=false;object.receiveShadow=false;
      if('isInstancedMesh' in object&&object.isInstancedMesh)object.frustumCulled=false;
    });
    validateScene(scene);for(const depth of this.transparency.values())assertTransparencyDepth(depth);this.built=true;
    let disposed=false;
    return {
      update:(dtSeconds:number,alpha:number)=>{
        if(disposed)return;
        for(const structure of this.structures)structure.update(dtSeconds,alpha);
        scene.updateMatrixWorld();this.camera.update(dtSeconds);
        if(this.floor)recenterGrid(this.floor,this.camera.camera.position);
        this.services.postFocus.focusBlend=this.camera.state.blend;this.services.postFocus.focusDistanceM=this.camera.focusDistanceM;
        this.context.labels.update();
      },
      anchor:(id:string)=>this.anchors.get(id)??null,
      dispose:()=>{if(disposed)return;disposed=true;this.camera.dispose();this.context.labels.dispose();for(const structure of this.structures)structure.dispose();this.structures.length=0;this.anchors.clear();this.geometry.dispose();releaseFocusMaterials(this);scene.clear();},
    };
  }
}
