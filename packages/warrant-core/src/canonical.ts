function bail(reason: string): never {
  throw new Error(`[canonical] ${reason}`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  // undefined: reject everywhere (caller checks array elements; top-level path below)
  if (value === undefined) bail('undefined is not allowed');

  // null
  if (value === null) return 'null';

  // primitives
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bail(`non-finite number: ${value}`);
    return JSON.stringify(value);
  }

  // reject non-plain primitive types
  if (typeof value === 'bigint') bail('BigInt is not allowed');
  if (typeof value === 'symbol') bail('Symbol is not allowed');
  if (typeof value === 'function') bail('function is not allowed');

  // objects (typeof === 'object', value !== null already handled)
  const obj = value as object;

  // cyclic check
  if (ancestors.has(obj)) bail('circular reference detected');
  ancestors.add(obj);

  let result: string;

  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (const el of obj) {
      if (el === undefined) bail('undefined element in array is not allowed');
      parts.push(serialize(el, ancestors));
    }
    result = '[' + parts.join(',') + ']';
  } else {
    // reject non-plain objects: Date, Map, Set, RegExp, etc.
    if (!isPlainObject(obj)) bail(`non-plain object: ${Object.prototype.toString.call(obj)}`);

    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter(k => rec[k] !== undefined)
      .sort();
    const parts = keys.map(k => `${JSON.stringify(k)}:${serialize(rec[k], ancestors)}`);
    result = '{' + parts.join(',') + '}';
  }

  ancestors.delete(obj);
  return result;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) bail('undefined is not allowed as top-level value');
  return serialize(value, new WeakSet());
}
