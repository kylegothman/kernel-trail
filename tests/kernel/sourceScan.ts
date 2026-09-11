/**
 * Shared source scanner for the architectural guard rails.
 *
 * POLICY, and the reason this file exists:
 *
 * The forbidden-API rules govern CODE, not prose. The frozen src/kernel/types.ts
 * header and the src/kernel/Kernel.ts header both state the prohibition in
 * English, naming Math.random, Date.now and performance.now in order to forbid
 * them. A scanner that reads raw source must flag those two comments, which makes
 * the rule unsatisfiable: the only way to pass would be to edit a frozen file and
 * delete the sentence that documents the contract.
 *
 * So: strip comments before matching.
 *
 * Do NOT also strip string literals when scanning for forbidden identifiers.
 * Computed access is written `Math['random']`, and blanking the literal turns it
 * into `Math[      ]`, which defeats the check that matters most. Keeping
 * literals costs a false positive only if kernel code puts a forbidden name
 * inside a plain string, which no kernel file does and none should.
 *
 * Import scanning also keeps literals, for the same reason in reverse: a module
 * specifier IS a string literal, so blanking it would make every import rule
 * silently unable to fire.
 */

export function stripComments(source: string, alsoStrings: boolean): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(source[k] === '\n' ? '\n' : ' ');
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (alsoStrings && (c === '"' || c === "'" || c === '`')) {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const d = source[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    out.push(c ?? '');
    i += 1;
  }
  return out.join('');
}
