import {it,expect} from 'vitest';
import {Object3D,Vector3} from 'three/webgpu';
import {makeStele,makeSlab,makeHexTile,makeResourceRing,makeBeam,makeGridFloor,makeHorizon,GeometryLeases,edgeGeometry,recenterGrid} from '../../src/world/forms';
import {PROFILES} from '../../src/platform';
import {BlendedPerspectiveCamera,blendProjection} from '../../src/render/camera/projection';
import {pixelsPerWorldUnit} from '../../src/world/labels/Billboard';
it('all six forms are cached, fit their budgets and release only after the final lease',()=>{
 const forms=[makeStele(),makeSlab(),makeHexTile(),makeResourceRing('low'),makeResourceRing('medium'),makeResourceRing('high'),makeBeam('low'),makeGridFloor()];const factories=[makeStele,makeSlab,makeHexTile,()=>makeResourceRing('low'),()=>makeResourceRing('medium'),()=>makeResourceRing('high'),()=>makeBeam('low'),makeGridFloor];const budgets=[96,12,20,96,192,384,12,2];
 for(let i=0;i<forms.length;i++){const g=forms[i]!;for(let n=0;n<100;n++)expect(factories[i]!()).toBe(g);expect((g.index?.count??g.getAttribute('position').count)/3).toBeLessThanOrEqual(budgets[i]!);const a=new GeometryLeases(),b=new GeometryLeases();a.take(g);b.take(g);let disposed=0;g.addEventListener('dispose',()=>disposed++);a.dispose();expect(disposed).toBe(0);b.dispose();expect(disposed).toBe(1);}
});
it('slab masks coplanar diagonals and supplies displaced explicit line segments',()=>{const body=makeSlab(),mask=body.getAttribute('aEdgeMask');expect(Array.from(mask.array)).toContain(0);expect(Array.from(mask.array)).toContain(1);const edges=edgeGeometry(body);expect(edges.getAttribute('instanceStart').count).toBe(12);const lease=new GeometryLeases();lease.take(body);lease.take(edges);lease.dispose();});
it('grid snaps to four metres, horizon has line topology and tier minor/SDF rules are preserved',()=>{const floor=new Object3D();recenterGrid(floor,new Vector3(7,0,-7));expect(floor.position.toArray()).toEqual([8,0,-8]);const h=makeHorizon();expect(h.getAttribute('instanceStart').count).toBe(256);expect(PROFILES.low.gridMinorRangeM).toBe(30);expect(PROFILES.medium.gridMinorRangeM).toBe(Infinity);expect(PROFILES.high.gridMinorRangeM).toBe(Infinity);expect([PROFILES.low.sdfGlyphSize,PROFILES.medium.sdfGlyphSize,PROFILES.high.sdfGlyphSize]).toEqual([48,64,64]);const lease=new GeometryLeases();lease.take(h);lease.dispose();});
it('computed label floor holds at every blend and device-pixel ratio',()=>{const camera=new BlendedPerspectiveCamera();for(const dpr of [1,1.5,2])for(const depth of [6,20,90])for(let i=0;i<=100;i++){blendProjection(camera,1440/900,46*Math.PI/180,depth,.1,2000,i/100);const density=pixelsPerWorldUnit(camera,depth,900*dpr),height=Math.max(.09,13/density);expect(height*density).toBeGreaterThanOrEqual(13-1e-12);}});

it('placement uses the render-owned label API, respects transformed parents and allocates no frame math objects',async()=>{
 const {SdfAtlas}=await import('../../src/world/labels/SdfAtlas');const {FocusCameraRig}=await import('../../src/render/camera/FocusCamera');
 const {Group,Scene,Mesh,PlaneGeometry,Quaternion}=await import('three/webgpu');const {createLabelPlateMaterial,disposeMaterials}=await import('../../src/render/materials');
 const {MIN_GLYPH_PX,TYPE_SCALE}=await import('../../src/design');
 const camera=new BlendedPerspectiveCamera(46,1440/900,.1,2000);camera.position.z=20;camera.updateMatrixWorld();const scene=new Scene(),anchor=new Group(),parent=new Group();scene.add(anchor,parent);parent.rotation.z=.3;parent.scale.set(2,3,1);parent.updateMatrixWorld();
 const focus=new FocusCameraRig({scene,camera,aspect:1440/900,viewportHeightPx:900});const target={id:'label',anchor,planeNormal:new Vector3(0,0,1),planeUp:new Vector3(0,1,0),extents:new (await import('three/webgpu')).Vector2(20,20),padding:.12,focusSet:[],dimOthers:.82,labelPlane:'billboard-to-focus' as const,minGlyphHeight:.1};focus.register(target);
 const provider:typeof import('../../src/render/materials/holoLabel').holoLabel=async(_text,_semantic,_tier,capHeight)=>{const object=new Group(),geometry=new PlaneGeometry(1,capHeight),mesh=new Mesh(geometry,createLabelPlateMaterial());object.add(mesh);return {object,mesh,minimumDevicePixels:MIN_GLYPH_PX,microRem:TYPE_SCALE.micro.sizeRem,dispose(){geometry.dispose();mesh.material.dispose();object.removeFromParent();}};};
 const labels=new SdfAtlas('low',focus,900,provider);const asset=await labels.place('label','running','frameIndex',anchor,parent,new Vector3());labels.frameDensity(target,100);focus.engage('label');focus.update(.52);labels.update();asset.object.updateWorldMatrix(true,false);
 const a=new Vector3(0,0,0).applyMatrix4(asset.object.matrixWorld).project(camera),b=new Vector3(0,.09,0).applyMatrix4(asset.object.matrixWorld).project(camera);
 expect(Math.hypot((b.x-a.x)*720,(b.y-a.y)*450)).toBeGreaterThanOrEqual(13-1e-6);
 const orientation=asset.object.getWorldQuaternion(new Quaternion());expect(orientation.angleTo(camera.quaternion)).toBeLessThan(1e-6);
 const counts:Record<string,number>={};Object.assign(globalThis,{__ktAlloc:(name:string)=>{counts[name]=(counts[name]??0)+1;}});try{for(let i=0;i<300;i++){focus.update(0);labels.update();}expect(counts).toEqual({});}finally{Object.assign(globalThis,{__ktAlloc:undefined});}
 labels.dispose();focus.dispose();disposeMaterials();
});
