import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // C14: several tests spawn a tsx subprocess or run 50 rounds of Ed25519 plus
    // filesystem writes. They cost 0.5-1.1s idle but exceed vitest's 5000ms default
    // under concurrent load, failing with a timeout rather than an assertion.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
