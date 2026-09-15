import {it,expect} from 'vitest';
import {Scene,Vector2,Vector3,Group,Mesh,BoxGeometry} from 'three/webgpu';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createKernel} from '../../src/kernel/Kernel';
import {REFERENCE_CONFIG} from '../kernel/fixtures/referenceConfig';
import {stripComments} from '../kernel/sourceScan';
import {FocusCameraRig} from '../../src/render/camera/FocusCamera';
import {BlendedPerspectiveCamera} from '../../src/render/camera/projection';
import * as materials from '../../src/render/materials';
import {holoLabel} from '../../src/render/materials/holoLabel';
import {StageBuilder} from '../../src/world/StageBuilder';
import {Structure} from '../../src/world/structures/base/Structure';
import {StructureRegistry,STRUCTURE_NAMES} from '../../src/world/structures/base/StructureRegistry';
import {SdfAtlas} from '../../src/world/labels/SdfAtlas';
import type {WorldContext,StageServices} from '../../src/world/contracts';
import {LAYER} from '../../src/design';
function setup(){const scene=new Scene(),camera=new BlendedPerspectiveCamera();camera.position.z=20;const focus=new FocusCameraRig({camera,scene,aspect:1,viewportHeightPx:900}),kernel=createKernel(REFERENCE_CONFIG),labels=new SdfAtlas('low',focus,900);const context:WorldContext={scene,quality:'low',focus,materials:{...materials,holoLabel},labels,time:{elapsedSeconds:0,alpha:0},elapsedSeconds:0,tick:0,suppressEffects:false,kernel:{process:pid=>kernel.process(pid),get tick(){return kernel.tick;}}};const services:StageServices={createBatch:()=>{throw Error('not used');},postFocus:{focusBlend:0,focusDistanceM:0}};return {scene,focus,kernel,context,services};}
class Example extends Structure {calls=0;constructor(context:WorldContext){super('example',context,{planeNormal:new Vector3(0,0,1),planeUp:new Vector3(0,1,0),extents:new Vector2(4,4),padding:.12,focusSet:[],dimOthers:.82,labelPlane:'billboard-to-focus',minGlyphHeight:.1});}update(){this.calls++;}}
it('anchor identity, eight groups, real kernel tick advances during lock, and disposal',()=>{const {context,services,focus,kernel,scene}=setup(),builder=new StageBuilder(context,services,focus),structure=new Example(context);builder.add(structure);const stage=builder.build();expect(scene.children).toHaveLength(8);expect(stage.anchor('example')).toBe(structure.focusTarget.anchor);const interaction={anchor:structure.id};expect(stage.anchor(interaction.anchor)).toBe(structure.root);focus.engage('example');stage.update(.52,0);const tick=kernel.tick;kernel.step();stage.update(.01,.5);expect(kernel.tick).toBeGreaterThan(tick);expect(structure.calls).toBe(2);expect(focus.state.mode).toBe('locked');expect(services.postFocus.focusBlend).toBe(1);expect(Object.keys(context.kernel).sort()).toEqual(['process','tick']);stage.dispose();stage.dispose();expect(scene.children).toHaveLength(0);});
it('eight named phase-2 factories throw, no named structure is implemented',()=>{const {context,services}=setup(),registry=new StructureRegistry();expect(STRUCTURE_NAMES).toHaveLength(8);for(const name of STRUCTURE_NAMES)expect(()=>registry.create(name,'x',context,services)).toThrow(name+': phase 2');context.labels.dispose();});
it('stage invokes layer, repetition and conservative transparency validators',()=>{const {context,services,focus}=setup(),builder=new StageBuilder(context,services,focus),structure=new Example(context),g=new BoxGeometry(),m=materials.getMaterial('void-surface','ready','low');for(let i=0;i<9;i++){const mesh=new Mesh(g,m);mesh.layers.set(LAYER.STRUCTURES);structure.root.add(mesh);}expect(()=>builder.add(structure,'structures',[{cell:'overlap',layers:4}])).toThrow('Transparency');builder.add(structure);expect(()=>builder.build()).toThrow('instancing');structure.dispose();g.dispose();materials.disposeMaterials();});
it('unexpected top-level children rejected',()=>{const {context,services,focus}=setup(),builder=new StageBuilder(context,services,focus);context.scene.add(new Group());expect(()=>builder.build()).toThrow('top-level');focus.dispose();});
it('world has no kernel/game value imports or held PCB field; render has no world dependency',()=>{
 const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):e.name.endsWith('.ts')?[join(dir,e.name)]:[]);
 for(const file of files('src/world')){const code=stripComments(readFileSync(file,'utf8'),false);expect(code,file).not.toMatch(/import(?!\s+type\b)[^;]*from\s*['"][^'"]*(?:@kernel|@game|\/kernel\/|\/game\/)/);expect(code,file).not.toMatch(/(?:private|protected|public)\s+(?:readonly\s+)?\w+\s*:\s*(?:Readonly<)?ProcessControlBlock/);}
 for(const file of files('src/render'))expect(stripComments(readFileSync(file,'utf8'),false),file).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]*(?:@world|\/world\/)/);
});

it('optional grid/horizon use semantic layers and shared geometry leases',()=>{const {context,services,focus,scene}=setup(),builder=new StageBuilder(context,services,focus);builder.addEnvironment();const stage=builder.build();expect(builder.groups.env.children.map(o=>o.name)).toEqual(['kt.env.ground.grid','kt.env.horizon.line']);expect(builder.groups.env.children.every(o=>o.layers.isEnabled(LAYER.ENV))).toBe(true);stage.update(.01,0);stage.dispose();expect(scene.children).toHaveLength(0);materials.disposeMaterials();});
