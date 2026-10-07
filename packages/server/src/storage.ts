import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Binary storage port: local disk for dev, S3-compatible (AWS, MinIO, R2) for production. */
export interface Storage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Uint8Array; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,300}$/;
function checkKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error(`Invalid storage key ${key}`);
}

export class LocalStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    checkKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error('Path traversal');
    return p;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    await writeFile(p + '.type', contentType);
  }
  async get(key: string) {
    try {
      const p = this.path(key);
      const data = await readFile(p);
      const contentType = await readFile(p + '.type', 'utf8').catch(() => undefined);
      return { data: new Uint8Array(data), contentType };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(p + '.type', { force: true });
  }
}

export interface S3Config {
  endpoint: string; // e.g. https://s3.eu-west-1.amazonaws.com or http://localhost:9000 (MinIO)
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Minimal S3 client (path-style, AWS Signature V4, UNSIGNED-PAYLOAD-free: payload is hashed). */
export class S3Storage implements Storage {
  constructor(private cfg: S3Config) {}

  private sign(method: string, key: string, body: Uint8Array, extraHeaders: Record<string, string> = {}) {
    const url = new URL(`${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders };
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === n)!]).trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonical = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, date), this.cfg.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;
    return { url: url.toString(), headers };
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    checkKey(key);
    const { url, headers } = this.sign('PUT', key, data, { 'content-type': contentType });
    const res = await fetch(url, { method: 'PUT', headers, body: data as unknown as BodyInit });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
  }
  async get(key: string) {
    checkKey(key);
    const { url, headers } = this.sign('GET', key, new Uint8Array());
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    return { data: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? undefined };
  }
  async delete(key: string) {
    checkKey(key);
    const { url, headers } = this.sign('DELETE', key, new Uint8Array());
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }
}

export function storageFromEnv(defaultDir: string): Storage {
  if (process.env.S3_BUCKET) {
    return new S3Storage({
      endpoint: process.env.S3_ENDPOINT ?? `https://s3.${process.env.S3_REGION ?? 'us-east-1'}.amazonaws.com`,
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    });
  }
  return new LocalStorage(join(defaultDir));
}

/** Read image dimensions from PNG/GIF/JPEG/WebP headers (no image library needed). */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57 && b[12] === 0x56) {
    const fmt = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (fmt === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (fmt === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/** Sniff the real type from magic bytes (never trust the client's Content-Type). */
export function sniffMime(b: Uint8Array, declared: string): string | null {
  const s = (n: number) => String.fromCharCode(...b.slice(0, n));
  if (b[0] === 0x89 && s(4).slice(1) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (s(4) === 'GIF8') return 'image/gif';
  if (s(4) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (String.fromCharCode(...b.slice(4, 12)).startsWith('ftypavif')) return 'image/avif';
  if (String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return 'video/mp4';
  if (s(5) === '%PDF-') return 'application/pdf';
  // SVG is allowed only as declared and is served with a CSP sandbox header.
  if (declared === 'image/svg+xml' && /<svg[\s>]/i.test(new TextDecoder().decode(b.slice(0, 2048)))) return 'image/svg+xml';
  return null;
}
