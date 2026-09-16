/**
 * The codex. Narrative bible 14; WP-17 specification section 5.
 *
 * An entry becomes readable by encountering the pathology, never by reading
 * ahead. `open(id)` on a locked entry returns a locked result and no code
 * path returns `concept` text for an entry that is not in
 * `RunState.codexUnlocked` or the profile's `seen` set. The list is
 * chronological by first encounter, which is the profile's `seen` order,
 * and there is no index of locked entries.
 *
 * The codex is an `EventConsumer` on the shared queue's `codex` slot, after
 * the world and the audio, because it asks the world whether the pathology
 * is on screen before it offers an entry. That question has no answer yet
 * (scope correction S9): `OnScreen` is injected and defaults to always true.
 *
 * Across runs the `concept` of a seen entry stays readable through the
 * profile; the worked example and the counterfactual are per run and are
 * rebuilt from this run's data. The counterfactual is WP-18's and is null
 * here.
 */
import type { KernelEvent, Tick } from '@kernel/types';
import type { AfflictionId, AfflictionRemedy, LegId, RunState } from '@game/types';
import type { Store } from '@game/store';
import type { CodexCounterfactual, CodexEntry, CodexProfileState, CodexWorkedExample } from '@game/codexTypes';
import type { EventConsumer } from '@world/FrameEventQueue';
import type { CodexRegistry } from './entries';
import { isCommandOccurrence, matchesUnlock, structureFor, type CodexSignal } from './triggers';
import { buildWorkedExample } from './workedExample';
import { buildIndex, type CodexSearchIndex } from './search';

/** Whether the named world structure is currently on screen. */
export type OnScreen = (structureId: string) => boolean;

// TODO(astra): WP-19 wires OnScreen to the focus registry
const ALWAYS_ON_SCREEN: OnScreen = () => true;

export interface CodexOptions {
  readonly registry: CodexRegistry;
  readonly runStore: Store<RunState>;
  /** The profile carried across runs. Copied; read the result through `profile()`. */
  readonly profile?: CodexProfileState;
  /** The current leg, from the host; `RunState` holds only the index. */
  readonly currentLeg: () => LegId;
  /** Named quantities an entry's prose interpolates, read at unlock. */
  readonly metrics?: () => Readonly<Record<string, number>>;
  readonly onScreen?: OnScreen;
  /** How many recent events the worked example may draw on. */
  readonly logDepth?: number;
}

export type CodexOpenResult =
  | { readonly kind: 'locked'; readonly id: string }
  | {
      readonly kind: 'readable';
      readonly entry: CodexEntry;
      /** The remedy after `remedyVisibility` has been applied. */
      readonly remedy: AfflictionRemedy | null;
      readonly readableVia: 'run' | 'profile';
    };

export interface CodexListItem {
  readonly id: string;
  readonly title: string;
  readonly unlockedThisRun: boolean;
}

export type UnlockListener = (id: string, example: CodexWorkedExample) => void;

const DEFAULT_LOG_DEPTH = 64;

export class Codex implements EventConsumer {
  readonly name = 'codex';

  private readonly registry: CodexRegistry;
  private readonly runStore: Store<RunState>;
  private readonly currentLeg: () => LegId;
  private readonly metrics: () => Readonly<Record<string, number>>;
  private readonly onScreen: OnScreen;
  private readonly logDepth: number;
  private readonly log: KernelEvent[] = [];
  private readonly examples = new Map<string, CodexWorkedExample>();
  private readonly counterfactuals = new Map<string, CodexCounterfactual>();
  /** Entries whose trigger fired while their structure was off screen. */
  private readonly held = new Map<string, KernelEvent | null>();
  /** Matching command submissions seen per entry, for a `command` unlock's `nth` (WP-21 section 5). */
  private readonly commandCounts = new Map<string, number>();
  private readonly listeners: UnlockListener[] = [];
  private readonly unsubscribes: (() => void)[] = [];
  private seen: string[];
  private demonstrated: string[];
  private firstSeen: Record<string, { runId: string; legId: LegId }>;
  private lastAfflictions = new Set<AfflictionId>();
  private lastObjectives = new Set<string>();
  private lastEvent: KernelEvent | null = null;
  /** Signals noticed during a store flush, applied in `endFrame`, since a flush listener may not mutate. */
  private readonly deferred: CodexSignal[] = [];

  constructor(options: CodexOptions) {
    this.registry = options.registry;
    this.runStore = options.runStore;
    this.currentLeg = options.currentLeg;
    this.metrics = options.metrics ?? (() => this.defaultMetrics());
    this.onScreen = options.onScreen ?? ALWAYS_ON_SCREEN;
    this.logDepth = options.logDepth ?? DEFAULT_LOG_DEPTH;
    const profile = options.profile;
    this.seen = profile === undefined ? [] : [...profile.seen];
    this.demonstrated = profile === undefined ? [] : [...profile.demonstrated];
    this.firstSeen = profile === undefined ? {} : { ...profile.firstSeen };

    const run = this.runStore.get();
    this.lastAfflictions = this.afflictionsOf(run);
    this.lastObjectives = new Set(run.objectivesMet);
    // An entry unlocked in this run before the codex existed (a resumed
    // save) is seen, with this run as its first encounter if none is recorded.
    for (const id of run.codexUnlocked) this.noteSeen(id, run);

    this.unsubscribes.push(
      this.runStore.subscribe((s) => this.watchRun(s)),
    );
  }

  /* ---- EventConsumer ------------------------------------------------ */

  consume(event: KernelEvent): void {
    this.log.push(event);
    if (this.log.length > this.logDepth) this.log.splice(0, this.log.length - this.logDepth);
    this.lastEvent = event;
    this.offer({ kind: 'event', event }, event);
  }

  /**
   * Apply the signals the store flush noticed, then re-check held entries.
   * The frame pipeline (architecture 2.2) flushes the stores before it
   * routes events, so this runs after every flush of the frame.
   */
  endFrame(): void {
    const pending = this.deferred.splice(0, this.deferred.length);
    for (const signal of pending) this.offer(signal, this.lastEvent);
    this.retryHeld();
  }

  /* ---- host-reported facts ------------------------------------------ */

  /**
   * Facts the host reports: a crossing option taken or a leg completed from
   * the leg runner, a command submitted from `Shell.onCommand`, and a metric
   * read from the telemetry store once per tick (WP-21 section 5).
   */
  signal(signal: CodexSignal): void {
    this.offer(signal, this.lastEvent);
  }

  /** The player performed this entry's remedy successfully. */
  markDemonstrated(id: string): void {
    if (!this.demonstrated.includes(id)) this.demonstrated.push(id);
  }

  /** WP-18 supplies the replay; the codex only holds the result per run. */
  setCounterfactual(id: string, counterfactual: CodexCounterfactual): void {
    this.counterfactuals.set(id, counterfactual);
  }

  onUnlock(listener: UnlockListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /* ---- reading ------------------------------------------------------ */

  isReadable(id: string): boolean {
    return this.registry.has(id) && (this.unlockedThisRun(id) || this.seen.includes(id));
  }

  open(id: string): CodexOpenResult {
    if (!this.isReadable(id)) return { kind: 'locked', id };
    const definition = this.registry.reveal(id);
    const unlockedThisRun = this.unlockedThisRun(id);
    const entry: CodexEntry = {
      ...definition,
      workedExample: this.examples.get(id) ?? null,
      counterfactual: this.counterfactuals.get(id) ?? null,
    };
    return {
      kind: 'readable',
      entry,
      remedy: this.visibleRemedy(definition, unlockedThisRun),
      readableVia: unlockedThisRun ? 'run' : 'profile',
    };
  }

  /** Readable entries only, chronological by first encounter. */
  list(): readonly CodexListItem[] {
    return this.readableIds().map((id) => ({
      id,
      title: this.registry.reveal(id).title,
      unlockedThisRun: this.unlockedThisRun(id),
    }));
  }

  /** The search index over readable entries and nothing else. */
  buildIndex(): CodexSearchIndex {
    return buildIndex(this.readableIds().map((id) => this.open(id)).flatMap((r) => (r.kind === 'readable' ? [r.entry] : [])));
  }

  profile(): CodexProfileState {
    return { seen: [...this.seen], demonstrated: [...this.demonstrated], firstSeen: { ...this.firstSeen } };
  }

  /** Ids whose trigger fired while their structure was off screen. */
  get heldIds(): readonly string[] {
    return [...this.held.keys()];
  }

  dispose(): void {
    for (const u of this.unsubscribes) u();
    this.unsubscribes.length = 0;
    this.listeners.length = 0;
  }

  /* ---- internals ---------------------------------------------------- */

  private unlockedThisRun(id: string): boolean {
    return this.runStore.get().codexUnlocked.includes(id);
  }

  /**
   * Chronological by first encounter: the profile's `seen` order, to which
   * this run's unlocks were appended as they happened.
   */
  private readableIds(): readonly string[] {
    const run = this.runStore.get();
    const ordered = this.seen.filter((id) => this.registry.has(id));
    for (const id of run.codexUnlocked) if (!ordered.includes(id) && this.registry.has(id)) ordered.push(id);
    return ordered;
  }

  /** Pre-flight ruling 6.3. */
  private visibleRemedy(entry: CodexEntry, unlockedThisRun: boolean): AfflictionRemedy | null {
    switch (entry.remedyVisibility) {
      case 'immediate':
        return entry.remedy;
      case 'on_unlock':
        return unlockedThisRun ? entry.remedy : null;
      case 'after_first_success':
        return this.demonstrated.includes(entry.id) ? entry.remedy : null;
      case 'never':
        return null;
      default:
        return null;
    }
  }

  private afflictionsOf(run: Readonly<RunState>): Set<AfflictionId> {
    const ids = new Set<AfflictionId>();
    for (const m of run.convoy) for (const a of m.afflictions) ids.add(a.id);
    return ids;
  }

  private watchRun(run: Readonly<RunState>): void {
    const afflictions = this.afflictionsOf(run);
    for (const id of afflictions) if (!this.lastAfflictions.has(id)) this.deferred.push({ kind: 'affliction', id });
    this.lastAfflictions = afflictions;
    const objectives = new Set(run.objectivesMet);
    for (const id of objectives) if (!this.lastObjectives.has(id)) this.deferred.push({ kind: 'objective', id });
    this.lastObjectives = objectives;
  }

  /** The count of this entry's matching command submissions after this one. */
  private countCommand(id: string): number {
    const next = (this.commandCounts.get(id) ?? 0) + 1;
    this.commandCounts.set(id, next);
    return next;
  }

  private offer(signal: CodexSignal, trigger: KernelEvent | null): void {
    for (const { id, unlock } of this.registry.unlocks()) {
      if (this.unlockedThisRun(id)) continue;
      const occurrence = unlock.kind === 'command' && isCommandOccurrence(unlock, signal) ? this.countCommand(id) : 1;
      if (!matchesUnlock(unlock, signal, occurrence)) continue;
      const structure = structureFor(unlock);
      if (structure !== null && !this.onScreen(structure)) {
        if (!this.held.has(id)) this.held.set(id, trigger);
        continue;
      }
      this.unlock(id, trigger);
    }
  }

  private retryHeld(): void {
    for (const [id, trigger] of [...this.held]) {
      const unlock = this.registry.unlockOf(id);
      if (unlock === null || this.unlockedThisRun(id)) {
        this.held.delete(id);
        continue;
      }
      const structure = structureFor(unlock);
      if (structure === null || this.onScreen(structure)) {
        this.held.delete(id);
        this.unlock(id, trigger);
      }
    }
  }

  private unlock(id: string, trigger: KernelEvent | null): void {
    const run = this.runStore.get();
    const capturedAtTick: Tick = trigger?.tick ?? this.lastEvent?.tick ?? (0 as Tick);
    const example = buildWorkedExample({
      log: this.log,
      trigger,
      run,
      legId: this.currentLeg(),
      capturedAtTick,
      metrics: this.metrics(),
    });
    this.examples.set(id, example);
    // Derived from events, so replay reproduces it: a game-state write, not a
    // kernel mutation, and therefore not a CommandBus decision (ruling 6.9).
    this.runStore.mutate((s) => {
      if (!s.codexUnlocked.includes(id)) s.codexUnlocked.push(id);
    });
    this.noteSeen(id, this.runStore.get());
    for (const l of this.listeners) l(id, example);
  }

  private noteSeen(id: string, run: Readonly<RunState>): void {
    if (!this.seen.includes(id)) this.seen.push(id);
    if (this.firstSeen[id] === undefined) this.firstSeen[id] = { runId: run.runId, legId: this.currentLeg() };
  }

  private defaultMetrics(): Readonly<Record<string, number>> {
    const run = this.runStore.get();
    return {
      legProgress: run.legProgress,
      cycles: run.resources.cycles,
      quota: run.resources.quota,
      blocks: run.resources.blocks,
      bandwidth: run.resources.bandwidth,
      survivors: run.convoy.filter((m) => m.status !== 'derezzed').length,
    };
  }
}

export function createCodex(options: CodexOptions): Codex {
  return new Codex(options);
}
