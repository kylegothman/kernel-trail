import { chromium } from 'playwright';
import { createServer, build } from 'vite';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const allocationProbe={name:'kt-allocation-probe',enforce:'pre',transform(code,id){
 if(!id.includes('/three/'))return null;
 return code.replace(/(class (Matrix4|Vector3|Color)\b[\s\S]*?\bconstructor\s*\([^)]*\)\s*\{)/g,
  (match,_head,name)=>match+`globalThis.__ktAlloc?.('${name}');`);
}};
await build({plugins:[allocationProbe],build:{outDir:'/private/tmp/kt-wp12-gpu-build',emptyOutDir:true,rolldownOptions:{input:resolve('tests/render/gpu/probe.html')}}});
if(process.argv.includes('--build-only'))process.exit(0);
const server=await createServer({plugins:[allocationProbe],optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0}});await server.listen();
const address=server.httpServer.address();if(!address||typeof address==='string')throw new Error('No server');
let browser;
try { browser=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu']}); } catch(error) { await server.close(); throw error; }
const results=[];
try {
 for(const force of [false,true]) {
  const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text());}});
  await page.goto(`http://127.0.0.1:${address.port}/tests/render/gpu/probe.html${force?'?webgl':''}`);
  await page.waitForFunction(()=>Boolean(window.probe),undefined,{timeout:60000});
  const info=await page.evaluate(()=>window.probe.info());console.log(JSON.stringify(info));
  for(const [tier,calls,triangles] of [['low',220,180000],['medium',450,450000],['high',900,1100000]]) {
   const stats=await page.evaluate(t=>window.probe.tier(t),tier);assert(stats.drawCalls<=calls);assert(stats.triangles<=triangles);assert(stats.targetMemoryBytes<=210*1024*1024);results.push({backend:force?'webgl2':'preferred',tier,stats});
  }
  const allocations=await page.evaluate(()=>window.probe.allocations(300));assert.deepEqual(allocations,{Matrix4:0,Vector3:0,Color:0});results.push({allocations});
  if(!force){const timing=await page.evaluate(()=>window.probe.timing());console.log('GPU milliseconds',JSON.stringify(timing));results.push({timing});}
  if(force){const recovery=await page.evaluate(()=>window.probe.recovery());assert.deepEqual(recovery,{attempts:[true],outcome:'recovered_same',backend:'webgl2'});results.push({recovery});}
  await page.screenshot({path:`/private/tmp/kt-wp12-${force?'webgl':'webgpu'}.png`});
  assert.deepEqual(errors,[]);await page.evaluate(()=>window.probe.dispose());await page.close();
 }
 await fs.writeFile('/private/tmp/kt-wp12-gpu-results.json',JSON.stringify({browser:browser.version(),results},null,2));
 console.log(`GPU tests passed: ${browser.version()}`);
} finally {await browser.close();await server.close();}
