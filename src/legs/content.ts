/**
 * KERNEL TRAIL: the leg content companion (WP-21 section 1).
 *
 * The frozen `Leg` cannot carry a crossing, an interaction handler, an epitaph
 * stone, a codex entry, a deferred terminal handler or a layout, and every leg
 * needs all six. `LegContent` sits beside the default export of a leg module
 * and carries them; the runner, the harness, the terminal and the codex read
 * it, and `Leg` stays exactly as it is.
 *
 * `validateContent` is the load-time check the harness runs on every shipped
 * leg. It runs `populate` against a recording setup context, never a kernel,
 * so a crossing whose lock the leg never declares is caught before any run.
 */
import type { ConvoyMemberId, Pid } from '@kernel/types';
import type { Instruction } from '@kernel/process/Program';
import type { CodexEntry } from '@game/codexTypes';
import type { CrossingDef } from '@game/crossing/Crossing';
import type { EpitaphTemplate } from '@game/convoy/derezz';
import type { InteractionHandler } from '@game/RunDirector';
import { initialRunState } from '@game/replay/runReplay';
import type { ReplayKernel } from '@game/replay/types';
import type { Leg, LegId, LegSetupContext, RunState } from '@game/types';
import type { CommandRun } from '@terminal/registry';
import type { LegLayout } from './layout';

/**
 * The names whose handlers a later leg supplies, mirrored from
 * `@terminal/registry`'s `DEFERRED_COMMANDS` because the legs layer may only
 * type-import from the terminal; `tests/legs/content.test.ts` pins the two
 * lists equal so they cannot drift.
 */
export const LEG_DEFERRED_COMMANDS = ['hyper', 'guest', 'migrate', 'belady'] as const;

/**
 * WP-L04 ruling 1: the synchronisation workload a leg needs and `ProcessSpec`
 * cannot carry.
 *
 * `populate` reaches the kernel only through `LegSetupContext`, which has no
 * channel for a program, so every process a leg spawns runs a generated
 * compute-and-access program. A leg that teaches synchronisation therefore has
 * no way to make one of its own processes take a lock, and nothing it declares
 * is ever contended. `programs` is keyed by `ProcessSpec.name`: a spawn whose
 * name is present runs that instruction list instead of a generated program,
 * and `install` runs once after `populate`, with the pids keyed by the same
 * names, for the shared regions, cells and scenarios those programs read.
 *
 * Both frozen files stay untouched. The seam is here, beside the rest of the
 * companion, and `createHeadlessSetupContext` is the one place that applies it,
 * so the live runner, the checkpoint rollback, `resume` and the replay worker
 * all populate identically.
 */
export interface LegWorkload {
  /** Keyed by `ProcessSpec.name`. A name the leg never spawns is a `validateContent` problem. */
  readonly programs: Readonly<Record<string, readonly Instruction[]>>;
  /** Once after populate, with what populate spawned. The pids are the live kernel's. */
  install?(kernel: ReplayKernel, spawned: ReadonlyMap<string, Pid>): void;
}

export interface LegContent {
  readonly legId: LegId;
  /** Positive designed throughput target; omitted until the balance pass authors it. */
  readonly throughputTarget?: number;
  /** Declared through the runner at entry; formulas are WP-19's. */
  readonly crossings: readonly CrossingDef[];
  /** Keyed by InteractionDef.id; the target names the Program an integrity cost lands on. */
  readonly interactions: Readonly<Record<string, { readonly run: InteractionHandler; readonly target: ConvoyMemberId | null }>>;
  /** This leg's own stones only; the shared forty-eight live in src/legs/epitaphs.ts. */
  readonly epitaphs: readonly EpitaphTemplate[];
  /** Registered into the codex registry by the host; concept text is the leg's. */
  readonly codex: readonly CodexEntry[];
  /** Only for a name in LEG_DEFERRED_COMMANDS that this leg owns. */
  readonly terminalHandlers: Readonly<Record<string, CommandRun>>;
  /** Renderer-free; the boot package builds the scene from it. */
  readonly layout: LegLayout;
  /** Programs for the processes `populate` spawns, and the kernel state they read. */
  readonly workload?: LegWorkload;
  /**
   * WP-24 section 3: argument options for a verb whose anchor string carries
   * one after the colon (`anchor.disc_plinth:blocks`), keyed by
   * InteractionDef.id. The interactions panel renders a select and dispatches
   * the chosen anchor. L07's split ids need nothing; L00 declares nothing yet
   * because its two panels are its UI.
   */
  readonly arguments?: Readonly<Record<string, readonly { readonly anchor: string; readonly label: string }[]>>;
}

export interface LegModule {
  readonly default: Leg;
  readonly content: LegContent;
}

/** What `populate` declared, recorded without a kernel. */
interface Declarations {
  readonly sync: ReadonlySet<string>;
  readonly resources: ReadonlySet<string>;
  readonly bound: ReadonlySet<ConvoyMemberId>;
  /** `ProcessSpec.name` per spawn, in spawn order, so a workload program can be matched to one. */
  readonly spawned: ReadonlySet<string>;
  readonly error: string | null;
}

/** A small deterministic generator so a `populate` that draws from `ctx.rng` terminates and sees in-range values. */
function probeRng(): LegSetupContext['rng'] {
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return { next, int: (a, b) => a + Math.floor(next() * (b - a)) };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Run `populate` against a recording `LegSetupContext` over a fresh default run, and keep what it declared. */
export function recordDeclarations(leg: Leg, run: RunState = probeRunState(leg)): Declarations {
  const sync = new Set<string>();
  const resources = new Set<string>();
  const bound = new Set<ConvoyMemberId>();
  const spawned = new Set<string>();
  let nextPid = 2;
  const ctx: LegSetupContext = {
    run,
    rng: probeRng(),
    spawn: (spec) => { spawned.add(spec.name); return (nextPid++) as Pid; },
    bind: (member) => { bound.add(member); },
    declareResource: (id) => { resources.add(id); },
    declareSync: (id) => { sync.add(id); },
  };
  try {
    leg.populate(ctx);
  } catch (error) {
    return { sync, resources, bound, spawned, error: describe(error) };
  }
  return { sync, resources, bound, spawned, error: null };
}

/** The run a leg's `populate` is probed against: the shared roster at the leg's index, the operator shell defaults. */
export function probeRunState(leg: Leg): RunState {
  const run = initialRunState(0x4b54524c, 'shell', 'operator');
  run.legIndex = leg.index;
  return run;
}

const list = (items: readonly string[]): string => `[${items.join(', ')}]`;

/**
 * Problems, never a throw. Six kinds: the `legId`; a crossing whose `legId`
 * differs or whose `lockId` `populate` never declares; an interaction the
 * leg does not declare, a declared one with no companion entry (the director
 * refuses it as unavailable), or a declared one with an integrity cost and no
 * target; a codex entry whose `unlock` names an objective the leg does not
 * declare; a terminal handler for a name outside `LEG_DEFERRED_COMMANDS`; and
 * a layout whose anchor set is not the interaction anchors plus its extras;
 * a workload program keyed by a name `populate` never spawns, which would
 * never run (WP-L04 ruling 1); and an `arguments` entry for an interaction
 * the leg does not declare, or one with no options (WP-24 section 3).
 */
export function validateContent(leg: Leg, content: LegContent): readonly string[] {
  const problems: string[] = [];
  if (content.legId !== leg.id) problems.push(`legId: the content is for ${content.legId}, the leg is ${leg.id}`);
  if (content.throughputTarget !== undefined && (!Number.isFinite(content.throughputTarget) || content.throughputTarget <= 0)) {
    problems.push('throughputTarget: expected a positive finite number');
  }

  const declared = recordDeclarations(leg);
  if (declared.error !== null) problems.push(`populate threw against the recording context: ${declared.error}`);
  for (const def of content.crossings) {
    if (def.legId !== leg.id) problems.push(`crossing ${def.id}: legId ${def.legId} is not ${leg.id}`);
    if (!declared.sync.has(def.lockId)) problems.push(`crossing ${def.id}: lockId ${def.lockId} is never declared by populate; declareSync ids ${list([...declared.sync].sort())}`);
  }

  const workload = content.workload;
  if (workload !== undefined) {
    for (const name of Object.keys(workload.programs).sort()) {
      if (!declared.spawned.has(name)) problems.push(`workload program ${name}: populate spawns no process with that name; spawn names ${list([...declared.spawned].sort())}`);
      else if (workload.programs[name]?.length === 0) problems.push(`workload program ${name}: an empty instruction list would leave the process with no program`);
    }
  }

  const interactionIds = new Set(leg.interactions.map((def) => def.id));
  for (const id of Object.keys(content.interactions).sort()) {
    if (!interactionIds.has(id)) problems.push(`interaction ${id}: the leg declares no InteractionDef with that id`);
  }
  for (const def of leg.interactions) {
    const entry = content.interactions[def.id];
    if (entry === undefined) problems.push(`interaction ${def.id}: the companion registers no handler, so the director refuses it as unavailable`);
    if ((def.cost.integrity ?? 0) > 0 && (entry === undefined || entry.target === null)) {
      problems.push(`interaction ${def.id}: costs ${def.cost.integrity} integrity and names no target Program`);
    }
  }

  for (const [id, choices] of Object.entries(content.arguments ?? {})) {
    if (!interactionIds.has(id)) problems.push(`arguments ${id}: the leg declares no InteractionDef with that id`);
    if (choices.length === 0) problems.push(`arguments ${id}: an empty option list would render a select with nothing to choose`);
  }

  const objectiveIds = new Set(leg.objectives.map((objective) => objective.id));
  for (const entry of content.codex) {
    if (entry.unlock.kind === 'objective' && !objectiveIds.has(entry.unlock.id)) {
      problems.push(`codex ${entry.id}: unlock names objective ${entry.unlock.id}, which the leg does not declare`);
    }
  }

  for (const name of Object.keys(content.terminalHandlers).sort()) {
    if (!(LEG_DEFERRED_COMMANDS as readonly string[]).includes(name)) problems.push(`terminal handler ${name}: not a deferred command ${list(LEG_DEFERRED_COMMANDS)}; every other handler is WP-15's`);
  }

  const anchorIds = content.layout.anchors.map((anchor) => anchor.id);
  const duplicates = anchorIds.filter((id, index) => anchorIds.indexOf(id) !== index);
  if (duplicates.length > 0) problems.push(`layout: duplicate anchor ids ${list([...new Set(duplicates)].sort())}`);
  const expected = new Set([...leg.interactions.map((def) => def.anchor), ...content.layout.extras]);
  const present = new Set(anchorIds);
  const missing = [...expected].filter((id) => !present.has(id)).sort();
  const unexpected = [...present].filter((id) => !expected.has(id)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    problems.push(`layout: anchors must be the interaction anchors plus extras; missing ${list(missing)}; unexpected ${list(unexpected)}`);
  }
  for (const anchor of content.layout.anchors) {
    if (anchor.kind === 'custom' && (anchor.structure === undefined || anchor.structure === '')) problems.push(`layout: custom anchor ${anchor.id} names no structure`);
  }
  const targets = content.layout.cameraTargets.filter((id) => !present.has(id)).sort();
  if (targets.length > 0) problems.push(`layout: camera targets ${list(targets)} are not anchor ids`);
  return problems;
}
