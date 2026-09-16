/**
 * KERNEL TRAIL - placeholder declarations for leg modules that do not exist yet.
 *
 * `src/legs/registry.ts` names all fourteen leg chunks by their eventual module
 * specifier so Rollup can split on them. Until a leg's directory exists, path
 * resolution fails and TypeScript falls back to this wildcard declaration.
 *
 * TODO(astra): delete this file once all fourteen leg modules exist. It is a
 * scaffold, and while it is present a typo in a leg specifier resolves here
 * silently instead of failing the build.
 */
declare module '@legs/*' {
  import type { Leg } from '@game/types';
  import type { LegContent } from '@legs/content';
  const leg: Leg;
  export default leg;
  export const content: LegContent;
}
