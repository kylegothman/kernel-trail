import type { Plugin } from 'vite';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value: number): string {
  let bits = value < 0 ? -value * 2 + 1 : value * 2;
  let result = '';
  do {
    let digit = bits % 32;
    bits = Math.floor(bits / 32);
    if (bits) digit += 32;
    result += BASE64[digit];
  } while (bits);
  return result;
}

/** Line-level sourcemap with exact anchors on both sides of each insertion. */
export function instrumentAllocations(code: string, id: string) {
  if (!id.includes('/three/')) return null;
  const edits: { offset: number; text: string }[] = [];
  const expression = /(class (Matrix4|Vector3|Color|Quaternion)\b[\s\S]*?\bconstructor\s*\([^)]*\)\s*\{)/g;
  const transformed = code.replace(expression, (match: string, _head: string, name: string, offset: number) => {
    const text = `globalThis.__ktAlloc?.('${name}');`;
    edits.push({ offset: offset + match.length, text });
    return match + text;
  });
  if (!edits.length) return null;
  let offset = 0, editIndex = 0, previousLine = 0, previousColumn = 0;
  const mappings = code.split('\n').map((line, lineIndex) => {
    const segments = [[0, 0, lineIndex - previousLine, -previousColumn].map(vlq).join('')];
    previousLine = lineIndex; previousColumn = 0;
    let shift = 0, generatedColumn = 0;
    for (let edit = edits[editIndex]; edit && edit.offset <= offset + line.length; edit = edits[++editIndex]) {
      const column = edit.offset - offset;
      segments.push([column + shift - generatedColumn, 0, 0, column - previousColumn].map(vlq).join(''));
      segments.push([edit.text.length, 0, 0, 0].map(vlq).join(''));
      shift += edit.text.length; generatedColumn = column + shift; previousColumn = column;
    }
    offset += line.length + 1;
    return segments.join(',');
  }).join(';');
  return { code: transformed, map: { version: 3 as const, names: [], sources: [id], sourcesContent: [code], mappings } };
}

export const allocationProbe: Plugin = {
  name: 'kt-allocation-probe', enforce: 'pre',
  transform(code, id) { return instrumentAllocations(code, id); },
};
