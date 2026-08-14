import { describe, it, expect } from 'vitest';
import { generateKeyPair, signBytes, signHex, verifyBytes, verifyHex } from '../src/keys.js';

// RFC 8032 §6.1 test vector 1, committed for CI reproducibility (spec §8)
const FIXED_PRIV = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const EXPECTED_PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

describe('generateKeyPair', () => {
  it('fixed private key yields stable public key', () => {
    const kp = generateKeyPair(FIXED_PRIV);
    expect(kp.privateKeyHex).toBe(FIXED_PRIV);
    expect(kp.publicKeyHex).toBe(EXPECTED_PUB);
  });
  it('no-arg generates fresh 64-char hex key pair', () => {
    const kp = generateKeyPair();
    expect(kp.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signHex + verifyHex', () => {
  it('roundtrip: sign then verify succeeds', () => {
    const kp = generateKeyPair(FIXED_PRIV);
    const sig = signHex('warrant-test-vector', kp.privateKeyHex);
    expect(sig.length).toBe(128);
    expect(verifyHex(sig, 'warrant-test-vector', kp.publicKeyHex)).toBe(true);
  });
  it('wrong public key fails verification', () => {
    const kp1 = generateKeyPair(FIXED_PRIV);
    const kp2 = generateKeyPair();
    const sig = signHex('warrant-test-vector', kp1.privateKeyHex);
    expect(verifyHex(sig, 'warrant-test-vector', kp2.publicKeyHex)).toBe(false);
  });
  it('committed vector: sig over "warrant-test-vector" is 128-char lowercase hex', () => {
    const kp = generateKeyPair(FIXED_PRIV);
    expect(signHex('warrant-test-vector', kp.privateKeyHex)).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('tamper detection', () => {
  it('tampered message fails verify', () => {
    const kp = generateKeyPair(FIXED_PRIV);
    const sig = signHex('warrant-test-vector', kp.privateKeyHex);
    expect(verifyHex(sig, 'warrant-test-vector-TAMPERED', kp.publicKeyHex)).toBe(false);
  });
});

describe('malformed hex', () => {
  it('generateKeyPair throws on non-hex chars', () => {
    expect(() => generateKeyPair('zz'.repeat(32))).toThrow(/\[keys\] invalid hex/);
  });
  it('generateKeyPair throws on odd-length hex', () => {
    expect(() => generateKeyPair('abc')).toThrow(/\[keys\]/);
  });
  it('verifyHex returns false (no throw) on malformed sig', () => {
    expect(verifyHex('zz', 'warrant-test-vector', EXPECTED_PUB)).toBe(false);
  });
});

describe('signBytes + verifyBytes', () => {
  const enc = new TextEncoder();

  it('roundtrip: sign then verify succeeds', () => {
    const kp = generateKeyPair(FIXED_PRIV);
    const msg = enc.encode('warrant-test-vector');
    const sig = signBytes(msg, kp.privateKeyHex);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyBytes(sig, msg, kp.publicKeyHex)).toBe(true);
  });

  it('a single flipped byte fails verification', () => {
    const kp = generateKeyPair(FIXED_PRIV);
    const msg = enc.encode('warrant-test-vector');
    const sig = signBytes(msg, kp.privateKeyHex);
    const tampered = Uint8Array.from(msg);
    tampered[0] = tampered[0]! ^ 0x01;
    expect(verifyBytes(sig, tampered, kp.publicKeyHex)).toBe(false);
  });

  it('verifyBytes returns false (no throw) on malformed sig', () => {
    expect(verifyBytes('zz', enc.encode('x'), EXPECTED_PUB)).toBe(false);
  });

  it('signHex is signBytes over the UTF-8 encoding, so text callers are unaffected', () => {
    expect(signHex('warrant-test-vector', FIXED_PRIV))
      .toBe(signBytes(enc.encode('warrant-test-vector'), FIXED_PRIV));
  });

  // This is the whole reason the byte-taking pair exists. EF BF BD is U+FFFD; F0 9F 98 is
  // a truncated 4-byte sequence that the WHATWG decoder also folds to a single U+FFFD.
  // Two different byte strings, one decoded string. Anything that signs text therefore
  // cannot bind bytes, however careful its callers are.
  it('distinct byte strings that decode to the same text: byte API separates them, text API does not', () => {
    const a = Uint8Array.from([0x22, 0xef, 0xbf, 0xbd, 0x22]);
    const b = Uint8Array.from([0x22, 0xf0, 0x9f, 0x98, 0x22]);
    const dec = new TextDecoder();
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
    expect(dec.decode(a)).toBe(dec.decode(b));

    expect(signBytes(a, FIXED_PRIV)).not.toBe(signBytes(b, FIXED_PRIV));
    expect(verifyBytes(signBytes(a, FIXED_PRIV), b, EXPECTED_PUB)).toBe(false);

    // The text path, for contrast: one signature covers both byte strings.
    expect(signHex(dec.decode(a), FIXED_PRIV)).toBe(signHex(dec.decode(b), FIXED_PRIV));
  });
});

describe('golden deterministic signature', () => {
  // Ed25519 is deterministic, so this literal pins the exact signing output for regression detection
  const GOLDEN_SIG = '7e29ab058bd241f8fd2f02400be0a6988424f1aa87cb2d6a52191f77b884227f3ae91478003ac6bef6f2a800c594b8f249da233351a7d9584582703ff7392d05';
  it('signHex(warrant-test-vector, FIXED_PRIV) matches pinned literal', () => {
    expect(signHex('warrant-test-vector', FIXED_PRIV)).toBe(GOLDEN_SIG);
  });
});
