import {PlaneGeometry} from 'three/webgpu';
import {LineSegmentsGeometry} from 'three/addons/lines/LineSegmentsGeometry.js';
import type {Object3D,Vector3} from 'three/webgpu';
import {GRID,HORIZON,MODULE_PITCH_M} from '@design';
import {cachedGeometry} from './index';
export function makeGridFloor(){return cachedGeometry('grid-floor',()=>new PlaneGeometry(GRID.planeSizeM,GRID.planeSizeM).rotateX(-Math.PI/2));}
export function recenterGrid(floor:Object3D,camera:Vector3):void{floor.position.set(Math.round(camera.x/MODULE_PITCH_M)*MODULE_PITCH_M,0,Math.round(camera.z/MODULE_PITCH_M)*MODULE_PITCH_M);floor.updateMatrix();}
/** The horizon is a line, not the separate WP-L00 gradient band. */
export function makeHorizon(){return cachedGeometry('horizon',()=>{
  const vertices=new Float32Array(256*6);
  for(let i=0;i<256;i++)for(let end=0;end<2;end++){const a=(i+end)/256*Math.PI*2;vertices[i*6+end*3]=Math.cos(a)*HORIZON.ringRadiusM;vertices[i*6+end*3+2]=Math.sin(a)*HORIZON.ringRadiusM;}
  return new LineSegmentsGeometry().setPositions(vertices);
});}
