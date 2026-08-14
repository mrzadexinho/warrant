import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function paramsHash(params: unknown): string {
  return sha256Hex(canonicalJson(params));
}
