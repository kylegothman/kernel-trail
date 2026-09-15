import {it,expect} from 'vitest';
import {Matrix4,Vector3,Ray,WebGLCoordinateSystem,WebGPUCoordinateSystem} from 'three/webgpu';
import {BlendedPerspectiveCamera,blendProjection,projectionRay} from '../../src/render/camera/projection';
import {projectionDepthValue} from '../../src/render/shaders/depth';
for(const coordinateSystem of [WebGLCoordinateSystem,WebGPUCoordinateSystem])for(const reversed of [false,true]){
  it(`projection endpoints, plane drift and decoded depth ${coordinateSystem}/${reversed}`,()=>{
    const cam=new BlendedPerspectiveCamera(46,1440/900,.1,2000);cam.coordinateSystem=coordinateSystem;Object.defineProperty(cam,'reversedDepth',{value:reversed});
    const fov=46*Math.PI/180,d=10,h=d*Math.tan(fov/2),aspect=cam.aspect;
    const p=new Matrix4().makePerspective(-h*aspect*.1/d,h*aspect*.1/d,h*.1/d,-h*.1/d,.1,2000,coordinateSystem,reversed);
    const o=new Matrix4().makeOrthographic(-h*aspect,h*aspect,h,-h,.1,2000,coordinateSystem,reversed);
    const point=new Vector3(2,1,-d),start=point.clone().applyMatrix4(p),v=new Vector3();let drift=0;
    for(let i=0;i<=100;i++){
      blendProjection(cam,aspect,fov,d,.1,2000,i/100);v.copy(point).applyMatrix4(cam.projectionMatrix);
      drift=Math.max(drift,Math.hypot((v.x-start.x)*720,(v.y-start.y)*450)*2);
      if(i===0)cam.projectionMatrix.elements.forEach((x,k)=>expect(Math.abs(x-p.elements[k]!)).toBeLessThan(1e-9));
      if(i===100)cam.projectionMatrix.elements.forEach((x,k)=>expect(Math.abs(x-o.elements[k]!)).toBeLessThan(1e-6));
      const depth=coordinateSystem===WebGLCoordinateSystem&&!reversed?(v.z+1)/2:v.z;
      expect(projectionDepthValue(depth,cam.projectionMatrix.elements,coordinateSystem===WebGLCoordinateSystem,reversed)).toBeCloseTo(d,8);
    }
    expect(drift).toBeLessThan(.5);
  });
}
it('50 height-distance pairs agree and projection allocates no matrices',()=>{
  const cam=new BlendedPerspectiveCamera(),counts={Matrix4:0};
  blendProjection(cam,1,Math.PI/4,10,.1,2000,1);
  Object.assign(globalThis,{__ktAlloc:(name:string)=>{if(name==='Matrix4')counts.Matrix4++;}});
  try{new Matrix4();expect(counts.Matrix4).toBe(1);counts.Matrix4=0;for(let i=0;i<10000;i++)blendProjection(cam,1,Math.PI/4,10,.1,2000,(i%101)/100);expect(counts.Matrix4).toBe(0);}finally{Object.assign(globalThis,{__ktAlloc:undefined});}
  for(let i=1;i<=50;i++){const fov=(30+i)*Math.PI/180;blendProjection(cam,1,fov,i,.1,2000,1);expect(2/cam.projectionMatrix.elements[5]!).toBeCloseTo(2*i*Math.tan(fov/2),10);}
});
it('renderer depth convention refresh preserves X/Y and parallel locked picking',()=>{
  const cam=new BlendedPerspectiveCamera();blendProjection(cam,1,Math.PI/4,10,.1,2000,1);const e=cam.projectionMatrix.elements.slice();
  cam.coordinateSystem=WebGPUCoordinateSystem;cam.updateProjectionMatrix();expect(cam.projectionMatrix.elements[0]).toBe(e[0]);expect(cam.projectionMatrix.elements[15]).toBe(1);
  cam.updateMatrixWorld();const a=projectionRay(cam,-.5,0,new Ray()),b=projectionRay(cam,.5,0,new Ray());expect(a.direction.distanceTo(b.direction)).toBeLessThan(1e-12);expect(a.origin.x).not.toBe(b.origin.x);
});

it('one scene camera construction in the camera modules, no OrthographicCamera construction',async()=>{
 const {readFileSync,readdirSync}=await import('node:fs');const {join}=await import('node:path');
 const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):e.name.endsWith('.ts')?[join(dir,e.name)]:[]);
 const camera=files('src/render/camera').map(f=>readFileSync(f,'utf8')).join('\n');
 expect(camera.match(/new\s+(?:BlendedPerspectiveCamera|PerspectiveCamera)\s*\(/g)).toHaveLength(1);
 for(const file of files('src'))expect(readFileSync(file,'utf8'),file).not.toMatch(/new\s+OrthographicCamera\s*\(/);
});
