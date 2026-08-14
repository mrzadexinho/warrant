// Checks that every import in a package README's code blocks names symbols the imported
// package actually exports. This is the drift class that bites documentation: an API gets
// renamed, the suite stays green, and the README teaches the old name. (buildSmtpSender,
// formerly createSmtpSender, is the concrete case this repo already lived through.)
//
// Deliberately NOT a full typecheck of the snippets: examples reference free variables
// (warrant, ledger, ...) by design, and a checker that needs them stubbed rots faster than
// the docs it guards. Import lines are the load-bearing, mechanically checkable part.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkgsDir = join(root, 'packages');
let failures = 0;
let checked = 0;

// name -> Set of exported identifiers, parsed from the package's src/index.ts
function exportsOf(pkgName) {
  const dir = readdirSync(pkgsDir).find((d) => {
    const pj = join(pkgsDir, d, 'package.json');
    return existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).name === pkgName;
  });
  if (!dir) return null;
  const idx = join(pkgsDir, dir, 'src', 'index.ts');
  if (!existsSync(idx)) return null;
  const src = readFileSync(idx, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, '').trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:const|function|class|interface|type)\s+([A-Za-z0-9_]+)/g)) {
    names.add(m[1]);
  }
  return names;
}

for (const dir of readdirSync(pkgsDir)) {
  const readme = join(pkgsDir, dir, 'README.md');
  if (!existsSync(readme)) continue;
  const text = readFileSync(readme, 'utf8');
  const blocks = [...text.matchAll(/```(?:ts|typescript|js)\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of blocks) {
    for (const im of block.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(@idriszade\/[a-z-]+)'/g)) {
      const wanted = im[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean);
      const have = exportsOf(im[2]);
      if (!have) continue; // package outside this repo (e.g. @idriszade/core)
      for (const name of wanted) {
        checked++;
        if (!have.has(name)) {
          failures++;
          console.error(`${dir}/README.md: imports '${name}' from ${im[2]}, which does not export it`);
        }
      }
    }
  }
}

console.log(`readme-examples: ${checked} imported symbols checked, ${failures} missing`);
process.exit(failures === 0 ? 0 : 1);
