import {BoxGeometry} from 'three/webgpu';
import {FORM} from '@design';
import {cachedGeometry,withEdges} from './index';
export function makePagePlate(){return cachedGeometry('page-plate',()=>withEdges(new BoxGeometry(FORM.pagePlate.x,FORM.pagePlate.thickness,FORM.pagePlate.z)));}
export const makeSlab=makePagePlate;
