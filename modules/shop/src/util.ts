import { escapeHtml } from '@modulo/core';

export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function money(amount: number | null | undefined, currency = 'USD') {
  const n = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Site prefix from the render/load scope ('' or '/s/slug'), sanitised for use in hrefs. */
export function baseOf(scope: Record<string, unknown> | undefined): string {
  const b = String(scope?.base ?? '');
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(b) ? b : '';
}

const DROP_TAGS = /<(script|style|iframe|object|embed|template|noscript|form|textarea|select|meta|link|base)\b[\s\S]*?(<\/\1\s*>|$)/gi;
const LONE_TAGS = /<\/?(script|style|iframe|object|embed|meta|link|base|form|input|button)\b[^>]*>/gi;

/**
 * Conservative clean-up of editor-authored rich text before emitting it raw:
 * drops active elements, inline event handlers, and javascript:/data: URLs.
 */
export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return '';
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_TAGS, '')
    .replace(LONE_TAGS, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'\s>]*\2?/gi, ' $1="#"')
    .replace(/\s+style\s*=\s*("[^"]*expression\([^"]*"|'[^']*expression\([^']*')/gi, '');
}

export { escapeHtml };
