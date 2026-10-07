import { h, type Attrs, type VNode } from '@modulo/core';

/**
 * Convert untrusted VNode-like JSON ({tag, attrs, children} | string | number | array)
 * into core VNodes. Never produces raw HTML nodes; text is escaped by core's
 * renderer. Script-capable elements, event handlers and dangerous URLs are
 * dropped here (defence in depth on top of core's attribute sanitising).
 */
const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'meta',
  'noscript', 'template', 'slot', 'portal', 'svg', 'math', 'html', 'head', 'body', 'title', 'xmp', 'plaintext', 'noembed', 'noframes',
]);
const ATTR_RE = /^[a-zA-Z_][-a-zA-Z0-9_]*$/;
const BLOCKED_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'is', 'http-equiv']);

export interface VNodeLimits {
  maxNodes?: number;
  maxDepth?: number;
  maxText?: number;
}

function dangerousValue(v: string): boolean {
  const s = v.replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^(javascript|vbscript|livescript):/.test(s)) return true;
  if (s.startsWith('data:') && !/^data:image\/(png|jpe?g|gif|webp|avif);/.test(s)) return true;
  return false;
}

function cleanAttrs(input: unknown): Attrs {
  const out: Attrs = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ATTR_RE.test(k) || /^on/i.test(k) || BLOCKED_ATTRS.has(k.toLowerCase())) continue;
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'number' || v === true) {
      out[k] = v;
      continue;
    }
    if (typeof v !== 'string' || v.length > 4000) continue;
    if (dangerousValue(v)) continue;
    if (k.toLowerCase() === 'style' && /expression\s*\(|javascript:|url\s*\(|@import|behavior\s*:/i.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export function jsonToVNode(json: unknown, limits: VNodeLimits = {}): VNode {
  const maxNodes = limits.maxNodes ?? 2000;
  const maxDepth = limits.maxDepth ?? 32;
  const maxText = limits.maxText ?? 20_000;
  let count = 0;
  const conv = (n: unknown, depth: number): VNode => {
    if (++count > maxNodes || depth > maxDepth) return null;
    if (n === null || n === undefined || typeof n === 'boolean') return null;
    if (typeof n === 'string') return n.length > maxText ? n.slice(0, maxText) : n;
    if (typeof n === 'number') return Number.isFinite(n) ? n : null;
    if (Array.isArray(n)) return n.map((c) => conv(c, depth + 1));
    if (typeof n !== 'object') return null;
    const o = n as Record<string, unknown>;
    const tag = typeof o.tag === 'string' ? o.tag.toLowerCase() : '';
    if (!/^[a-z][a-z0-9-]*$/.test(tag) || BLOCKED_TAGS.has(tag)) return null;
    const kids = o.children === undefined ? [] : Array.isArray(o.children) ? o.children : [o.children];
    return h(tag, cleanAttrs(o.attrs), ...kids.map((c) => conv(c, depth + 1)));
  };
  return conv(json, 0);
}
