// Type-only module, no runtime exports. TDD exception: no red/green cycle;
// TypeScript enforces correctness via import type in downstream modules.
export interface WarrantError {
  type: 'validation' | 'transient' | 'permanent' | 'integrity';
  code: string;
  message: string;
}
