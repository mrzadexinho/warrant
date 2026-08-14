import { describe } from 'vitest';
import { MemoryLedger } from '../src/memory.js';
import { runLedgerConformance } from './conformance.js';
describe('MemoryLedger conformance', () => {
  runLedgerConformance('MemoryLedger', async () => new MemoryLedger());
});
