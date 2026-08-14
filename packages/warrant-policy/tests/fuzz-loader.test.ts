// portfolio/packages/warrant-policy/tests/fuzz-loader.test.ts
//
// Property-based fuzzing of loadPolicy / PolicyDocSchema (src/load.ts, src/schema.ts).
// Companion to load.test.ts's example-based tests (the misspelt-audience typo, the
// orphaned-cap check): here the mutation is generated, not hand-picked.
//
// Two invariants hold across every property below:
//   1. loadPolicy NEVER throws: every failure mode is a typed Result error.
//   2. No mutation of a validly-authored document can flip a stakes rule's own `path` from
//      'human' to 'auto' while the document still loads cleanly, UNLESS the mutation directly
//      and explicitly targets that rule's `path` field itself. Every other field around it
//      (id, match.actionKind, match.audience) is free-form (z.string(), no format constraint),
//      so mutating THOSE and still loading clean is expected; what must never happen is one of
//      those unrelated mutations silently carrying `path` along with it. strictObject is what
//      makes this true: an unknown/misspelt/duplicated key refuses the whole document rather
//      than being dropped and read as "unconstrained" (see the load-bearing comment block atop
//      schema.ts: this is the exact class of bug PolicyDocSchema was hardened against).
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parse, stringify } from 'yaml';
import { loadPolicy } from '../src/load.js';

const SEED = 42;
const NUM_RUNS = 200;

const VALID_YAML = `
version: "0.1.0"
defaults:
  path: deny
stakes:
  - id: draft-for-review
    match:
      actionKind: draft_email
    path: auto
  - id: cold-email-hiring-manager
    match:
      actionKind: send_email
      audience: cold
    path: human
protectedAudiences:
  - "*@*.gov"
  - "press@*"
caps:
  perPrincipalDaily:
    send_email: 10
`;

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type Path = (string | number)[];

function getAt(obj: unknown, path: Path): unknown {
  let cur: unknown = obj;
  for (const k of path) cur = (cur as Record<string | number, unknown>)?.[k];
  return cur;
}
function setAt(obj: unknown, path: Path, value: unknown): void {
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<string | number, unknown>;
  cur[path[path.length - 1]!] = value;
}
function deleteAt(obj: unknown, path: Path): void {
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (Array.isArray(cur)) cur.splice(last as number, 1);
  else delete cur[last];
}

// ── Property 1: loadPolicy never throws on arbitrary text ─────────────────────────────────

describe('fuzz: loadPolicy: arbitrary strings never throw', () => {
  it('any string handed to loadPolicy returns a typed Result, never throws', () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.string(),
        fc.constantFrom(
          '', '{', '}', '[unclosed', '---\n', '&anchor *anchor',
          '!!binary SGVsbG8=', 'a: &x\n  b: *x\n', 'key: !!python/object:foo {}',
          'a:\n  - 1\n  -2\n', String.fromCharCode(0), '\t\ttabs:\n\t\t\tindented',
          '9'.repeat(400), 'a: '.repeat(2000), 'version: "0.1.0"\nversion: "0.2.0"\n',
        ),
      ),
      (text) => {
        let threw = false;
        let result: ReturnType<typeof loadPolicy> | undefined;
        try {
          result = loadPolicy(text);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        if (result?.error) {
          expect(result.data).toBeNull();
        } else {
          expect(result?.data).not.toBeNull();
        }
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});

// ── Properties 2 & 3: structural mutation of a validly-authored document ──────────────────
//
// Every path here, with what the schema actually requires at that path (typeCheck) and
// whether DELETING the key is expected to still load cleanly (deletableCleanly: true only
// for the one z.optional() field and for a caps entry, since z.record() accepts an empty map).

interface KeySpec {
  path: Path;
  typeCheck: (v: unknown) => boolean;
  deletableCleanly: boolean;
}

const KEY_SPECS: KeySpec[] = [
  { path: ['version'], typeCheck: (v) => typeof v === 'string', deletableCleanly: false },
  { path: ['defaults', 'path'], typeCheck: (v) => v === 'deny', deletableCleanly: false },
  { path: ['stakes', 0, 'id'], typeCheck: (v) => typeof v === 'string', deletableCleanly: false },
  { path: ['stakes', 0, 'match', 'actionKind'], typeCheck: (v) => typeof v === 'string', deletableCleanly: false },
  { path: ['stakes', 0, 'path'], typeCheck: (v) => v === 'auto' || v === 'human', deletableCleanly: false },
  { path: ['stakes', 1, 'id'], typeCheck: (v) => typeof v === 'string', deletableCleanly: false },
  {
    // Not a plain string check: load.ts's orphaned-caps rule couples this field to
    // caps.perPrincipalDaily, which names 'send_email' and nothing else. Any other
    // string still type-checks against match.actionKind's own z.string(), but the
    // document as a whole is refused unless the value stays 'send_email': otherwise
    // the cap on 'send_email' would name an actionKind no stakes rule mentions.
    path: ['stakes', 1, 'match', 'actionKind'],
    typeCheck: (v) => v === 'send_email',
    deletableCleanly: false,
  },
  { path: ['stakes', 1, 'match', 'audience'], typeCheck: (v) => typeof v === 'string', deletableCleanly: true },
  { path: ['stakes', 1, 'path'], typeCheck: (v) => v === 'auto' || v === 'human', deletableCleanly: false },
  {
    // z.number().int() rejects beyond Number.MAX_SAFE_INTEGER (Zod v4's int() implies the
    // safe-integer bound), which plain Number.isInteger() does not model on its own.
    path: ['caps', 'perPrincipalDaily', 'send_email'],
    typeCheck: (v) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= Number.MAX_SAFE_INTEGER,
    deletableCleanly: true,
  },
];

describe('fuzz: loadPolicy: deleting a single key at every level', () => {
  it('deleting a required key always refuses; the one optional key and a caps entry never do: and neither throws', () => {
    fc.assert(fc.property(fc.constantFrom(...KEY_SPECS), (spec) => {
      const base = deepClone(parse(VALID_YAML));
      deleteAt(base, spec.path);
      const yamlText = stringify(base);
      let threw = false;
      let result: ReturnType<typeof loadPolicy> | undefined;
      try {
        result = loadPolicy(yamlText);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      if (spec.deletableCleanly) {
        expect(result?.error).toBeNull();
      } else {
        expect(result?.data).toBeNull();
        expect(result?.error).not.toBeNull();
      }
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: loadPolicy: replacing a single key with an arbitrary JSON value at every level', () => {
  it("loads clean iff the value still satisfies that field's type, never throws, and never silently flips stakes[1]'s own path", () => {
    fc.assert(fc.property(fc.constantFrom(...KEY_SPECS), fc.jsonValue(), (spec, value) => {
      const base = deepClone(parse(VALID_YAML));
      const original = getAt(base, spec.path);
      setAt(base, spec.path, value);
      const yamlText = stringify(base);
      let threw = false;
      let result: ReturnType<typeof loadPolicy> | undefined;
      try {
        result = loadPolicy(yamlText);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      if (spec.typeCheck(value)) {
        expect(result?.error).toBeNull();
      } else {
        expect(result?.data).toBeNull();
        expect(result?.error).not.toBeNull();
      }
      // THE master property: stakes[1] is the human-path rule. Any mutation that (a) loaded
      // cleanly and (b) did NOT target stakes[1].path itself must leave that rule's path
      // exactly as authored: 'human'. If this ever fails, some field is silently carrying
      // the verdict path along with it, which is precisely the widening class schema.ts's
      // strictObject migration exists to close off.
      const touchedPathItself = spec.path[0] === 'stakes' && spec.path[1] === 1 && spec.path[2] === 'path';
      if (!result?.error && !touchedPathItself && spec.path[0] === 'stakes' && spec.path[1] === 1) {
        const doc = (result as { data: { doc: { stakes: Array<{ path: string }> } } }).data.doc;
        expect(doc.stakes[1]!.path).toBe('human');
      }
      void original; // kept for readability at call sites that may extend this spec later
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

// ── Property 4: duplicating a single key anywhere is a YAML-level violation ────────────────
//
// The `yaml` package throws YAMLParseError on a duplicate mapping key regardless of nesting
// level (verified directly: `parse('a: 1\\na: 2\\n')` throws 'Map keys must be unique').
// loadPolicy's own try/catch around parseYaml turns that into a typed err rather than letting
// it escape: this property pins that behavior specifically for the human-path rule's own
// `path: human` line, which is exactly the field a silent duplicate-key override would need to
// touch to produce the flip the briefing worries about.

const LINES = VALID_YAML.split('\n');
function findFullLine(trimmedNeedle: string): string {
  const found = LINES.find((l) => l.trim() === trimmedNeedle);
  if (found === undefined) throw new Error(`fixture line not found: ${trimmedNeedle}`);
  return found;
}

const DUPLICATE_TARGETS = [
  'version: "0.1.0"',
  'path: deny',
  '- id: draft-for-review',
  'actionKind: draft_email',
  'path: auto',
  '- id: cold-email-hiring-manager',
  'actionKind: send_email',
  'audience: cold',
  'path: human', // the rule this whole file exists to protect
  'send_email: 10',
].map(findFullLine);

function keyOf(line: string): string {
  const m = line.match(/^\s*(?:-\s+)?([A-Za-z0-9_-]+):/);
  if (!m) throw new Error(`cannot find a mapping key in line: ${line}`);
  return m[1]!;
}
/** Indent at which a SIBLING key in the same mapping belongs: absorbs a leading "- " marker. */
function mappingIndent(line: string): string {
  const m = line.match(/^(\s*)(-\s+)?/);
  const ws = m?.[1] ?? '';
  const dash = m?.[2] ?? '';
  return ws + ' '.repeat(dash.length);
}
function toYamlScalar(v: string | number | boolean): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}
function insertDuplicateAfter(text: string, targetLine: string, valueScalar: string): string {
  const idx = text.indexOf(targetLine);
  const key = keyOf(targetLine);
  const dupLine = `${mappingIndent(targetLine)}${key}: ${valueScalar}`;
  const insertPos = idx + targetLine.length;
  return text.slice(0, insertPos) + '\n' + dupLine + text.slice(insertPos);
}

describe('fuzz: loadPolicy: duplicating a single key is always refused, never a silent override', () => {
  it('every duplicated key at every level: including path: human: is refused, and loadPolicy never throws', () => {
    fc.assert(fc.property(
      fc.constantFrom(...DUPLICATE_TARGETS),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constantFrom('auto', 'human', 'deny')),
      (targetLine, value) => {
        const mutated = insertDuplicateAfter(VALID_YAML, targetLine, toYamlScalar(value));
        let threw = false;
        let result: ReturnType<typeof loadPolicy> | undefined;
        try {
          result = loadPolicy(mutated);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        // A duplicate mapping key is invalid YAML, full stop: this must never load, and
        // must never silently take "whichever value wins" as a clean document.
        expect(result?.data).toBeNull();
        expect(result?.error).not.toBeNull();
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});
