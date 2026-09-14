import { DRAW_BUDGET, type QualityTier } from '@platform';
import type { Object3D, Mesh } from 'three/webgpu';
import { LAYER } from '@design';
export class DrawCallBudget {
  private frames = 0;
  constructor(private tier: QualityTier) {}
  setTier(tier: QualityTier): void { this.tier=tier; }
  sample(drawCalls: number, triangles: number): void { if (++this.frames % 30 === 0) this.assert(drawCalls,triangles); }
  assert(drawCalls: number, triangles: number): void {
    const b=DRAW_BUDGET[this.tier];
    if(drawCalls>b.calls||triangles>b.triangles) throw new Error(`Render budget exceeded: ${drawCalls} calls, ${triangles} triangles`);
  }
}
/** Called by downstream stage constructors, never traversed in the frame path. */
export function validateScene(root: Object3D): void {
  const repeats=new Map<string,number>();let lights=0;
  root.traverse(o=>{
    if ('isLight' in o && o.isLight===true) { if(++lights>3) throw new Error('At most three lights'); }
    if (!('isMesh' in o) || o.isMesh!==true) return;
    const mesh=o as Mesh;
    if ((mesh.layers.mask & ((1 << (LAYER.LIGHTS+1))-2))===0) throw new Error('Mesh has no semantic layer');
    if ('isInstancedMesh' in mesh && mesh.isInstancedMesh===true) return;
    const count=(repeats.get(mesh.geometry.uuid)??0)+1;repeats.set(mesh.geometry.uuid,count);
    if(count>8) throw new Error('Repeated geometry requires instancing');
  });
}
export function assertTransparencyDepth(layersAtPixel: number): void {
  if(layersAtPixel>3) throw new Error('Transparency depth exceeds three layers');
}
