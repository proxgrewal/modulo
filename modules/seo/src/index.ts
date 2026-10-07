import { defineModule, type RouteRequest, type SiteContext, type SiteInfo } from '@modulo/kernel';
import { escapeHtml, extendModel, f, mf } from '@modulo/core';
import { escapeXml, requestBase, siteOrigin } from './util.ts';

export { escapeXml, siteOrigin } from './util.ts';

/** What the server passes to the page.head / page.bodyEnd filters. */
export interface PageInfo {
  ctx: SiteContext;
  site: SiteInfo;
  path: string;
  title: string;
  url: string;
  page: Record<string, any> | null;
  record: Record<string, any> | null;
  description?: string;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string | null;
}

const clean = (s: unknown, max = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};

/** Only absolute http(s) URLs (relative ones resolved against `base`) make it into meta tags. */
function absUrl(u: unknown, base: string | undefined): string | null {
  const s = String(u ?? '').trim();
  if (!s) return null;
  try {
    const url = base ? new URL(s, base) : new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** JSON for embedding inside <script>: no '<', '>', '&' or line separators can break out. */
export function jsonForScript(v: unknown): string {
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(ls)
    .join('\\' + 'u2028')
    .split(ps)
    .join('\\' + 'u2029');
}

/** Build SEO head tags for a rendered page. Every value is escaped; URLs must be http(s). */
export function buildHead(info: PageInfo): string {
  const ctx = info.ctx;
  const site = info.site ?? ctx.site;
  const settings = ctx?.settings('seo') ?? {};
  const page = info.page ?? null;
  const title = clean(page?.seo_title || info.title || site.name, 200);
  const description = clean(page?.seo_description || info.description || page?.description || settings.default_description || '');
  const url = absUrl(info.url, undefined);
  const image = absUrl(page?.og_image || settings.og_default_image, url ?? undefined);
  const twitter = clean(settings.twitter_handle, 30).replace(/^@?/, '@').replace(/[^@A-Za-z0-9_]/g, '');

  const meta = (attr: 'name' | 'property', key: string, value: string | null | undefined) =>
    value ? `<meta ${attr}="${key}" content="${escapeHtml(value)}">` : '';
  const out: string[] = [];
  out.push(meta('name', 'description', description));
  if (url) out.push(`<link rel="canonical" href="${escapeHtml(url)}">`);
  if (page?.noindex === true) out.push('<meta name="robots" content="noindex">');
  out.push(meta('property', 'og:type', info.record ? 'article' : 'website'));
  out.push(meta('property', 'og:title', title));
  out.push(meta('property', 'og:description', description));
  out.push(meta('property', 'og:url', url));
  out.push(meta('property', 'og:site_name', clean(site.name, 200)));
  out.push(meta('property', 'og:image', image));
  out.push(meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary'));
  out.push(meta('name', 'twitter:title', title));
  out.push(meta('name', 'twitter:description', description));
  out.push(meta('name', 'twitter:image', image));
  if (twitter.length > 1) out.push(meta('name', 'twitter:site', twitter));
  if (info.path === '/' && url) {
    const ld: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url };
    if (description) ld.description = description;
    out.push(`<script type="application/ld+json">${jsonForScript(ld)}</script>`);
  }
  return out.filter(Boolean).join('');
}

/** Percent-encode characters that are not allowed in a URL path, leaving existing escapes alone. */
function encodePath(p: string): string {
  return p.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%?#]/g, (c) => encodeURIComponent(c));
}

function toLastmod(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function indexablePages(ctx: SiteContext, noindex: boolean) {
  const sudo = ctx.asSudo();
  const where = noindex ? { status: 'published', noindex: true } : { status: 'published', $or: [{ noindex: false }, { noindex: null }] };
  const out: Record<string, any>[] = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const page = await sudo.repo('pages.page').find({ where, order: 'path asc', limit: 1000, offset });
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

/** Collect sitemap entries: published, indexable pages plus anything other modules add via the seo.sitemap hook. */
export async function sitemapEntries(ctx: SiteContext, origin: string): Promise<SitemapEntry[]> {
  const pages = await indexablePages(ctx, false);
  const own: SitemapEntry[] = pages.map((p) => ({ loc: String(p.path), lastmod: p.published_at ?? p.updated_at }));
  const extra = await ctx.hooks.filter<unknown>('seo.sitemap', [], ctx);
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  for (const e of [...own, ...(Array.isArray(extra) ? extra : [])]) {
    if (!e || typeof e !== 'object') continue;
    const raw = String((e as SitemapEntry).loc ?? '').trim();
    let loc: string | null = null;
    if (raw.startsWith('/') && !raw.startsWith('//')) loc = origin + encodePath(raw);
    else if (/^https?:\/\//i.test(raw)) loc = absUrl(raw, undefined);
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    out.push({ loc, lastmod: toLastmod((e as SitemapEntry).lastmod) });
  }
  return out;
}

async function sitemap(req: RouteRequest) {
  const entries = await sitemapEntries(req.ctx, siteOrigin(req));
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    entries.map((e) => `<url><loc>${escapeXml(e.loc)}</loc>${e.lastmod ? `<lastmod>${escapeXml(e.lastmod)}</lastmod>` : ''}</url>`).join('') +
    `</urlset>`;
  return { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' }, body };
}

async function robots(req: RouteRequest) {
  const origin = siteOrigin(req);
  const base = req.ctx.site.domain ? '' : requestBase(req);
  const hidden = await indexablePages(req.ctx, true);
  const lines = ['User-agent: *'];
  const paths = hidden.map((p) => String(p.path ?? '').replace(/[\s\u0000-\u001f]/g, '')).filter((p) => p.startsWith('/'));
  if (paths.length) for (const p of paths) lines.push(`Disallow: ${base}${encodePath(p)}`);
  else lines.push('Disallow:');
  lines.push('', `Sitemap: ${origin}/sitemap.xml`, '');
  return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: lines.join('\n') };
}

export default defineModule({
  name: 'seo',
  version: '1.0.0',
  label: 'SEO',
  description: 'Meta tags, Open Graph, canonical URLs, sitemap.xml and robots.txt.',
  category: 'marketing',
  kernel: '^1.0.0',
  depends: { pages: '^1.0.0' },
  extendModels: [
    extendModel({
      model: 'pages.page',
      fields: {
        seo_title: mf.string({ label: 'SEO title' }),
        seo_description: mf.text({ label: 'Meta description' }),
        og_image: mf.media({ label: 'Social image' }),
        noindex: mf.boolean({ label: 'Hide from search engines', default: false }),
      },
    }),
  ],
  hooks: [{ hook: 'page.head', kind: 'filter', id: 'meta', fn: (html: string, info: PageInfo) => (html ?? '') + buildHead(info) }],
  routes: [
    { method: 'GET', path: '/sitemap.xml', surface: 'site', permission: 'public', handler: sitemap },
    { method: 'GET', path: '/robots.txt', surface: 'site', permission: 'public', handler: robots },
  ],
  settings: {
    default_description: f.textarea({ label: 'Default meta description', default: '' }),
    twitter_handle: f.text({ label: 'Twitter/X handle', default: '' }),
    og_default_image: f.image({ label: 'Default social image', default: '' }),
  },
});
