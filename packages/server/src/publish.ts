import { createHash } from 'node:crypto';
import {
  applyPatches,
  cloneTree,
  emptyPage,
  findNode,
  loadData,
  renderDocument,
  renderTree,
  themeToCss,
  BASE_CSS,
  EDIT_CSS,
  type PageNode,
  type PatchOp,
  type StylePreset,
  safeCustomCss,
} from '@modulo/core';
import { findRoute, checkRoutePermission, type Kernel, type SiteContext, type RouteResponse } from '@modulo/kernel';

/**
 * The publish plane: composes the site layout (module templates + module
 * patches + the site's own patches), slots the page into the outlet, loads
 * block data, renders to HTML with near-zero JS, and caches the result until a
 * publish/content event invalidates it (and purges the CDN).
 */
export interface CdnAdapter {
  purge(siteId: string, paths: string[] | 'all'): Promise<void>;
}

export const logCdn: CdnAdapter = {
  async purge() {
    /* No CDN in dev: the in-process cache is the only cache. Swap for Cloudflare/Fastly adapters in production. */
  },
};

interface CacheEntry {
  status: number;
  html: string;
  etag: string;
  headers: Record<string, string>;
  at: number;
}

export class PageCache {
  private entries = new Map<string, CacheEntry>();
  constructor(private ttlMs = 5 * 60_000, private max = 2000) {}
  key(siteId: string, path: string) {
    return `${siteId}|${path}`;
  }
  get(siteId: string, path: string) {
    const e = this.entries.get(this.key(siteId, path));
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(this.key(siteId, path));
      return null;
    }
    return e;
  }
  set(siteId: string, path: string, e: Omit<CacheEntry, 'at'>) {
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(this.key(siteId, path), { ...e, at: Date.now() });
  }
  invalidate(siteId: string, path?: string) {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${siteId}|`) && (!path || k === this.key(siteId, path))) this.entries.delete(k);
  }
  get size() {
    return this.entries.size;
  }
}

/** Site-level layout customisations are stored as patch ops applied after all module patches. */
export function sitePatchOps(ctx: SiteContext): PatchOp[] {
  return ((ctx.site.settings as any).layoutPatches ?? []) as PatchOp[];
}

/** Site-level reusable style presets and custom CSS (settings.stylePresets / settings.customCss). */
export function siteStyles(ctx: SiteContext): { presets: Record<string, StylePreset>; customCss: string } {
  const st = ctx.site.settings as any;
  return { presets: (st.stylePresets ?? {}) as Record<string, StylePreset>, customCss: String(st.customCss ?? '') };
}

export function composeLayout(ctx: SiteContext, templateId = 'core:layout') {
  const base = ctx.runtime.template(templateId);
  if (!base) return { tree: null as PageNode | null, provenance: {}, conflicts: [], failures: [] as any[] };
  const user = applyPatches(base.tree, [{ id: 'site.layout', module: 'site', template: templateId, ops: sitePatchOps(ctx) }]);
  return {
    tree: user.tree,
    provenance: { ...base.provenance, ...user.provenance },
    conflicts: base.conflicts,
    failures: [...base.failures, ...user.failures],
  };
}

/** Put the page document's children into the layout's outlet. */
export function wrapInLayout(ctx: SiteContext, page: PageNode, templateId?: string): PageNode {
  const { tree } = composeLayout(ctx, templateId);
  if (!tree) return page;
  const out = cloneTree(tree);
  let outlet: PageNode | null = null;
  const find = (n: PageNode) => {
    if (n.type === 'core:outlet') outlet = n;
    for (const c of Object.values(n.slots ?? {}).flat()) if (!outlet) find(c);
  };
  find(out);
  if (!outlet) return page;
  (outlet as PageNode).slots = { default: page.slots?.default ?? [] };
  return out;
}

export interface RenderInput {
  tree: PageNode;
  title: string;
  path: string;
  base: string;
  origin: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  record?: unknown;
  page?: Record<string, any> | null;
  description?: string;
  layout?: string | false;
  extraHead?: string;
}

export function siteScope(ctx: SiteContext, input: Pick<RenderInput, 'path' | 'base' | 'query' | 'params' | 'record' | 'page'>) {
  return {
    path: input.path,
    base: input.base,
    query: input.query ?? {},
    params: input.params ?? {},
    record: input.record ?? null,
    page: input.page ?? null,
    site: { id: ctx.site.id, name: ctx.site.name, slug: ctx.site.slug, copyright: `© ${new Date().getFullYear()} ${ctx.site.name}` },
  };
}

export async function renderSitePage(ctx: SiteContext, input: RenderInput): Promise<{ html: string; jsBytes: number }> {
  const theme = ctx.kernel.theme(ctx.site);
  const full = input.layout === false ? input.tree : wrapInLayout(ctx, input.tree, input.layout || input.page?.layout || 'core:layout');
  // Modules may transform the document before render (e.g. expand synced library components).
  const expanded = await ctx.hooks.filter('page.tree', full, { ctx, mode: 'publish' });
  const { tree } = ctx.runtime.blocks.migrateTree(expanded);
  const scope = siteScope(ctx, input);
  const data = await loadData(tree, ctx.runtime.blocks, { siteId: ctx.site.id, scope, services: { ctx } });
  const url = `${input.origin}${input.base}${input.path === '/' && input.base ? '' : input.path}`;
  const info = { ctx, site: ctx.site, path: input.path, title: input.title, url, page: input.page ?? null, record: input.record ?? null, description: input.description ?? input.page?.description };
  const head = (await ctx.hooks.filter('page.head', '', info)) + (input.extraHead ?? '');
  const bodyEnd = await ctx.hooks.filter('page.bodyEnd', '', info);
  const title = input.title === ctx.site.name ? input.title : `${input.title} · ${ctx.site.name}`;
  const styles = siteStyles(ctx);
  const r = renderDocument(tree, { registry: ctx.runtime.blocks, theme, title, scope, data, head, bodyEnd, presets: styles.presets, customCss: styles.customCss, lang: String((ctx.site.settings as any).lang ?? 'en') });
  return { html: r.document, jsBytes: r.jsBytes };
}

/** Editor canvas render: edit mode (node ids + slot markers), with or without layout. */
export async function renderForEditor(ctx: SiteContext, tree: PageNode, opts: { layout?: boolean; path?: string; base: string; record?: unknown }) {
  const theme = ctx.kernel.theme(ctx.site);
  let full = tree;
  let pageRootId: string | null = null;
  if (opts.layout) {
    full = wrapInLayout(ctx, tree);
    pageRootId = 'main';
  }
  full = await ctx.hooks.filter('page.tree', full, { ctx, mode: 'edit' });
  const migrated = ctx.runtime.blocks.migrateTree(full).tree;
  const scope = siteScope(ctx, { path: opts.path ?? '/', base: opts.base, record: opts.record });
  const data = await loadData(migrated, ctx.runtime.blocks, { siteId: ctx.site.id, scope, services: { ctx } });
  const styles = siteStyles(ctx);
  const r = renderTree(migrated, { registry: ctx.runtime.blocks, theme, mode: 'edit', scope, data, presets: styles.presets });
  // Layout nodes are not part of the page document: mark them read-only for the canvas.
  const layoutIds: string[] = [];
  if (opts.layout) {
    const walkIds = (n: PageNode) => {
      if (n.type === 'core:outlet') return;
      layoutIds.push(n.id);
      for (const c of Object.values(n.slots ?? {}).flat()) walkIds(c);
    };
    walkIds(migrated);
    if (findNode(migrated, 'main')) pageRootId = 'main';
  }
  return { html: r.html, css: themeToCss(theme) + BASE_CSS + r.css + safeCustomCss(styles.customCss), editCss: EDIT_CSS, layoutNodeIds: layoutIds, pageRootId, jsBytes: r.jsBytes };
}

export function etagOf(html: string) {
  return `"${createHash('sha1').update(html).digest('base64url').slice(0, 20)}"`;
}

export interface SiteRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  base: string;
  origin: string;
  preview: boolean;
}

export interface SiteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Resolve and render one published-site request. */
export async function handleSiteRequest(ctx: SiteContext, req: SiteRequest, cache: PageCache): Promise<SiteResponse> {
  const path = req.path.replace(/\/+$/, '') || '/';
  const cacheable = req.method === 'GET' && !req.preview && !Object.keys(req.query).length && !ctx.user;
  if (cacheable) {
    const hit = cache.get(ctx.site.id, `${req.base}${path}`);
    if (hit) {
      if (req.headers['if-none-match'] === hit.etag) return { status: 304, headers: { etag: hit.etag }, body: '' };
      return { status: hit.status, headers: { ...hit.headers, etag: hit.etag, 'x-modulo-cache': 'hit' }, body: hit.html };
    }
  }
  const respond = (status: number, html: string, headers: Record<string, string> = {}) => {
    const etag = etagOf(html);
    const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheable ? 'public, max-age=0, s-maxage=300, stale-while-revalidate=60' : 'private, no-store', ...headers };
    if (cacheable && (status === 200 || status === 404)) cache.set(ctx.site.id, `${req.base}${path}`, { status, html, etag, headers: h });
    return { status, headers: { ...h, etag, 'x-modulo-cache': 'miss' }, body: html };
  };

  // 1. Module site routes (/blog/:slug, /shop, /sitemap.xml, ...).
  const found = findRoute(ctx.runtime.routes, 'site', req.method, path);
  if (found) {
    checkRoutePermission(found.route, ctx);
    const res: RouteResponse = await found.route.handler({ method: req.method, path, params: found.params, query: req.query, headers: req.headers, body: req.body, ctx });
    if (res.page) {
      const out = await renderSitePage(ctx, { tree: res.page.tree, title: res.page.title, path, base: req.base, origin: req.origin, query: req.query, params: found.params, record: res.page.scope?.record, description: res.page.scope?.description as string | undefined, extraHead: res.page.head });
      return respond(res.status ?? 200, out.html, res.headers);
    }
    const body = typeof res.body === 'string' ? res.body : res.body === undefined ? '' : JSON.stringify(res.body);
    const headers = { 'content-type': typeof res.body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...(res.headers ?? {}) };
    if (cacheable && (res.status ?? 200) === 200 && req.method === 'GET') {
      const etag = etagOf(body);
      cache.set(ctx.site.id, `${req.base}${path}`, { status: 200, html: body, etag, headers });
      return { status: 200, headers: { ...headers, etag }, body };
    }
    return { status: res.status ?? 200, headers, body };
  }

  // 2. Pages.
  if (req.method === 'GET' && ctx.hasModule('pages')) {
    const repo = ctx.asSudo().repo('pages.page');
    const page = await repo.findOne(req.preview ? { path } : { path, status: 'published' });
    if (page) {
      if (req.preview) ctx.require('pages.edit');
      const tree = (req.preview ? page.draft : page.published) as PageNode | null;
      if (tree) {
        const out = await renderSitePage(ctx, { tree, title: page.title, path, base: req.base, origin: req.origin, page, description: page.description });
        return respond(200, out.html);
      }
    }
  }

  // 3. Not found, rendered inside the layout.
  if (req.method !== 'GET') return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
  const nf: PageNode = {
    ...emptyPage(),
    slots: {
      default: [
        {
          id: 'nf',
          type: 'core:section',
          props: { width: 'narrow' },
          slots: {
            default: [
              { id: 'nf-h', type: 'core:heading', props: { text: 'Page not found', level: 'h1' } },
              { id: 'nf-t', type: 'core:text', props: { html: '<p>The page you are looking for does not exist.</p>' } },
              { id: 'nf-b', type: 'core:button', props: { label: 'Go home', href: '/' } },
            ],
          },
        },
      ],
    },
  };
  const out = await renderSitePage(ctx, { tree: nf, title: 'Not found', path, base: req.base, origin: req.origin });
  return respond(404, out.html);
}

/** Invalidate caches and purge the CDN when content changes. */
export function wireInvalidation(kernel: Kernel, cache: PageCache, cdn: CdnAdapter) {
  return kernel.onEvent(async (siteId, event) => {
    if (event === 'pages.page.published' || event === 'pages.page.unpublished' || /\.(created|updated|deleted)$/.test(event) || event.startsWith('site.')) {
      cache.invalidate(siteId);
      await cdn.purge(siteId, 'all');
    }
  });
}
