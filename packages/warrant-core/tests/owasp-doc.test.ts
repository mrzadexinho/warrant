import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

// The coverage doc travels with this repo; the guard that stops it being deleted
// silently has to travel with it too, or the guard quietly stops guarding.
describe('OWASP ASI coverage doc', () => {
  it('owasp-asi-coverage.md exists under docs/warrant/', () => {
    // 3 levels up: tests/ → warrant-core/ → packages/ → repo root
    const docPath = new URL('../../../docs/warrant/owasp-asi-coverage.md', import.meta.url).pathname;
    expect(existsSync(docPath)).toBe(true);
  });
});
