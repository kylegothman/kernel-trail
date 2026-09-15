import { BufferAttribute, BufferGeometry, Vector3 } from 'three/webgpu';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

const entries = new Map<string, {geometry:BufferGeometry;owners:number}>();
export function cachedGeometry(key:string, create:()=>BufferGeometry):BufferGeometry {
  const hit=entries.get(key);if(hit)return hit.geometry;
  const geometry=create();geometry.name=key;geometry.userData['transparencyLayers']=2;entries.set(key,{geometry,owners:0});return geometry;
}
/** Each stage keeps one lease per geometry, including shared edge geometry. */
export class GeometryLeases {
  private readonly held=new Set<BufferGeometry>();
  take(geometry:BufferGeometry):BufferGeometry {
    if(this.held.has(geometry))return geometry;
    const entry=entries.get(geometry.name);
    if(!entry||entry.geometry!==geometry)throw new Error('Geometry is not owned by the shared form cache');
    entry.owners++;this.held.add(geometry);return geometry;
  }
  dispose():void {
    for(const geometry of this.held){const entry=entries.get(geometry.name);if(entry&&--entry.owners===0){geometry.dispose();entries.delete(geometry.name);}}
    this.held.clear();
  }
}
type Edge={a:Vector3;b:Vector3;normals:Vector3[]};
function edgesFor(g:BufferGeometry):Map<string,Edge> {
  const edges=new Map<string,Edge>(),position=g.getAttribute('position');
  const a=new Vector3(),b=new Vector3(),c=new Vector3(),ab=new Vector3(),ac=new Vector3();
  const count=g.index?.count??position.count;
  for(let i=0;i<count;i+=3){
    a.fromBufferAttribute(position,g.index?.getX(i)??i);b.fromBufferAttribute(position,g.index?.getX(i+1)??i+1);c.fromBufferAttribute(position,g.index?.getX(i+2)??i+2);
    const normal=ab.copy(b).sub(a).cross(ac.copy(c).sub(a)).normalize();
    for(const [u,v] of [[a,b],[b,c],[c,a]] as const){const key=edgeKey(u,v);let edge=edges.get(key);if(!edge){edge={a:u.clone(),b:v.clone(),normals:[]};edges.set(key,edge);}edge.normals.push(normal.clone());}
  }
  return edges;
}
function vertexKey(v:Vector3):string{return `${Math.round(v.x*1e6)},${Math.round(v.y*1e6)},${Math.round(v.z*1e6)}`;}
function edgeKey(a:Vector3,b:Vector3):string{const u=vertexKey(a),v=vertexKey(b);return u<v?u+'|'+v:v+'|'+u;}
function visible(edge:Edge):boolean{return edge.normals.length===1||edge.normals.some(n=>n.dot(edge.normals[0]!)<Math.cos(Math.PI/180));}
/** Mask coplanar triangulation diagonals; each mask component opposes one vertex. */
export function withEdges(source:BufferGeometry):BufferGeometry {
  const edges=edgesFor(source),g=source.index?source.toNonIndexed():source;
  const p=g.getAttribute('position'),bary=new Float32Array(p.count*3),mask=new Float32Array(p.count*3);
  const a=new Vector3(),b=new Vector3(),c=new Vector3();
  for(let i=0;i<p.count;i+=3){
    a.fromBufferAttribute(p,i);b.fromBufferAttribute(p,i+1);c.fromBufferAttribute(p,i+2);
    const values=[visible(edges.get(edgeKey(b,c))!)?1:0,visible(edges.get(edgeKey(c,a))!)?1:0,visible(edges.get(edgeKey(a,b))!)?1:0];
    for(let v=0;v<3;v++){bary[(i+v)*3+v]=1;mask.set(values,(i+v)*3);}
  }
  g.setAttribute('aBary',new BufferAttribute(bary,3));g.setAttribute('aEdgeMask',new BufferAttribute(mask,3));
  if(g!==source)source.dispose();return g;
}
export function edgeGeometry(body:BufferGeometry):BufferGeometry {
  return cachedGeometry(body.name+'.edges',()=>{
    const values:number[]=[],normal=new Vector3();
    for(const edge of edgesFor(body).values())if(visible(edge)){
      normal.set(0,0,0);for(const n of edge.normals)normal.add(n);normal.normalize().multiplyScalar(0.004);
      for(const p of [edge.a,edge.b])values.push(p.x+normal.x,p.y+normal.y,p.z+normal.z);
    }
    return new LineSegmentsGeometry().setPositions(values);
  });
}
export {makeStele} from './stele';
export {makeSlab,makePagePlate} from './slab';
export {makeResourceRing} from './ring';
export {makeBeam} from './beam';
export {makeHexTile} from './hexTile';
export {makeGridFloor,makeHorizon,recenterGrid} from './gridFloor';
