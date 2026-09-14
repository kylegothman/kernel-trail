/** The used public surface, checked against troika-three-text/src/TextBuilder.js. */
declare module 'troika-three-text' {
  import type { Texture } from 'three';
  export interface TextRenderInfo { readonly sdfTexture:Texture;readonly sdfGlyphSize:number;readonly sdfExponent:number;readonly glyphBounds:Float32Array;readonly glyphAtlasIndices:Float32Array;readonly blockBounds:readonly number[] }
  export function getTextRenderInfo(options:{text:string;font:string;fontSize:number;sdfGlyphSize:number;letterSpacing?:number;gpuAccelerateSDF?:boolean},callback:(info:TextRenderInfo)=>void):void;
  export function configureTextBuilder(options:{defaultFontURL?:string;useWorker?:boolean}):void;
}
