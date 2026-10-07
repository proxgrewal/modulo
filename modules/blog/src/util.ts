import type { RouteRequest, SiteContext } from '@modulo/kernel';

export function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

/** URL prefix of the site ('' in production, '/s/<slug>' in dev) when the server tells us. */
export function requestBase(req: Pick<RouteRequest, 'headers' | 'ctx'>): string {
  const b = (req.ctx.meta?.base as string | undefined) ?? header(req.headers, 'x-modulo-base') ?? '';
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(b) ? b : '';
}

/** Absolute origin + base for building canonical URLs (feeds, sitemaps). */
export function siteOrigin(req: Pick<RouteRequest, 'headers' | 'ctx'>): string {
  const domain = req.ctx.site.domain;
  if (domain && /^[a-z0-9.-]+(:\d+)?$/i.test(domain)) return `https://${domain}`;
  const rawHost = header(req.headers, 'x-forwarded-host') ?? header(req.headers, 'host') ?? 'localhost';
  const host = /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(rawHost.trim()) ? rawHost.trim() : 'localhost';
  const proto = (header(req.headers, 'x-forwarded-proto') ?? '').split(',')[0]!.trim() === 'https' ? 'https' : 'http';
  return `${proto}://${host}${requestBase(req)}`;
}

export function escapeXml(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Pretty date for display. */
export function formatDate(iso: unknown): string {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function isAnonymousReader(ctx: SiteContext): boolean {
  return !ctx.sudo && !ctx.can('blog.manage');
}
