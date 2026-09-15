import {describe,it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {ColorManagement} from 'three';
import * as t from '../../src/design';
import {stripComments} from '../kernel/sourceScan';
const palettes={VOID:[0x04060a,0x080b11,0x0d1219,0x0a1a24,0x060910],CYAN:[0x123844,0x2f8fa8,0x5fd7f5,0x9fecff,0xd6f7ff],AMBER:[0x3b1d04,0x7a3c06,0xff9a2e,0xffbe5c,0xffe0b0],SLATE:[0x1b2026,0x39434d,0x6b7a88,0x9fb4c4,0xe8f4ff]} as const;
describe('design contract',()=>{
 for(const family of ['VOID','CYAN','AMBER','SLATE'] as const)it(`${family} values`,()=>expect(Object.values(t[family])).toEqual(palettes[family]));
 it('gains',()=>{expect(t.EMISSIVE_GAIN).toEqual({off:0,ambient:0.45,dim:1.1,active:1.85,hot:3.2,critical:4.6});expect(t.AMBER_GAIN_COMPENSATION).toBe(1.25);});
 it('gainFor',()=>{expect(t.gainFor('amber','active')).toBe(2.3125);expect(t.gainFor('cyan','active')).toBe(1.85);expect(t.gainFor('amber','critical')).toBe(5.75);});
 it('linear conversion and cache',()=>{expect(ColorManagement.enabled).toBe(true);expect(t.linearColor(t.CYAN.core).r).not.toBe(95/255);expect(t.linearColor(t.CYAN.core)).toBe(t.linearColor(t.CYAN.core));});
 it('semantic completeness',()=>{expect(Object.keys(t.SEMANTICS)).toHaveLength(18);for(const [id,v] of Object.entries(t.SEMANTICS)){expect(v.id).toBe(id);expect(v.silhouette).toBeTruthy();expect(v.dash).toBeTruthy();expect(v.glyph).toHaveLength(1);}});
 it('motion tokens',()=>{expect(Object.values(t.DUR)).toEqual([0,90,160,260,420,520,380,1400,520,4000]);expect(Object.values(t.TICK_MS)).toEqual([420,300,190,120]);for(const ease of Object.values(t.EASE)){expect(ease(0)).toBe(0);expect(ease(1)).toBe(1);expect(ease(0.5)).toBeGreaterThan(0);}});
 it('typography fallbacks and micro size',()=>{expect(t.FONT_STACK.mono).toMatch(/monospace$/);expect(t.FONT_STACK.sans).toMatch(/sans-serif$/);expect(t.TYPE_SCALE.micro.sizeRem*16).toBe(13);expect(Object.values(t.WORLD_CAP_HEIGHT_M)).toEqual([0.16,0.09,0.14,0.34,0.11]);});
 it('no literals elsewhere',()=>{
  const visit=(dir:string):void=>{for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())visit(p);else if(p.endsWith('.ts')&&!p.endsWith('design/tokens.ts')){const source=stripComments(readFileSync(p,'utf8'),false);expect(source,p).not.toMatch(/0x[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,8}\b/);}}};visit('src');
 });
});

it('semantic colours, families and applied gains match every row of V 2.4',()=>{
 const expected={ready:[t.CYAN.dim,'cyan',1.1],running:[t.CYAN.white,'cyan',3.2],waiting:[t.CYAN.trace,'cyan',0.45],
 blocked:[t.AMBER.core,'amber',1.375],starving:[t.AMBER.dim,'amber',1.375],terminated:[t.SLATE.dead,'slate',0],zombie:[t.SLATE.outline,'slate',0.45],
 page_clean:[t.CYAN.core,'cyan',1.1],page_dirty:[t.AMBER.core,'amber',2.3125],page_absent:[t.VOID.base,'void',0],frame_free:[t.CYAN.trace,'cyan',0.45],
 resource_locked:[t.SLATE.primary,'slate',1.85],resource_contended:[t.AMBER.hot,'amber',4],resource_free:[t.CYAN.dim,'cyan',1.1],
 corrupted:[t.VOID.base,'void',1.85],protected:[t.SLATE.protected,'slate',1.1],denied:[t.AMBER.core,'amber',5.75],panic:[t.AMBER.white,'amber',5.75]};
 for(const [id,values] of Object.entries(expected)){const token=t.SEMANTICS[id as t.SemanticId];expect([token.hex,token.family,t.gainFor(token.family,token.level)],id).toEqual(values);}
});
