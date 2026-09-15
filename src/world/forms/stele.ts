import { LatheGeometry, Vector2 } from 'three/webgpu';
import { FORM } from '@design';
import { cachedGeometry, withEdges } from './index';
export function makeStele(){return cachedGeometry('stele',()=>{
  const r=FORM.stele.acrossFlats/2/Math.cos(Math.PI/6),h=FORM.stele.height,c=FORM.stele.chamfer;
  return withEdges(new LatheGeometry([new Vector2(0,0),new Vector2(r-c,0),new Vector2(r,c),new Vector2(r,h-c),new Vector2(r-c,h),new Vector2(0,h)],6,Math.PI/6,Math.PI*2));
});}
