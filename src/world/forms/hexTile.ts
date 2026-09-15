import {BufferGeometry,BufferAttribute} from 'three/webgpu';
import {FORM} from '@design';
import {cachedGeometry,withEdges} from './index';
export function makeHexTile(){return cachedGeometry('hex-tile',()=>{
  const p:number[]=[],index:number[]=[],r=FORM.hexTile.circumradius;
  for(let y=0;y<2;y++)for(let i=0;i<6;i++){const angle=i*Math.PI/3;p.push(Math.cos(angle)*r,y*FORM.pagePlate.thickness,Math.sin(angle)*r);}
  for(let i=1;i<5;i++){index.push(0,i,i+1,6,6+i+1,6+i);}
  for(let i=0;i<6;i++){const j=(i+1)%6;index.push(i,i+6,j,j,i+6,j+6);}
  const g=new BufferGeometry();g.setAttribute('position',new BufferAttribute(new Float32Array(p),3));g.setIndex(index);g.computeVertexNormals();
  const uv=new Float32Array(12*2);for(let i=0;i<12;i++){uv[i*2]=p[i*3]!/(r*2)+0.5;uv[i*2+1]=p[i*3+2]!/(r*2)+0.5;}g.setAttribute('uv',new BufferAttribute(uv,2));return withEdges(g);
});}
