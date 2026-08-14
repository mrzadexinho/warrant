import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Wire sync SHA-512, required for noble/ed25519 v2 sync API in Node
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface KeyPair { publicKeyHex: string; privateKeyHex: string }

/** Validates hex then converts; throws on odd length or non-hex chars. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`[keys] invalid hex: odd length (${hex.length})`);
  if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('[keys] invalid hex: non-hex characters');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

export function generateKeyPair(privateKeyHex?: string): KeyPair {
  let privHex: string;
  if (privateKeyHex !== undefined) {
    privHex = privateKeyHex;
  } else {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes); // Node >=20, engine req met
    privHex = bytesToHex(bytes);
  }
  return { privateKeyHex: privHex, publicKeyHex: bytesToHex(ed.getPublicKey(hexToBytes(privHex))) };
}

/**
 * Signs raw bytes. Use this wherever the thing being signed IS a byte string rather than
 * text: the string-taking helpers below route through TextEncoder, and encode(decode(b))
 * is only the identity when b is well-formed UTF-8. For anything else the decoder folds
 * invalid sequences to U+FFFD, so distinct byte strings collapse to one message and a
 * signature over one of them verifies over the others. DSSE's PAE is exactly that case.
 */
export function signBytes(message: Uint8Array, privateKeyHex: string): string {
  return bytesToHex(ed.sign(message, hexToBytes(privateKeyHex)));
}

export function verifyBytes(sigHex: string, message: Uint8Array, publicKeyHex: string): boolean {
  try {
    return ed.verify(hexToBytes(sigHex), message, hexToBytes(publicKeyHex));
  } catch { return false; }
}

export function signHex(messageUtf8: string, privateKeyHex: string): string {
  return signBytes(new TextEncoder().encode(messageUtf8), privateKeyHex);
}

export function verifyHex(sigHex: string, messageUtf8: string, publicKeyHex: string): boolean {
  return verifyBytes(sigHex, new TextEncoder().encode(messageUtf8), publicKeyHex);
}
