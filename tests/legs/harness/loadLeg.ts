/**
 * WP-20 section 1, scope correction W6 and pre-flight ruling F2: construct
 * any leg by id through the registry's loader map, once, with no retry.
 *
 * A leg whose `src/legs/<id>/index.ts` does not exist is unshipped and every
 * suite skips it with a printed line. A leg whose index exists is a shipped
 * leg, and anything wrong with it (a forbidden module-scope import, a
 * rejected import, a shape that does not match the frozen `Leg`) throws with
 * the id in the message, because a broken shipped leg reported as unshipped
 * is a suite nobody runs. The forbidden-import check is a source scan of the
 * index before the import, through the one shared scanner, because `three`
 * imports fine under Node and would never fail at load on its own.
 *
 * WP-21 section 6: a leg module also exports its `content` companion. The
 * loader returns it, runs `validateContent` on it at load and fails naming
 * the problem, and remembers it beside the leg so `runLeg` can apply it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEG_ORDER, type Leg, type LegId } from '@game/types';
import { validateContent, type LegContent, type LegModule } from '@legs/content';
import { LEG_LOADERS } from '@legs/registry';
import { stripComments } from '../../kernel/sourceScan';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** The layers a leg module may not pull at module scope (section 1, acceptance 6). */
export const FORBIDDEN_SPECIFIERS: readonly string[] = ['three', '@world', '@render', '@ui', '@audio'];
const RELATIVE_FORBIDDEN = /^(?:\.\.?\/)+(?:.*\/)?(?:world|render|ui|audio)(?:\/|$)/;

export interface LoadResult {
  readonly leg: Leg;
  readonly content: LegContent;
  readonly shipped: true;
}

export interface MissingResult {
  readonly leg: null;
  readonly shipped: false;
  readonly reason: string;
}

export interface LoadOptions {
  /** The index file to scan before importing; the registry path by default. */
  readonly indexPath?: string;
  /** The import thunk; `LEG_LOADERS[id]` by default. */
  readonly loader?: () => Promise<LegModule>;
}

/** The companion beside each loaded leg, keyed by the leg object, so `runLeg` applies it without a second argument. */
const COMPANIONS = new WeakMap<Leg, LegContent>();

export function rememberContent(leg: Leg, content: LegContent): void {
  COMPANIONS.set(leg, content);
}

/** The companion a loader or the synthetic leg registered for this leg object, or null for a leg built by hand. */
export function contentOf(leg: Leg): LegContent | null {
  return COMPANIONS.get(leg) ?? null;
}

export function legIndexPath(id: LegId): string {
  return resolve(REPO_ROOT, 'src', 'legs', id, 'index.ts');
}

function isForbidden(specifier: string): boolean {
  return FORBIDDEN_SPECIFIERS.some((f) => specifier === f || specifier.startsWith(`${f}/`)) || RELATIVE_FORBIDDEN.test(specifier);
}

/** Module-scope value imports of a forbidden layer, from comment-stripped source. */
export function scanForbiddenImports(source: string): readonly string[] {
  const code = stripComments(source, false);
  const hits: { readonly index: number; readonly specifier: string }[] = [];
  const patterns = [
    /^[ \t]*(?:import|export)\b(?![ \t]+type\b)[^;]*?\bfrom[ \t]*['"]([^'"]+)['"]/gm,
    /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
      const specifier = match[1];
      if (specifier !== undefined && isForbidden(specifier) && !hits.some((hit) => hit.specifier === specifier)) hits.push({ index: match.index, specifier });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.specifier);
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every member of the frozen `Leg` interface, present and of the right kind, with the id and index checked. */
export function assertLegShape(candidate: unknown, id: LegId): asserts candidate is Leg {
  const fail: (field: string, detail: string) => never = (field, detail) => {
    throw new Error(`Leg ${id}: ${field} ${detail}`);
  };
  if (typeof candidate !== 'object' || candidate === null) fail('default export', `is ${candidate === null ? 'null' : typeof candidate}, expected the Leg object`);
  const leg = candidate as Record<string, unknown>;
  if (leg.id !== id) fail('id', `is ${JSON.stringify(leg.id)}, expected ${JSON.stringify(id)}`);
  const index = LEG_ORDER.indexOf(id);
  if (leg.index !== index) fail('index', `is ${String(leg.index)}, expected ${index} (its position in LEG_ORDER)`);
  for (const field of ['title', 'subtitle'] as const) if (typeof leg[field] !== 'string') fail(field, 'is not a string');
  for (const field of ['chapters', 'objectives', 'interactions', 'terminalCommands', 'eventTable'] as const) {
    if (!Array.isArray(leg[field])) fail(field, 'is not an array');
  }
  for (const field of ['kernelConfig', 'populate', 'createStage', 'evaluate'] as const) {
    if (typeof leg[field] !== 'function') fail(field, 'is not a function');
  }
}

/** Every member of `LegContent`, present and of the right kind; `validateContent` checks the meaning. */
export function assertContentShape(candidate: unknown, id: LegId): asserts candidate is LegContent {
  const fail: (field: string, detail: string) => never = (field, detail) => {
    throw new Error(`Leg ${id}: content ${field} ${detail}`);
  };
  if (typeof candidate !== 'object' || candidate === null) fail('export', `is ${candidate === null ? 'null' : typeof candidate}, expected the LegContent companion (WP-21 section 1)`);
  const content = candidate as Record<string, unknown>;
  if (content.legId !== id) fail('legId', `is ${JSON.stringify(content.legId)}, expected ${JSON.stringify(id)}`);
  for (const field of ['crossings', 'epitaphs', 'codex'] as const) if (!Array.isArray(content[field])) fail(field, 'is not an array');
  for (const field of ['interactions', 'terminalHandlers', 'layout'] as const) {
    if (typeof content[field] !== 'object' || content[field] === null) fail(field, 'is not an object');
  }
  const layout = content.layout as Record<string, unknown>;
  for (const field of ['anchors', 'cameraTargets', 'extras'] as const) if (!Array.isArray(layout[field])) fail(`layout.${field}`, 'is not an array');
}

/**
 * Returns `shipped: false` only when the index file is absent. A present
 * index that imports a forbidden layer, rejects on import, exports the wrong
 * shape, or carries a companion `validateContent` rejects throws with the id
 * in the message.
 */
export async function tryLoadLegForTest(id: LegId, options: LoadOptions = {}): Promise<LoadResult | MissingResult> {
  const indexPath = options.indexPath ?? legIndexPath(id);
  const shown = relative(REPO_ROOT, indexPath);
  if (!existsSync(indexPath)) return { leg: null, shipped: false, reason: `${shown} does not exist` };
  const forbidden = scanForbiddenImports(readFileSync(indexPath, 'utf8'));
  if (forbidden.length > 0) {
    throw new Error(`Leg ${id}: ${shown} imports ${forbidden.join(', ')} at module scope; a leg module may not pull three, @world, @render, @ui or @audio`);
  }
  let module: LegModule;
  try {
    module = await (options.loader ?? LEG_LOADERS[id])();
  } catch (error) {
    throw new Error(`Leg ${id}: ${shown} exists but its import was rejected: ${describe(error)}`);
  }
  const leg: unknown = module.default;
  assertLegShape(leg, id);
  const content: unknown = module.content;
  assertContentShape(content, id);
  const problems = validateContent(leg, content);
  if (problems.length > 0) throw new Error(`Leg ${id}: ${shown} content is invalid:\n  ${problems.join('\n  ')}`);
  rememberContent(leg, content);
  return { leg, content, shipped: true };
}

export async function loadLegForTest(id: LegId, options: LoadOptions = {}): Promise<Leg> {
  const result = await tryLoadLegForTest(id, options);
  if (!result.shipped) throw new Error(`Leg ${id} has not shipped: ${result.reason}`);
  return result.leg;
}

export interface ShippedSet {
  readonly legs: readonly Leg[];
  readonly skipped: readonly { readonly id: LegId; readonly reason: string }[];
}

/** Every shipped leg in `LEG_ORDER`, with the unshipped ids and their reasons. */
export async function loadShippedSet(): Promise<ShippedSet> {
  const legs: Leg[] = [];
  const skipped: { id: LegId; reason: string }[] = [];
  for (const id of LEG_ORDER) {
    const result = await tryLoadLegForTest(id);
    if (result.shipped) legs.push(result.leg);
    else skipped.push({ id, reason: result.reason });
  }
  return { legs, skipped };
}

export async function loadAllShippedLegs(): Promise<readonly Leg[]> {
  return (await loadShippedSet()).legs;
}

/** The shipped legs in journey order up to the first unshipped one. */
export async function loadShippedPrefix(): Promise<readonly Leg[]> {
  const prefix: Leg[] = [];
  for (const id of LEG_ORDER) {
    const result = await tryLoadLegForTest(id);
    if (!result.shipped) break;
    prefix.push(result.leg);
  }
  return prefix;
}

/** The one line a suite prints per unshipped leg (section 1). Never an `it.skip`. */
export function skipLine(suite: string, id: LegId, reason: string): string {
  return `${suite}: skipped ${id} (${reason})`;
}
