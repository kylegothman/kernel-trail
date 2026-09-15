import { BufferGeometry,BufferAttribute,Mesh,Group,PlaneGeometry } from 'three/webgpu';
import { LAYER,LABEL_PLATE,MIN_GLYPH_PX,MONO_CAP_RATIO,SEMANTICS,TYPE_SCALE, type SemanticId } from '@design';
import { PROFILES,type QualityTier } from '@platform';
import { createAtlasMaterial,createLabelPlateMaterial,createLabelHairlineMaterial } from './index';
import mono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?url';
import monoBold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url';
import jost from '@fontsource/jost/files/jost-latin-400-normal.woff?url';
import jostLight from '@fontsource/jost/files/jost-latin-300-normal.woff?url';
import jostSemibold from '@fontsource/jost/files/jost-latin-600-normal.woff?url';
export const FONT_URL={mono,monoBold,jost,jostLight,jostSemibold} as const;
export async function holoLabel(text:string,semantic:SemanticId,tier:QualityTier,capHeight:number) {
  const {getTextRenderInfo,configureTextBuilder}=await import('troika-three-text');
  if(!configured){configureTextBuilder({defaultFontURL:mono});configured=true;}
  const info=await new Promise<import('troika-three-text').TextRenderInfo>(resolve=>getTextRenderInfo({text:`${SEMANTICS[semantic].glyph} ${text}`,font:mono,fontSize:capHeight/MONO_CAP_RATIO,sdfGlyphSize:PROFILES[tier].sdfGlyphSize,letterSpacing:0.04,gpuAccelerateSDF:false},resolve));
  const positions:number[]=[],uvs:number[]=[],channels:number[]=[];
  const image=info.sdfTexture.image as {width:number;height:number};
  const glyph=info.sdfGlyphSize,cols=image.width/glyph;
  for(let i=0;i<info.glyphAtlasIndices.length;i++) {
    const idx=info.glyphAtlasIndices[i]??0,b=info.glyphBounds;
    const x0=b[i*4]??0,y0=b[i*4+1]??0,x1=b[i*4+2]??0,y1=b[i*4+3]??0;
    const tile=Math.floor(idx/4),tx=(tile%cols)*glyph,ty=Math.floor(tile/cols)*glyph;
    for(const [x,y] of [[0,0],[1,0],[0,1],[0,1],[1,0],[1,1]]) {
      positions.push(x?x1:x0,y?y1:y0,0);uvs.push(tx+(x??0)*glyph,ty+(y??0)*glyph);channels.push(idx%4);
    }
  }
  const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(new Float32Array(positions),3));
  geometry.setAttribute('aAtlasUv',new BufferAttribute(new Float32Array(uvs),2));geometry.setAttribute('aAtlasChannel',new BufferAttribute(new Float32Array(channels),1));
  const material=createAtlasMaterial(info.sdfTexture,semantic);
  const mesh=new Mesh(geometry,material);mesh.layers.set(LAYER.TEXT);mesh.name='kt.labels.probe.text';
  const group=new Group();group.add(mesh);
  const bounds=info.blockBounds;const w=(bounds[2]??0)-(bounds[0]??0),h=(bounds[3]??0)-(bounds[1]??0);
  const plateGeo=new PlaneGeometry(w+LABEL_PLATE.paddingM*2,h+LABEL_PLATE.paddingM*2),plateMat=createLabelPlateMaterial();
  const plate=new Mesh(plateGeo,plateMat);plate.position.set((bounds[0]??0)+w/2,(bounds[1]??0)+h/2,-LABEL_PLATE.hairlineM);plate.layers.set(LAYER.TEXT);plate.renderOrder=-1;group.add(plate);
  const hairlineGeo=new PlaneGeometry(w+LABEL_PLATE.paddingM*2,LABEL_PLATE.hairlineM),hairlineMat=createLabelHairlineMaterial(semantic);
  const hairline=new Mesh(hairlineGeo,hairlineMat);hairline.layers.set(LAYER.STRUCTURES);
  hairline.position.set(plate.position.x,(bounds[1]??0)-LABEL_PLATE.paddingM-LABEL_PLATE.hairlineM/2,0);group.add(hairline);
  return {object:group,mesh,minimumDevicePixels:MIN_GLYPH_PX,microRem:TYPE_SCALE.micro.sizeRem,
    dispose(){geometry.dispose();material.dispose();plateGeo.dispose();plateMat.dispose();hairlineGeo.dispose();hairlineMat.dispose();group.removeFromParent();}};
}
let configured=false;
