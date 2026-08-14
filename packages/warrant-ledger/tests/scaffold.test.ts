import { describe, it, expect } from 'vitest';
describe('scaffold', () => {
  it('imports index', async () => { expect(await import('../src/index.js')).toBeDefined(); });
});
