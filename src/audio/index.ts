/**
 * The audio layer barrel. Cross-layer imports come through here.
 */
export { AudioEngine } from './AudioEngine';
export type { AudioEngineOptions, EngineStats, IntervalFactory } from './AudioEngine';
export { AudioAdapter, adaptPlatformContext, platformContextFactory } from './context';
export type { AudioContextLike, AudioContextFactory, AudioState } from './context';
export { generateBuffers, transferList, isAudioBufferSet, sameBuffers, DEFAULT_SAMPLE_RATE } from './buffers';
export type { AudioBufferSet } from './buffers';
export { VOICE_BUDGET, POOL_SPLIT, VoiceAllocator } from './VoiceBudget';
export { BUS_IDS, VOICE_KINDS } from './voices/Voice';
export type { BusId, VoiceKind } from './voices/Voice';
export { SECTION_IDS, PART_IDS, SECTION_BARS, TEMPO_RANGE, validateArrangement } from './score/Arrangement';
export type { Arrangement, Section, SectionId, PartId, Note, Mode } from './score/Arrangement';
export { Sequencer, LOOKAHEAD_SECONDS, SCHEDULE_INTERVAL_MS } from './score/Sequencer';
export type { Voicing, PartVoicing, BarInfo } from './score/Sequencer';
export { Conductor, FOLLOW_ON } from './score/Conductor';
export type { DirectorEvent } from './score/Conductor';
export { Score } from './score/Score';
export { GeneratedScoreSource, GENERATED_SCORE_SOURCE } from './score/source';
export type { ScoreSource } from './score/source';
export { JOURNEY, AUTHORED, CONVOY_MOTIF, SCORE_VOICING, arrangementFor, materialFor } from './score/material';
export type { LegMaterial, Chord } from './score/material';
export { Sidechain, SIDECHAIN, SIDECHAIN_DEPTH } from './synth/sidechain';
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
