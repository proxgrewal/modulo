import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { AppPackage } from '@modulo/sandbox';

/**
 * Package signing. A signed package is
 *   { manifest, code, signature, publisherKey }
 * where signature = base64(ed25519_sign(sha256(canonicalJson({ manifest, code })))).
 * publisherKey is base64 SPKI DER (raw 32-byte ed25519 keys and PEM are also accepted).
 */
export interface SignedPackage extends AppPackage {
  signature: string;
  publisherKey: string;
}

export type MarketplaceTrust = 'verified' | 'community';

export type VerifyResult =
  | { ok: true; trust: MarketplaceTrust; publisherKey: string; digest: string }
  | { ok: false; error: string };

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Deterministic JSON: object keys sorted recursively, no whitespace. `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.keys(value as object)
    .sort()
    .filter((k) => (value as any)[k] !== undefined && typeof (value as any)[k] !== 'function')
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`);
  return `{${entries.join(',')}}`;
}

/** sha256 over the canonical JSON of { manifest, code }. */
export function packageDigest(pkg: AppPackage): Buffer {
  return createHash('sha256').update(canonicalJson({ manifest: pkg.manifest, code: pkg.code })).digest();
}

export function generatePublisherKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function toPrivateKey(key: string | KeyObject): KeyObject {
  if (typeof key !== 'string') return key;
  if (key.includes('-----BEGIN')) return createPrivateKey(key);
  return createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' });
}

/** Parse a publisher key (base64 SPKI DER, base64 raw 32 bytes, or PEM). Throws on garbage / non-ed25519. */
export function parsePublicKey(key: string): KeyObject {
  if (typeof key !== 'string' || !key.trim()) throw new Error('publisher key is empty');
  let k: KeyObject;
  if (key.includes('-----BEGIN')) k = createPublicKey(key);
  else {
    const raw = Buffer.from(key.trim(), 'base64');
    k = createPublicKey({ key: raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw, format: 'der', type: 'spki' });
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('publisher key must be an ed25519 key');
  return k;
}

/** Canonical form for comparing keys: base64 SPKI DER. */
export function canonicalPublicKey(key: string): string {
  return parsePublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
}

/** Short human-readable fingerprint (first 16 hex chars of sha256 of the SPKI DER). */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(Buffer.from(canonicalPublicKey(key), 'base64')).digest('hex').slice(0, 16);
}

export function signPackage(pkg: AppPackage, privateKey: string | KeyObject): SignedPackage {
  const priv = toPrivateKey(privateKey);
  const signature = sign(null, packageDigest(pkg), priv).toString('base64');
  const publisherKey = createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
  return { manifest: pkg.manifest, code: pkg.code, signature, publisherKey };
}

/**
 * Verify a signed package. `trusted` is a list of publisher keys (any accepted encoding).
 * verified = valid signature by a trusted key; community = valid signature by an unknown key.
 */
export function verifyPackage(pkg: SignedPackage, trusted: Iterable<string> = []): VerifyResult {
  if (!pkg || typeof pkg !== 'object' || !pkg.manifest || typeof pkg.code !== 'string') return { ok: false, error: 'malformed package' };
  if (typeof pkg.signature !== 'string' || typeof pkg.publisherKey !== 'string') return { ok: false, error: 'package is not signed' };
  let pub: KeyObject;
  try {
    pub = parsePublicKey(pkg.publisherKey);
  } catch (e: any) {
    return { ok: false, error: `invalid publisher key: ${e.message}` };
  }
  const digest = packageDigest(pkg);
  let valid = false;
  try {
    valid = verify(null, digest, pub, Buffer.from(pkg.signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'signature does not match package contents' };
  const canon = pub.export({ format: 'der', type: 'spki' }).toString('base64');
  const trustedSet = new Set<string>();
  for (const t of trusted) {
    try {
      trustedSet.add(canonicalPublicKey(t));
    } catch {
      /* ignore malformed trusted entries */
    }
  }
  return { ok: true, trust: trustedSet.has(canon) ? 'verified' : 'community', publisherKey: canon, digest: digest.toString('hex') };
}
