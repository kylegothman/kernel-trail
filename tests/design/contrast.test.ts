import {it,expect} from 'vitest';
import {TEXT_CONTRAST,VOID,LABEL_PLATE,SEMANTICS,DEFAULT_VISION_SETTINGS,linearLuminance} from '../../src/design';
import {resolveSemantic} from '../../src/design/accessibility';
for(const [i,pair] of TEXT_CONTRAST.entries())it(`text ratio ${i}`,()=>expect((linearLuminance(pair.hex)+0.05)/(linearLuminance(VOID.base)+0.05)).toBeGreaterThanOrEqual(pair.ratio));
it('backing plate worst case under display-luminance bound is AAA',()=>{
 expect(LABEL_PLATE.opacity).toBe(0.92);
 const background=linearLuminance(VOID.base)*LABEL_PLATE.opacity+0.15*(1-LABEL_PLATE.opacity);
 expect(background).toBeLessThanOrEqual(0.014);
 for(const pair of TEXT_CONTRAST.filter(t=>t.permitted==='any-size'))expect((linearLuminance(pair.hex)+0.05)/(background+0.05)).toBeGreaterThan(7);
});
it('monochrome mapping preserves redundant distinctions',()=>{
 const mapped=Object.values(SEMANTICS).map(t=>resolveSemantic(t.id,{...DEFAULT_VISION_SETTINGS,monochromeSemantics:true}));
 const identities=new Set(mapped.map(t=>`${t.silhouette}|${t.dash}|${t.hatch}|${t.glyph}`));expect(identities.size).toBe(18);
});
