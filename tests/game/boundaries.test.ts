/** WP-19 V21: inspect code as a TypeScript AST, never comments or quoted prose. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/experimental';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GAME = join(ROOT, 'src', 'game');
const FORBIDDEN_LAYERS = new Set(['world', 'render', 'ui', 'audio', 'terminal', 'app']);
const GLOBALS = new Set(['localStorage', 'document', 'window']);
const NONDETERMINISTIC_MEMBERS = new Set(['Math.random', 'Date.now', 'performance.now']);
type Fields = Record<string, unknown>;

function fields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(entry => {
    if (dir === GAME && entry.name === 'workers') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function memberPath(value: unknown): string | null {
  if (!fields(value)) return null;
  if (value.type === 'Identifier') return typeof value.name === 'string' ? value.name : null;
  if (value.type !== 'MemberExpression' || !fields(value.property)) return null;
  const object = memberPath(value.object);
  const property = value.computed === true ? value.property.value : value.property.name;
  return object !== null && typeof property === 'string' ? `${object}.${property}` : null;
}

function forbiddenModule(file: string, specifier: string): boolean {
  if (specifier.startsWith('@')) return FORBIDDEN_LAYERS.has(specifier.slice(1).split('/')[0] ?? '');
  if (!specifier.startsWith('.')) return false;
  const target = relative(join(ROOT, 'src'), resolve(dirname(file), specifier)).split(sep)[0] ?? '';
  return FORBIDDEN_LAYERS.has(target);
}

/** A whole declaration marked type-only, or a named list containing only types, has no value edge. */
function valueImport(node: Fields): boolean {
  if (node.importKind === 'type' || node.exportKind === 'type') return false;
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return true;
  return node.specifiers.some(specifier => !fields(specifier) ||
    (specifier.importKind !== 'type' && specifier.exportKind !== 'type'));
}

function scan(source: string, file: string): string[] {
  const parsed = parseSync(file, source);
  expect(parsed.errors, `parse ${relative(ROOT, file)}`).toEqual([]);
  const offences: string[] = [];
  const add = (node: Fields, message: string): void => {
    const start = typeof node.start === 'number' ? node.start : 0;
    const line = source.slice(0, start).split('\n').length;
    offences.push(`${relative(ROOT, file)}:${line}: ${message}`);
  };
  const visit = (value: unknown, parent: Fields | null = null, key = ''): void => {
    if (Array.isArray(value)) { for (const child of value) visit(child, parent, key); return; }
    if (!fields(value)) return;
    const node = value;
    const type = node.type;
    if (typeof type !== 'string') return;
    // Erased type syntax is not executable; assertions still contain an expression.
    if (type.startsWith('TS') && !['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSInstantiationExpression', 'TSImportEqualsDeclaration'].includes(type)) return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(type) && valueImport(node) && fields(node.source) && typeof node.source.value === 'string' && forbiddenModule(file, node.source.value)) {
      add(node, `value import ${node.source.value}`);
    }
    if (node.type === 'ImportExpression' && fields(node.source) && typeof node.source.value === 'string' && forbiddenModule(file, node.source.value)) add(node, `dynamic import ${node.source.value}`);
    if (node.type === 'TSImportEqualsDeclaration' && node.importKind !== 'type' && fields(node.moduleReference) && fields(node.moduleReference.expression) && typeof node.moduleReference.expression.value === 'string' && forbiddenModule(file, node.moduleReference.expression.value)) add(node, `value import ${node.moduleReference.expression.value}`);
    if (node.type === 'CallExpression' && memberPath(node.callee) === 'require' && Array.isArray(node.arguments)) {
      const target: unknown = node.arguments[0];
      if (fields(target) && typeof target.value === 'string' && forbiddenModule(file, target.value)) add(node, `require ${target.value}`);
    }
    const path = memberPath(node);
    const globalPath = path?.startsWith('globalThis.') ? path.slice('globalThis.'.length) : path;
    if (node.type === 'MemberExpression' && globalPath !== null && globalPath !== undefined &&
      (NONDETERMINISTIC_MEMBERS.has(globalPath) || GLOBALS.has(globalPath))) add(node, `forbidden access ${globalPath}`);
    if (node.type === 'NewExpression' && ['Date', 'globalThis.Date'].includes(memberPath(node.callee) ?? '')) add(node, 'new Date');
    if (node.type === 'Identifier' && typeof node.name === 'string' && GLOBALS.has(node.name)) {
      const propertyName = parent !== null && parent.computed !== true &&
        ((parent.type === 'MemberExpression' && key === 'property') ||
         ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key'));
      if (!propertyName) add(node, `forbidden global ${node.name}`);
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey !== 'parent') visit(child, node, childKey);
    }
  };
  visit(parsed.program);
  return offences;
}

describe('src/game boundaries', () => {
  it('scans the game layer while leaving the existing worker boundary suite authoritative for workers', () => {
    const files = sources(GAME);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some(file => file.endsWith(`${sep}LegSandbox.ts`))).toBe(true);
    expect(files.some(file => relative(GAME, file).startsWith(`workers${sep}`))).toBe(false);
    expect(files.flatMap(file => scan(readFileSync(file, 'utf8'), file))).toEqual([]);
  });

  it('detects dotted and computed forbidden accesses and every requested global', () => {
    const snippets = [
      'Math.random()', 'Math["random"]()', 'Date.now()', 'Date["now"]()',
      'performance.now()', 'performance["now"]()', 'new Date()', 'new globalThis.Date()',
      'localStorage.getItem("x")', 'document.createElement("div")', 'window.innerWidth',
      'globalThis["document"]', 'globalThis.Math["random"]()',
    ];
    for (const source of snippets) expect(scan(source, join(GAME, 'fixture.ts')), source).not.toEqual([]);
  });

  it('ignores comments, string copy, harmless object property names and erased types', () => {
    const source = `
      // Math.random(), Date.now(), performance.now(), new Date(), document and window are forbidden.
      const text = 'document window localStorage Math.random';
      interface Example { document: string; window: number; localStorage: boolean }
      const state = { document: text, window: 1, localStorage: false };
      state.window;
    `;
    expect(scan(source, join(GAME, 'fixture.ts'))).toEqual([]);
  });

  it('allows whole and inline type-only imports and re-exports', () => {
    const source = `
      import type { A } from '@world/a';
      import { type B } from '@render/b';
      export type { C } from '@ui/c';
      export { type D } from '@audio/d';
      import type * as Terminal from '@terminal/e';
      export type * from '@app/f';
    `;
    expect(scan(source, join(GAME, 'fixture.ts'))).toEqual([]);
  });

  it('rejects value imports including mixed lists, re-exports, dynamic imports and relative escapes', () => {
    const sources = [
      "import * as World from '@world/a';", "import Render from '@render/a';",
      "import { type A, value } from '@ui/a';", "export { value } from '@audio/a';",
      "export * from '@terminal/a';", "import '@app/a';", "import('../world/a');",
      "const world = require('../world/a');", "import value = require('@world/a');",
      "import { value } from '../render/a';",
    ];
    for (const source of sources) expect(scan(source, join(GAME, 'fixture.ts')), source).not.toEqual([]);
    expect(scan("import { value } from '../../ui/a';", join(GAME, 'nested', 'fixture.ts'))).not.toEqual([]);
  });
});
