/**
 * The audio layer barrel. Cross-layer imports come through here.
 */
export { AudioEngine } from './AudioEngine';
export type { AudioEngineOptions, EngineStats } from './AudioEngine';
export { AudioAdapter, adaptPlatformContext, platformContextFactory } from './context';
export type { AudioContextLike, AudioContextFactory, AudioState } from './context';
export { generateBuffers, transferList, isAudioBufferSet, sameBuffers, DEFAULT_SAMPLE_RATE } from './buffers';
export type { AudioBufferSet } from './buffers';
export { VOICE_BUDGET, POOL_SPLIT, VoiceAllocator } from './VoiceBudget';
export { BUS_IDS, VOICE_KINDS } from './voices/Voice';
export type { BusId, VoiceKind } from './voices/Voice';
export { LAYER_IDS, LAYERS } from './score/layers';
export type { LayerId, LayerTargets } from './score/layers';
export { LoadModel, nextFaultAccumulator } from './score/loadModel';
export type { LoadThresholds } from './score/loadModel';
export { CENTRED_POSITION_SOURCE } from './events/PositionSource';
export type { PositionSource } from './events/PositionSource';
export { EVENT_TREATMENT } from './events/eventSounds';
export type { Treatment } from './events/eventSounds';
export { AudioConsumer } from './events/AudioConsumer';
export type { EventConsumer } from './events/AudioConsumer';
export { UiSounds, UI_SOUND_IDS } from './ui/uiSounds';
export type { UiSoundId } from './ui/uiSounds';
export { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS, AudioSettingsStore, normaliseAudioSettings, detectReducedMotion } from './settings';
export type { AudioSettings } from './settings';
export { DEFAULT_ROOT_MIDI, pitchHz, pitchForPid, midiToHz } from './synth/tuning';
