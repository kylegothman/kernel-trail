import {
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial, Line2NodeMaterial,
  HemisphereLight, DirectionalLight, SpotLight, AdditiveBlending, DoubleSide, BufferAttribute, DataTexture, FloatType, RedFormat,
} from 'three/webgpu';
import type { BufferGeometry, Node, Texture } from 'three/webgpu';
import { Fn, storage, instanceIndex, attribute, cameraPosition, cameraProjectionMatrix, modelViewMatrix, exp, float, fract, fwidth, max, min, mix, normalView, positionLocal, positionView, positionWorld, sin, smoothstep, texture, uniform, uv, screenUV, sRGBTransferOETF, vec2, vec3, vec4 } from 'three/tsl';
import { FOCUS, SEMANTICS, CYAN, AMBER, MONOCHROME, NEUTRAL, VOID, LIGHTS, LINE, DASH, PULSE, PANEL, HATCH_ID, DISTANCE_ATTENUATION, CORRUPTION, linearColor, gainFor, resolveSemantic, DEFAULT_VISION_SETTINGS, LABEL_PLATE, type SemanticId, type VisionSettings } from '@design';
import { PROFILES, type QualityTier } from '@platform';
import { hash31, corrupt } from '../shaders/corruption.glsl';
import { decodeDepth } from '../shaders/depth';
import { gridNode } from '../shaders/grid.glsl';
export const ARCHETYPES = ['void-surface','emissive-line','emissive-panel','volumetric-beam','derezz-glass','holo-label','reflective-floor'] as const;
export type MaterialArchetype = typeof ARCHETYPES[number];
type InstanceNodes=Readonly<Record<'aColorGain'|'aStatePhase'|'aPatternId',Node<'vec4'>>>;
function instanceData(name:keyof InstanceNodes):Node<'vec4'> {
  return Fn((builder)=>{
    const context=builder.context as {instanceData?:InstanceNodes};
    return context.instanceData?.[name]??attribute<'vec4'>(name,'vec4');
  })();
}
export type TrailMaterial = MeshStandardNodeMaterial | MeshPhysicalNodeMaterial | MeshBasicNodeMaterial | Line2NodeMaterial;
export const materialTime = uniform(0);
export const materialPanic = uniform(0);
export const materialCorruption = uniform(0);
// Placeholder textures are replaced by the active chain before its first draw.
const emptyDepth = new DataTexture(new Float32Array([2000]),1,1,RedFormat,FloatType);
emptyDepth.needsUpdate=true;
export const beamSceneDepth=texture(emptyDepth);
export const textSceneDepth=texture(emptyDepth);
export const reflectionView=uniform(0);
export const textFade=uniform(1);
const emptyReflection=new DataTexture(new Uint8Array(4),1,1);emptyReflection.needsUpdate=true;
export const floorReflection=texture(emptyReflection);
export const beamFlowSpeed=uniform(0);
export const beamFlowCount=uniform(3);
const reducedMotion=uniform(0);
const monochrome=uniform(0);
const pulseDepth=uniform(PULSE.depth as number);
const semanticUniforms: { id:SemanticId; color:{value:import('three').Color}; gain:{value:number}; hz:{value:number} }[]=[];
const cache = new Map<string, TrailMaterial>();
const liveTransmission = new Set<object>();
let vision: Readonly<VisionSettings> = DEFAULT_VISION_SETTINGS;
/** Geometry-owned attributes avoid shared-material state leaking between instances. */
export function prepareSemanticGeometry(g: BufferGeometry, semantic: SemanticId): void {
  const count = g.getAttribute('position').count;
  const t = SEMANTICS[semantic];
  const color = linearColor(t.hex);
  const values = [[color.r,color.g,color.b,gainFor(t.family,t.level)],[0,0,t.pulseHz,1],[DASH[t.dash].on,DASH[t.dash].off,HATCH_ID[t.hatch],0]];
  ['aColorGain','aStatePhase','aPatternId'].forEach((name, channel) => {
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) data.set(values[channel] ?? [0,0,0,0], i * 4);
    g.setAttribute(name, new BufferAttribute(data, 4));
  });
}
export function setVisionSettings(settings: Readonly<VisionSettings>): void {
  vision=settings;reducedMotion.value=settings.reducedMotion?1:0;monochrome.value=settings.monochromeSemantics?1:0;
  pulseDepth.value=settings.emphasiseShapeChannel?PULSE.depthEmphasised:PULSE.depth;
  for(const entry of semanticUniforms){const t=resolveSemantic(entry.id,settings);entry.color.value=linearColor(t.hex);entry.gain.value=t.gain;entry.hz.value=t.pulseHz;}
}
export function getMaterial(archetype: MaterialArchetype, semantic: SemanticId, tier: QualityTier): TrailMaterial {
  const key = `${archetype}|${semantic}|${tier}`;
  const hit = cache.get(key); if (hit) return hit;
  const t = resolveSemantic(semantic, vision);
  const color = uniform(linearColor(t.hex));
  const gain = uniform(t.gain);
  const hz=uniform(t.pulseHz);
  semanticUniforms.push({id:semantic,color,gain,hz});
  const pulse = sin(materialTime.mul(hz).mul(Math.PI * 2)).mul(pulseDepth).add(1);
  const perInstanceFocus=Fn(builder=>builder.geometry.hasAttribute('aStatePhase')?instanceData('aStatePhase').w:float(1))();
  const emission = color.mul(mix(gain, gainFor(t.family, 'critical'), materialPanic)).mul(pulse).mul(perInstanceFocus);
  let m: TrailMaterial;
  switch (archetype) {
    case 'void-surface':
      m = new MeshStandardNodeMaterial({ color: linearColor(VOID.surface), roughness: 0.78, metalness: 0.10, envMapIntensity: 0, dithering: true });
      m.emissive.copy(linearColor(NEUTRAL.black)); break;
    case 'emissive-line': {
      m = new Line2NodeMaterial({ color: linearColor(t.hex), linewidth: LINE.widthM, worldUnits: true,
        dashed: t.dash !== 'solid' && t.dash !== 'none', dashSize: DASH[t.dash].on, gapSize: DASH[t.dash].off });
      m.colorNode = emission.mul(exp(positionWorld.sub(cameraPosition).length().mul(-DISTANCE_ATTENUATION))); break;
    }
    case 'emissive-panel': {
      m = new MeshStandardNodeMaterial({ color: linearColor(VOID.surface), roughness: 0.55, metalness: 0, dithering: true });
      const c = instanceData('aColorGain');
      const state = instanceData('aStatePhase');
      const pattern = instanceData('aPatternId');
      const d = min(uv(), uv().oneMinus());
      const edge = Fn((builder) => {
        if (!builder.geometry.hasAttribute('aBary')) return smoothstep(0, PANEL.edgeWidthM, min(d.x,d.y)).oneMinus();
        const bary=attribute<'vec3'>('aBary','vec3'), mask=attribute<'vec3'>('aEdgeMask','vec3');
        const lines=smoothstep(vec3(0),fwidth(bary).mul(1.4),bary).oneMinus().mul(mask);
        return max(lines.x,max(lines.y,lines.z));
      })();
      const stripe = (dir: Node<'vec2'>, period: number, duty: number, coords: Node<'vec2'> = uv()) => {
        const x = coords.dot(dir.normalize()).div(period); const w = fwidth(x).mul(1.5);
        return smoothstep(float(duty).sub(w), float(duty).add(w), fract(x)).oneMinus();
      };
      const diag = stripe(vec2(1,1),0.11,0.42);
      const cross = max(diag,stripe(vec2(1,-1),0.11,0.42));
      const scan = stripe(vec2(0,1),0.25,0.06,uv().add(vec2(0,materialTime.mul(0.06))));
      const lattice = max(stripe(vec2(1,0),0.08,0.10),stripe(vec2(0,1),0.08,0.10));
      const noise = hash31(positionLocal.div(CORRUPTION.cellMetres).floor()).greaterThanEqual(CORRUPTION.dropout).select(1,0);
      const hatch = pattern.z.equal(1).select(diag,pattern.z.equal(2).select(cross,pattern.z.equal(3).select(scan,pattern.z.equal(4).select(lattice,pattern.z.equal(5).select(noise,0)))));
      const rhythm = sin(materialTime.mul(mix(state.z,state.z.min(PULSE.reducedMotionMaxHz),reducedMotion)).mul(Math.PI*2).add(state.y.mul(Math.PI*2))).mul(pulseDepth).add(1);
      const amber=Object.values(AMBER).map(hex=>c.rgb.distance(uniform(linearColor(hex)).rgb).lessThan(0.00001)).reduce((a,b)=>a.or(b));
      const cyan=Object.values(CYAN).map(hex=>c.rgb.distance(uniform(linearColor(hex)).rgb).lessThan(0.00001)).reduce((a,b)=>a.or(b));
      const monoAmount=monochrome.mul(amber.or(cyan).select(1,0));
      const monoColor=amber.select(uniform(linearColor(MONOCHROME.amberHex)),uniform(linearColor(MONOCHROME.cyanHex)));
      const monoGain=amber.select(1,MONOCHROME.cyanGainScale);
      const semanticColor=mix(c.rgb,monoColor,monoAmount);
      const semanticGain=c.w.mul(mix(1,monoGain,monoAmount));
      const critical=amber.select(gainFor('amber','critical'),gainFor('cyan','critical'));
      const radiance = semanticColor.mul(mix(semanticGain, critical, materialPanic)).mul(rhythm).mul(state.w)
        .mul(edge.mul(PANEL.edgeTerm).add(hatch.mul(PANEL.patternTerm)).add(PANEL.bodyTerm));
      m.emissiveNode = corrupt(radiance, positionWorld, materialCorruption, materialTime);
      m.colorNode=uniform(linearColor(VOID.surface)).mul(float(1).sub(state.w.oneMinus().div(FOCUS.dimOthers).mul(1-FOCUS.matteDim)));
      const displacement=hash31(positionLocal.div(CORRUPTION.cellMetres).floor()).sub(0.5).mul(CORRUPTION.displaceMetres).mul(materialCorruption);
      m.positionNode = positionLocal.add(vec3(displacement,0,displacement));
      break;
    }
    case 'volumetric-beam': {
      m = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, side: DoubleSide });
      const radial = sin(uv().x.mul(Math.PI*2)).abs().pow(1.6);
      const ends = smoothstep(0,0.04,uv().y).mul(smoothstep(0.96,1,uv().y).oneMinus());
      const speed=mix(beamFlowSpeed,beamFlowSpeed.min(PULSE.reducedMotionMaxHz),reducedMotion);
      const flow=beamFlowSpeed.greaterThan(0).select(fract(uv().y.mul(beamFlowCount).sub(materialTime.mul(speed))).oneMinus().pow(3).mul(0.65).add(0.35),1);
      const nearFlow=tier==='low'?positionWorld.sub(cameraPosition).length().lessThan(40).select(flow,1):flow;
      const soft=decodeDepth(beamSceneDepth.sample(screenUV)).add(positionView.z).div(0.35).clamp(0,1);
      const a = radial.mul(ends).mul(nearFlow).mul(mix(soft,1,reflectionView));
      m.colorNode = emission.mul(a); m.opacityNode = a; break;
    }
    case 'derezz-glass': {
      if (tier === 'high') m = new MeshPhysicalNodeMaterial({ color: linearColor(VOID.surface), emissive: linearColor(t.hex), emissiveIntensity: gainFor(t.family,'active'), transmission: 0.92, thickness: 0.35, ior: 1.34, roughness: 0.08, metalness: 0, attenuationColor: linearColor(t.hex), attenuationDistance: 0.8, transparent: true, dithering: true });
      else {
        m = new MeshStandardNodeMaterial({ color: linearColor(VOID.surface), roughness: 0.15, metalness: 0, transparent: true, opacity: 0.55, dithering: true });
        const fresnel = normalView.normalize().dot(positionView.normalize()).abs().oneMinus().pow(3);
        m.emissiveNode = emission.mul(fresnel.mul(1.6).add(0.18));
      }
      if(tier==='high') m.emissiveNode=uniform(linearColor(t.hex)).mul(gainFor(t.family,'active')).mul(perInstanceFocus);
      break;
    }
    case 'holo-label': m = new MeshBasicNodeMaterial({ color: linearColor(t.hex), transparent: true, depthWrite: false }); break;
    case 'reflective-floor': {
      m = new MeshBasicNodeMaterial({ color: linearColor(VOID.floor) });
      let floor=gridNode(PROFILES[tier].gridMinorRangeM).add(uniform(linearColor(VOID.floor)));
      if(tier==='high'){
        const ndv=normalView.normalize().dot(positionView.negate().normalize()).clamp(0,1);
        const blur=ndv.oneMinus().mul(0.14*0.06);
        const reflection=floorReflection.sample(screenUV.add(vec2(blur,0))).rgb
          .add(floorReflection.sample(screenUV.sub(vec2(blur,0))).rgb)
          .add(floorReflection.sample(screenUV.add(vec2(0,blur))).rgb)
          .add(floorReflection.sample(screenUV.sub(vec2(0,blur))).rgb).mul(0.25);
        floor=floor.add(reflection.mul(ndv.oneMinus().pow(5).mul(0.98).add(0.02)).mul(0.42));
      }
      m.colorNode=floor;break;
    }
  }
  m.toneMapped = false;
  m.name = `kt.${key}`;
  cache.set(key,m);
  return m;
}
/** Track scene objects, not cached material count. */
export function acquireGlass(owner: object, semantic: SemanticId, tier: QualityTier): TrailMaterial {
  if (tier === 'high' && (liveTransmission.has(owner) || liveTransmission.size < PROFILES.high.transmissiveCap)) {
    liveTransmission.add(owner); return getMaterial('derezz-glass',semantic,'high');
  }
  return getMaterial('derezz-glass',semantic,'medium');
}
export function releaseGlass(owner: object): void { liveTransmission.delete(owner); }
export function createAmbientLight(): HemisphereLight { return new HemisphereLight(linearColor(LIGHTS.ambient.skyHex),linearColor(LIGHTS.ambient.groundHex),LIGHTS.ambient.intensity); }
export function createKeyLight(): DirectionalLight { const l = new DirectionalLight(linearColor(NEUTRAL.white),LIGHTS.key.intensity); l.position.set(...LIGHTS.key.direction).normalize(); l.castShadow = false; return l; }
export function createReadLight(): SpotLight { const l = new SpotLight(linearColor(NEUTRAL.white),LIGHTS.read.intensity); l.penumbra = LIGHTS.read.penumbra; l.castShadow = false; return l; }
/** Atlas material is an application-owned specialization of the label archetype. */
export function createAtlasMaterial(atlas: Texture, semantic: SemanticId): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide });
  const atlasNode = texture(atlas);
  const sample = atlasNode.sample(attribute<'vec2'>('aAtlasUv','vec2').div(atlasNode.size(float(0)) as Node<'vec2'>)); const channel = attribute<'float'>('aAtlasChannel','float');
  const alpha = channel.lessThan(0.5).select(sample.r,channel.lessThan(1.5).select(sample.g,channel.lessThan(2.5).select(sample.b,sample.a)));
  const width = fwidth(alpha).max(0.00001);
  const visible=positionView.z.negate().lessThanEqual(decodeDepth(textSceneDepth.sample(screenUV)).add(0.001));
  const labelColor=uniform(linearColor(resolveSemantic(semantic,vision).hex));
  const entry={id:semantic,color:labelColor,gain:{value:0},hz:{value:0}};semanticUniforms.push(entry);
  m.addEventListener('dispose',()=>{const index=semanticUniforms.indexOf(entry);if(index>=0)semanticUniforms.splice(index,1);});
  m.fragmentNode = vec4((sRGBTransferOETF(labelColor) as Node<'vec3'>),visible.select(smoothstep(float(0.5).sub(width),float(0.5).add(width),alpha).mul(textFade),0));
  return m;
}
export function disposeMaterials(): void { for (const m of cache.values()) m.dispose(); cache.clear(); liveTransmission.clear(); semanticUniforms.length=0; }
export function materialCacheSize(): number { return cache.size; }

export function createLabelPlateMaterial(): MeshBasicNodeMaterial {
  const material=new MeshBasicNodeMaterial({transparent:true,depthWrite:false,toneMapped:false});
  const visible=positionView.z.negate().lessThanEqual(decodeDepth(textSceneDepth.sample(screenUV)).add(0.001));
  material.fragmentNode=vec4((sRGBTransferOETF(uniform(linearColor(LABEL_PLATE.hex))) as Node<'vec3'>),visible.select(LABEL_PLATE.opacity,0));
  return material;
}

/** A decal specialization of reflective-floor; callers instance repeated pools. */
export function createFloorPoolMaterial(semantic:SemanticId):MeshBasicNodeMaterial {
  const t=SEMANTICS[semantic];
  const material=new MeshBasicNodeMaterial({transparent:true,blending:AdditiveBlending,depthWrite:false,toneMapped:false});
  const falloff=uv().sub(0.5).mul(2).length().oneMinus().max(0).pow(2.2);
  material.colorNode=uniform(linearColor(t.hex)).mul(gainFor(t.family,'ambient')).mul(falloff);
  material.opacityNode=falloff;material.name='kt.reflective-floor.pool';return material;
}
/** Medium's world-owned emissive proxy, reflected about floor y=0 by its host. */
export function createReflectionProxyMaterial(semantic:SemanticId):MeshBasicNodeMaterial {
  const t=SEMANTICS[semantic];
  const material=new MeshBasicNodeMaterial({transparent:true,depthWrite:false,toneMapped:false,side:DoubleSide});
  const fresnel=normalView.normalize().dot(positionView.negate().normalize()).abs().oneMinus().pow(5).mul(0.98).add(0.02);
  material.colorNode=uniform(linearColor(t.hex)).mul(gainFor(t.family,t.level));
  material.opacityNode=exp(positionWorld.y.abs().mul(-0.22)).mul(fresnel).mul(0.42);
  material.name='kt.reflective-floor.proxy';return material;
}

/** Particle specialization of volumetric-beam, sharing the same emissive semantics. */
export function createParticleMaterial(center:Node<'vec3'>,semantic:SemanticId):MeshBasicNodeMaterial {
  const t=SEMANTICS[semantic];
  const material=new MeshBasicNodeMaterial({transparent:true,blending:AdditiveBlending,depthWrite:false,toneMapped:false});
  material.vertexNode=cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(center,1)).add(vec4(positionLocal.xy.mul(0.06),0,0)));
  const a=uv().sub(0.5).mul(2).length().oneMinus().max(0).pow(2);
  material.colorNode=uniform(linearColor(t.hex)).mul(gainFor(t.family,t.level)).mul(a);material.opacityNode=a;
  material.name='kt.volumetric-beam.particles';return material;
}

/** Per-batch storage bindings specialize the cached panel graph, not each instance. */
export function createInstanceMaterial(base:TrailMaterial,attributes:readonly import('three/webgpu').StorageInstancedBufferAttribute[]):TrailMaterial {
  const material=base.clone();
  const a=attributes[0],b=attributes[1],c=attributes[2];
  if(!a||!b||!c)throw new Error('Three packed instance buffers required');
  const instanceData:InstanceNodes={aColorGain:storage(a,'vec4',a.count).toReadOnly().element(instanceIndex),
    aStatePhase:storage(b,'vec4',b.count).toReadOnly().element(instanceIndex),aPatternId:storage(c,'vec4',c.count).toReadOnly().element(instanceIndex)};
  if('emissiveNode' in material&&material.emissiveNode)material.emissiveNode=(material.emissiveNode as Node<'vec3'>).context({instanceData});
  if(material.colorNode)material.colorNode=(material.colorNode as Node<'vec3'>).context({instanceData});
  material.name=base.name+'.batch';return material;
}
export function createDepthPrepassMaterial():MeshBasicNodeMaterial {
  const material=new MeshBasicNodeMaterial({colorWrite:false,depthWrite:true,depthTest:true,toneMapped:false});
  material.name='kt.void-surface.depth';return material;
}

export function createLabelHairlineMaterial(semantic:SemanticId):MeshBasicNodeMaterial {
  const token=resolveSemantic(semantic,vision);
  const material=new MeshBasicNodeMaterial({toneMapped:false});
  material.colorNode=uniform(linearColor(token.hex)).mul(token.gain);
  material.name='kt.emissive-line.label-hairline';return material;
}

/** Factory-owned specialization per focus group; the triple-key base cache is unchanged. */
const focusGroups = new WeakMap<object, Map<import('three/webgpu').Material, TrailMaterial>>();
const focusWeights = new WeakMap<import('three/webgpu').Material, { value: number }>();
export function materialFocusUniform(material: import('three/webgpu').Material): {value:number} | undefined { return focusWeights.get(material); }
export function acquireFocusMaterial(owner: object, base: import('three/webgpu').Material): import('three/webgpu').Material {
  if (!('isNodeMaterial' in base) || !base.isNodeMaterial) return base;
  let group=focusGroups.get(owner);
  if(!group){group=new Map();focusGroups.set(owner,group);}
  const hit=group.get(base); if(hit)return hit;
  const material=(base as TrailMaterial).clone(), weight=uniform(1);
  const matte=float(1).sub(float(1).sub(weight).div(FOCUS.dimOthers).mul(1-FOCUS.matteDim));
  if(material.fragmentNode) {
    const fragment=material.fragmentNode as Node<'vec4'>;
    material.fragmentNode=vec4(fragment.rgb.mul(weight),fragment.a);
  } else if('emissive' in material) {
    const body=material.colorNode??uniform(material.color);
    material.colorNode=(body as Node<'vec3'>).mul(matte);
    const emission=material.emissiveNode??uniform(material.emissive).mul(material.emissiveIntensity);
    material.emissiveNode=(emission as Node<'vec3'>).mul(weight);
  } else {
    const color=material.colorNode??uniform(material.color);
    material.colorNode=base.name.includes('reflective-floor')
      ? (color as Node<'vec3'>).sub(uniform(linearColor(VOID.floor)).rgb).mul(weight).add(uniform(linearColor(VOID.floor)).rgb.mul(matte))
      : (color as Node<'vec3'>).mul(weight);
  }
  material.name=base.name+'.focus';group.set(base,material);focusWeights.set(material,weight);
  return material;
}
export function releaseFocusMaterials(owner: object): void {
  const group=focusGroups.get(owner); if(!group)return;
  for(const material of group.values()){focusWeights.delete(material);material.dispose();}
  group.clear();focusGroups.delete(owner);
}
