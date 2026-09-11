/** Compare UTF-16 code units without consulting the host's locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Kernel-state encoding for replay comparisons. Undefined object properties are
 * omitted; undefined elsewhere (including sparse array slots), BigInt and cycles
 * are rejected instead of silently losing state. Shared noncyclic objects work.
 * Map keys and Set values sort by their canonical encodings. Equal Map keys sort
 * by the encoded value, so distinct object keys cannot preserve insertion order.
 */
export function canonical(value: unknown): string {
  const ancestors = new WeakSet<object>();

  const encode = (entry: unknown, path: string): string => {
    if (entry === null) return 'null';
    switch (typeof entry) {
      case 'string':
        return JSON.stringify(entry);
      case 'boolean':
        return entry ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(entry)) throw new TypeError(`canonical: non-finite number at ${path}`);
        return Object.is(entry, -0) ? '0' : Number.prototype.toString.call(entry);
      case 'undefined':
      case 'bigint':
      case 'function':
      case 'symbol':
        throw new TypeError(`canonical: unsupported ${typeof entry} at ${path}`);
      case 'object':
        break;
    }

    if (ancestors.has(entry)) throw new TypeError(`canonical: cycle at ${path}`);
    if (Object.getOwnPropertySymbols(entry).length > 0) {
      throw new TypeError(`canonical: symbol key at ${path}`);
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        const items: readonly unknown[] = entry;
        return `[${Array.from({ length: items.length }, (_, i) => encode(items[i], `${path}.${i}`)).join(',')}]`;
      }
      if (entry instanceof Map) {
        const map: ReadonlyMap<unknown, unknown> = entry;
        const pairs = Array.from(map, ([key, item], i): readonly [string, string] => [
          encode(key, `${path}.${i}.key`),
          encode(item, `${path}.${i}.value`),
        ]);
        pairs.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
        return `[${pairs.map(([key, item]) => `[${key},${item}]`).join(',')}]`;
      }
      if (entry instanceof Set) {
        const set: ReadonlySet<unknown> = entry;
        const items = Array.from(set, (item, i) => encode(item, `${path}.${i}`));
        items.sort(compare);
        return `[${items.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(entry);
      if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError(`canonical: unsupported class instance at ${path}`);
      }
      const record = entry as Readonly<Record<string, unknown>>;
      const properties: string[] = [];
      for (const key of Object.keys(record).sort(compare)) {
        const item = record[key];
        if (item !== undefined) properties.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`)}`);
      }
      return `{${properties.join(',')}}`;
    } finally {
      ancestors.delete(entry);
    }
  };

  return encode(value, '$');
}

/** FNV-1a over UTF-16 code units, matching the kernel's label-hash convention. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Keep nested references intact while omitting selected own, enumerable keys. */
export function strip<T extends string>(...keys: T[]): (o: object) => object {
  const omitted = new Set<string>(keys);
  return (o) => {
    const result = { ...o } as Record<string, unknown>;
    for (const key of omitted) delete result[key];
    return result;
  };
}
