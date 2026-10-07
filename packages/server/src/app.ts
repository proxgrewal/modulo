import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { defaultsFor, instantiate, compileDecl, PRESET_NAME_RE, styleCatalog, BREAKPOINTS, STYLE_STATES, tokenOptions, type PageNode, type PatchOp, type StylePreset } from '@modulo/core';
import {
  checkRoutePermission,
  findRoute,
  ForbiddenError,
  login,
  logout,
  ModuloError,
  NotFoundError,
  sessionUser,
  UnauthorizedError,
  ValidationError,
  type Kernel,
  type SiteContext,
  type UserRow,
} from '@modulo/kernel';
import { executeGraphql } from './graphql.ts';
import { composeLayout, handleSiteRequest, PageCache, renderForEditor, wireInvalidation, logCdn, type CdnAdapter } from './publish.ts';
import { imageSize, sniffMime, type Storage } from './storage.ts';

export interface AppOptions {
  kernel: Kernel;
  storage: Storage;
  cdn?: CdnAdapter;
  cache?: PageCache;
  /** Built editor (apps/editor/dist) served at /_editor. */
  editorDist?: string;
  /** Allow anyone to sign up (the first user always can and becomes superadmin). */
  openSignup?: boolean;
  /** Mark cookies Secure (set when served over https). */
  secureCookies?: boolean;
}

type Env = { Variables: { user: UserRow | null; viaCookie: boolean } };

const SESSION_COOKIE = 'modulo_session';
const MAX_UPLOAD = 20 * 1024 * 1024;

export function createApp(opts: AppOptions) {
  const { kernel, storage } = opts;
  const cache = opts.cache ?? new PageCache();
  const cdn = opts.cdn ?? logCdn;
  wireInvalidation(kernel, cache, cdn);
  const app = new Hono<Env>();

  /* ───────── errors ───────── */
  app.onError((err, c) => {
    if (err instanceof ModuloError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
    if ((err as any)?.name === 'HookChainError') return c.json({ error: { code: 'hook_chain', message: err.message } }, 500);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  /* ───────── security headers + session ───────── */
  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookie = getCookie(c, SESSION_COOKIE);
    const token = bearer ?? cookie;
    c.set('viaCookie', !bearer && !!cookie);
    c.set('user', token ? await sessionUser(kernel.db, token) : null);
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (!c.res.headers.get('x-frame-options') && !c.req.path.startsWith('/s/') && !c.req.path.startsWith('/media/')) c.header('x-frame-options', 'SAMEORIGIN');
  });

  /**
   * CSRF: cookie-authenticated state changes must be JSON (cross-site JSON
   * requires a CORS preflight we never grant) or carry our client header.
   */
  const csrfOk = (c: Context<Env>) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || !c.get('viaCookie')) return true;
    return (c.req.header('content-type') ?? '').startsWith('application/json') || c.req.header('x-modulo-client') === '1';
  };
  app.use('/api/*', async (c, next) => {
    if (!csrfOk(c)) throw new ForbiddenError('Cross-site request blocked (send JSON or the x-modulo-client header)');
    await next();
  });

  const json = async (c: Context<Env>): Promise<any> => {
    if (!(c.req.header('content-type') ?? '').includes('json')) return {};
    try {
      return await c.req.json();
    } catch {
      throw new ValidationError('Invalid JSON body');
    }
  };
  const requireUser = (c: Context<Env>) => {
    const u = c.get('user');
    if (!u) throw new UnauthorizedError();
    return u;
  };
  const siteCtx = async (c: Context<Env>, opts2: { member?: boolean } = { member: true }): Promise<SiteContext> => {
    const u = c.get('user');
    const ctx = await kernel.context(c.req.param('site')!, u?.id ?? null, { meta: { ip: c.req.header('x-forwarded-for') ?? '' } });
    if (opts2.member) {
      if (!ctx.user) throw new UnauthorizedError();
      if (!ctx.user.role && !ctx.user.isSuperadmin) throw new ForbiddenError('Not a member of this site');
    }
    return ctx;
  };
  const issueSession = (c: Context<Env>, token: string) =>
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: !!opts.secureCookies, path: '/', maxAge: 14 * 24 * 3600 });

  app.use('/api/*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413) }));

  /* ───────── health & auth ───────── */
  app.get('/api/health', (c) => c.json({ ok: true, kernel: kernel.version }));

  app.post('/api/auth/signup', async (c) => {
    const b = await json(c);
    const count = Number((await kernel.db.query(`SELECT count(*)::int AS n FROM modulo_users`)).rows[0].n);
    if (count > 0 && !opts.openSignup) throw new ForbiddenError('Sign-up is closed; ask an admin for an invite');
    const user = await kernel.createUser({ email: String(b.email ?? ''), password: String(b.password ?? ''), name: b.name, superadmin: count === 0 });
    const { token } = await login(kernel.db, user.email, String(b.password));
    issueSession(c, token);
    return c.json({ user, token }, 201);
  });
  app.post('/api/auth/login', async (c) => {
    const b = await json(c);
    const { token, user } = await login(kernel.db, String(b.email ?? ''), String(b.password ?? ''));
    issueSession(c, token);
    return c.json({ user, token });
  });
  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await logout(kernel.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/api/auth/me', (c) => c.json({ user: c.get('user') }));

  /** Module catalog for the create-site screen (no site needed). */
  app.get('/api/catalog', (c) => {
    requireUser(c);
    return c.json(
      kernel.catalog
        .names()
        .map((n) => kernel.catalog.get(n)[0]!)
        .filter((d) => !d.name.startsWith('x_') && !d.name.startsWith('app-'))
        .map((d) => ({ name: d.name, version: d.version, label: d.label ?? d.name, description: d.description, category: d.category, required: !!d.required, activatesWhen: d.activatesWhen, depends: d.depends ?? {} })),
    );
  });

  /* ───────── sites ───────── */
  app.get('/api/sites', async (c) => {
    const u = requireUser(c);
    return c.json(await kernel.listSites(u.is_superadmin ? undefined : u.id));
  });
  app.post('/api/sites', async (c) => {
    const u = requireUser(c);
    const b = await json(c);
    const modules = Array.isArray(b.modules) ? Object.fromEntries(b.modules.map((m: string) => [m, '*'])) : (b.modules ?? {});
    const site = await kernel.createSite({ slug: String(b.slug ?? ''), name: String(b.name ?? 'My site'), ownerId: u.id, modules, theme: b.theme });
    return c.json(site, 201);
  });
  app.get('/api/sites/:site', async (c) => c.json((await siteCtx(c)).site));
  app.patch('/api/sites/:site', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('core.design');
    const b = await json(c);
    if (b.domain !== undefined) ctx.require('*');
    const site = await kernel.updateSite(ctx.site.id, { name: b.name, domain: b.domain, theme: b.theme, settings: b.settings });
    kernel.invalidate(site.id);
    cache.invalidate(site.id);
    return c.json(site);
  });
  app.delete('/api/sites/:site', async (c) => {
    const ctx = await siteCtx(c);
    if (ctx.user?.role !== 'owner' && !ctx.user?.isSuperadmin) throw new ForbiddenError('Only the owner can delete a site');
    await kernel.deleteSite(ctx.site.id);
    cache.invalidate(ctx.site.id);
    return c.body(null, 204);
  });

  /** Everything the editor needs to boot: blocks (schemas), templates, theme, permissions, modules, contributions. */
  app.get('/api/sites/:site/runtime', async (c) => {
    const ctx = await siteCtx(c);
    const rt = ctx.runtime;
    const theme = kernel.theme(ctx.site);
    const tokens = Object.fromEntries((['color', 'space', 'radius', 'font', 'fontSize', 'shadow'] as const).map((g) => [g, tokenOptions(theme, g)]));
    return c.json({
      site: ctx.site,
      user: { id: ctx.user!.id, email: ctx.user!.email, name: ctx.user!.name, role: ctx.user!.role, permissions: [...ctx.user!.permissions], isSuperadmin: ctx.user!.isSuperadmin },
      theme,
      tokens,
      blocks: rt.blocks.list().map(({ render, load, migrate, islandProps, toPrimitives, ...b }) => ({ ...b, unpackable: !!toPrimitives })),
      templates: rt.templateIds(),
      modules: await kernel.installedModules(ctx.site.id),
      permissions: rt.permissions,
      editor: rt.defs.map((d) => ({ module: d.name, ...(d.editor ?? {}) })).filter((e) => e.collections || e.panels),
      settingsSchemas: Object.fromEntries(rt.defs.filter((d) => d.settings).map((d) => [d.name, d.settings])),
      settings: Object.fromEntries(rt.settings),
      conflicts: rt.conflicts(),
      presets: rt.presets,
      styleCatalog: styleCatalog(),
      breakpoints: BREAKPOINTS,
      styleStates: STYLE_STATES,
      stylePresets: (ctx.site.settings as any).stylePresets ?? {},
      customCss: (ctx.site.settings as any).customCss ?? '',
    });
  });

  /** Site style presets (reusable named styles) and custom CSS. */
  app.put('/api/sites/:site/styles', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('core.design');
    const b = await json(c);
    const out: Record<string, StylePreset> = {};
    const problems: string[] = [];
    const checkStyle = (name: string, where: string, st: unknown) => {
      if (st === undefined) return undefined;
      if (!st || typeof st !== 'object') return void problems.push(`${name}.${where} must be an object`);
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(st as Record<string, unknown>)) {
        if (v === '' || v === null || v === undefined) continue;
        if (compileDecl(k, v) === null) problems.push(`${name}.${where}.${k}: invalid value ${JSON.stringify(v)}`);
        else clean[k] = String(v);
      }
      return clean;
    };
    for (const [name, p] of Object.entries((b.presets ?? {}) as Record<string, any>)) {
      if (!PRESET_NAME_RE.test(name)) {
        problems.push(`Invalid preset name "${name}" (lowercase letters, digits, dashes)`);
        continue;
      }
      const preset: StylePreset = { label: String(p?.label ?? name).slice(0, 60), style: checkStyle(name, 'style', p?.style ?? {}) };
      if (p?.responsive) preset.responsive = Object.fromEntries(Object.keys(BREAKPOINTS).filter((bp) => p.responsive[bp]).map((bp) => [bp, checkStyle(name, bp, p.responsive[bp])!]));
      if (p?.states) preset.states = Object.fromEntries(STYLE_STATES.filter((st) => p.states[st]).map((st) => [st, checkStyle(name, st, p.states[st])!]));
      out[name] = preset;
    }
    if (problems.length) throw new ValidationError(problems.slice(0, 10).join('; '), problems);
    const settings: Record<string, unknown> = {};
    if (b.presets !== undefined) settings.stylePresets = out;
    if (b.customCss !== undefined) {
      if (typeof b.customCss !== 'string' || b.customCss.length > 100_000) throw new ValidationError('customCss must be a string up to 100KB');
      settings.customCss = b.customCss;
    }
    const site = await kernel.updateSite(ctx.site.id, { settings });
    kernel.invalidate(site.id);
    cache.invalidate(site.id);
    return c.json({ stylePresets: (site.settings as any).stylePresets ?? {}, customCss: (site.settings as any).customCss ?? '' });
  });

  /** Unpack a composite block into editable primitives (fresh ids). */
  app.post('/api/sites/:site/blocks/unpack', async (c) => {
    const ctx = await siteCtx(c);
    const b = await json(c);
    const node = b.node as PageNode | undefined;
    if (!node?.type) throw new ValidationError('node required');
    const def = ctx.runtime.blocks.get(node.type);
    if (!def?.toPrimitives) throw new ValidationError(`${node.type} cannot be unpacked`);
    const props = { ...defaultsFor(def.fields), ...(node.props ?? {}) };
    const out = instantiate(def.toPrimitives(props));
    // Keep the outer node's own style/responsive/states on the new wrapper.
    if (node.style) out.style = { ...(out.style ?? {}), ...node.style };
    if (node.responsive) out.responsive = { ...(out.responsive ?? {}), ...node.responsive };
    if (node.states) out.states = { ...(out.states ?? {}), ...node.states };
    if (node.presets) out.presets = node.presets;
    if (node.className) out.className = node.className;
    return c.json({ node: out });
  });

  /* ───────── members & roles ───────── */
  app.get('/api/sites/:site/members', async (c) => {
    const ctx = await siteCtx(c);
    const r = await kernel.db.query(`SELECT u.id, u.email, u.name, m.role FROM modulo_members m JOIN modulo_users u ON u.id = m.user_id WHERE m.site_id = $1 ORDER BY u.email`, [ctx.site.id]);
    return c.json(r.rows);
  });
  app.post('/api/sites/:site/members', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('core.members');
    const b = await json(c);
    const role = String(b.role ?? 'editor');
    if (role === 'owner' && ctx.user?.role !== 'owner' && !ctx.user?.isSuperadmin) throw new ForbiddenError('Only owners can add owners');
    let u = (await kernel.db.query(`SELECT id FROM modulo_users WHERE email=$1`, [String(b.email ?? '').toLowerCase()])).rows[0];
    let tempPassword: string | undefined;
    if (!u) {
      tempPassword = randomBytes(9).toString('base64url');
      u = await kernel.createUser({ email: String(b.email ?? ''), password: tempPassword, name: b.name });
    }
    await kernel.addMember(ctx.site.id, u.id, role);
    return c.json({ id: u.id, role, tempPassword }, 201);
  });
  app.delete('/api/sites/:site/members/:user', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('core.members');
    await kernel.db.query(`DELETE FROM modulo_members WHERE site_id=$1 AND user_id=$2 AND role <> 'owner'`, [ctx.site.id, c.req.param('user')]);
    return c.body(null, 204);
  });
  app.put('/api/sites/:site/roles/:role', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('core.members');
    const b = await json(c);
    if (!Array.isArray(b.permissions)) throw new ValidationError('permissions must be an array');
    await kernel.setRolePermissions(ctx.site.id, c.req.param('role'), b.permissions.map(String));
    return c.json({ ok: true });
  });

  /* ───────── modules ───────── */
  app.get('/api/sites/:site/modules', async (c) => {
    const ctx = await siteCtx(c);
    const installed = await kernel.installedModules(ctx.site.id);
    const catalog = kernel.catalog.names().map((n) => {
      const v = kernel.catalog.get(n);
      const d = v[0]!;
      return { name: n, versions: v.map((x) => x.version), label: d.label ?? n, description: d.description, category: d.category, depends: d.depends ?? {}, activatesWhen: d.activatesWhen, required: !!d.required };
    });
    return c.json({ installed, catalog });
  });
  const moduleChange = (b: any) => ({
    install: b.install && typeof b.install === 'object' ? b.install : undefined,
    uninstall: Array.isArray(b.uninstall) ? b.uninstall : undefined,
    upgrade: Array.isArray(b.upgrade) ? b.upgrade : undefined,
    cascade: !!b.cascade,
  });
  app.post('/api/sites/:site/modules/plan', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('*');
    const { defs, ...plan } = await kernel.plan(ctx.site.id, moduleChange(await json(c)));
    return c.json(plan);
  });
  app.post('/api/sites/:site/modules/apply', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('*');
    const { defs, ...report } = await kernel.applyChange(ctx.site.id, moduleChange(await json(c)), { actorId: ctx.user!.id });
    cache.invalidate(ctx.site.id);
    return c.json(report);
  });
  app.put('/api/sites/:site/modules/:module/settings', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('*');
    return c.json(await kernel.updateModuleSettings(ctx.site.id, c.req.param('module'), await json(c)));
  });
  app.post('/api/sites/:site/conflicts/resolve', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('*');
    const b = await json(c);
    await kernel.resolveConflict(ctx.site.id, String(b.key), String(b.module));
    cache.invalidate(ctx.site.id);
    return c.json({ ok: true });
  });
  app.get('/api/sites/:site/hooks', async (c) => c.json((await siteCtx(c)).runtime.hooks.describe()));
  app.get('/api/sites/:site/audit', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('*');
    return c.json((await kernel.db.query(`SELECT * FROM modulo_audit WHERE site_id=$1 ORDER BY id DESC LIMIT 200`, [ctx.site.id])).rows);
  });
  app.post('/api/sites/:site/webhooks', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('*');
    const b = await json(c);
    return c.json(await kernel.addWebhook(ctx.site.id, String(b.url ?? ''), Array.isArray(b.events) ? b.events.map(String) : ['*']), 201);
  });

  /* ───────── layout (site-level patches over module templates) ───────── */
  app.get('/api/sites/:site/layout', async (c) => {
    const ctx = await siteCtx(c);
    const l = composeLayout(ctx, c.req.query('template') ?? 'core:layout');
    return c.json({ ...l, ops: (ctx.site.settings as any).layoutPatches ?? [] });
  });
  app.put('/api/sites/:site/layout', async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('core.design');
    const b = await json(c);
    if (!Array.isArray(b.ops)) throw new ValidationError('ops must be an array of patch operations');
    const ops = b.ops as PatchOp[];
    const site = await kernel.updateSite(ctx.site.id, { settings: { layoutPatches: ops } });
    kernel.invalidate(site.id);
    cache.invalidate(site.id);
    const fresh = await kernel.context(site.id, ctx.user!.id);
    return c.json(composeLayout(fresh));
  });

  /* ───────── editor render ───────── */
  app.post('/api/sites/:site/render', async (c) => {
    const ctx = await siteCtx(c);
    const b = await json(c);
    if (!b.tree || typeof b.tree !== 'object') throw new ValidationError('tree required');
    const base = `/s/${ctx.site.slug}`;
    return c.json(await renderForEditor(ctx, b.tree as PageNode, { layout: b.layout !== false, path: b.path, base, record: b.record }));
  });

  /* ───────── generic data API (headless REST) ───────── */
  app.get('/api/sites/:site/models', async (c) => {
    const ctx = await siteCtx(c, { member: false });
    return c.json([...kernel.models.values()].filter((m) => ctx.runtime.installed.has(m.module)).map((m) => ctx.repo(m.name).describe()));
  });
  const parseWhere = (s: string | undefined) => {
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      throw new ValidationError('where must be JSON');
    }
  };
  app.get('/api/sites/:site/data/:model', async (c) => {
    const ctx = await siteCtx(c, { member: false });
    const q = c.req.query();
    const repo = ctx.repo(c.req.param('model'));
    const where = parseWhere(q.where);
    const [items, total] = await Promise.all([
      repo.find({ where, order: q.order, limit: q.limit ? Number(q.limit) : 50, offset: q.offset ? Number(q.offset) : 0, search: q.q }),
      repo.count(where),
    ]);
    return c.json({ items, total });
  });
  app.get('/api/sites/:site/data/:model/:id', async (c) => c.json(await (await siteCtx(c, { member: false })).repo(c.req.param('model')).get(c.req.param('id'))));
  app.post('/api/sites/:site/data/:model', async (c) => c.json(await (await siteCtx(c)).repo(c.req.param('model')).create(await json(c)), 201));
  app.patch('/api/sites/:site/data/:model/:id', async (c) => c.json(await (await siteCtx(c)).repo(c.req.param('model')).update(c.req.param('id'), await json(c))));
  app.delete('/api/sites/:site/data/:model/:id', async (c) => {
    await (await siteCtx(c)).repo(c.req.param('model')).delete(c.req.param('id'));
    return c.body(null, 204);
  });
  app.post('/api/sites/:site/graphql', async (c) => c.json(await executeGraphql(await siteCtx(c, { member: false }), await json(c))));

  /* ───────── module API routes ───────── */
  const moduleRoute = async (c: Context<Env>, siteKey: string, module: string, rest: string, dropCookieUser: boolean, base = '') => {
    const u = dropCookieUser ? null : c.get('user');
    const ctx = await kernel.context(siteKey, u?.id ?? null, { meta: { base, ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'local', ua: c.req.header('user-agent') ?? '' } });
    const found = findRoute(ctx.runtime.routes, 'api', c.req.method, rest || '/', module);
    if (!found) throw new NotFoundError(`No route ${c.req.method} ${rest} in module ${module}`);
    checkRoutePermission(found.route, ctx);
    if (found.route.permission !== 'public' && ctx.user && !ctx.user.role && !ctx.user.isSuperadmin) throw new ForbiddenError('Not a member of this site');
    let body: unknown;
    let rawBody: string | undefined;
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      rawBody = await c.req.text();
      const ct = c.req.header('content-type') ?? '';
      if (ct.includes('json') && rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new ValidationError('Invalid JSON body');
        }
      } else if (ct.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(rawBody));
      else body = rawBody || {};
    }
    const res = await found.route.handler({ method: c.req.method, path: rest, params: found.params, query: c.req.query(), headers: c.req.header(), body, rawBody, ctx });
    for (const [k, v] of Object.entries(res.headers ?? {})) c.header(k, v);
    if (res.status === 204) return c.body(null, 204);
    if (typeof res.body === 'string') return c.body(res.body, (res.status ?? 200) as any);
    return c.json(res.body ?? null, (res.status ?? 200) as any);
  };
  app.all('/api/sites/:site/m/:module/*', (c) => {
    const rest = c.req.path.split(`/m/${c.req.param('module')}`)[1] ?? '/';
    return moduleRoute(c, c.req.param('site')!, c.req.param('module')!, rest, false);
  });

  /* ───────── media ───────── */
  app.post('/api/sites/:site/media', bodyLimit({ maxSize: MAX_UPLOAD + 64 * 1024 }), async (c) => {
    const ctx = await siteCtx(c);
    ctx.require('media.upload');
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new ValidationError('Expected a multipart "file" field');
    if (file.size > MAX_UPLOAD) throw new ValidationError('File too large (20MB max)');
    const data = new Uint8Array(await file.arrayBuffer());
    const mime = sniffMime(data, file.type);
    if (!mime) throw new ValidationError('Unsupported file type');
    const safeName = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file';
    const key = `${ctx.site.id}/${randomBytes(8).toString('hex')}-${safeName}`;
    await storage.put(key, data, mime);
    const dims = mime.startsWith('image/') ? imageSize(data) : null;
    const url = await ctx.hooks.filter('media.url', `/media/${key}`, { key, mime });
    const asset = await ctx.repo('media.asset').create({ filename: file.name.slice(0, 255), storage_key: key, url, mime, size: data.length, width: dims?.width ?? null, height: dims?.height ?? null, alt: String(form.alt ?? ''), folder: String(form.folder ?? '') });
    return c.json(asset, 201);
  });
  app.delete('/api/sites/:site/media/:id', async (c) => {
    const ctx = await siteCtx(c);
    const asset = await ctx.repo('media.asset').get(c.req.param('id'));
    await ctx.repo('media.asset').delete(asset.id);
    await storage.delete(asset.storage_key);
    return c.body(null, 204);
  });
  app.get('/media/*', async (c) => {
    const key = c.req.path.slice('/media/'.length);
    const obj = await storage.get(decodeURIComponent(key)).catch(() => null);
    if (!obj) return c.text('Not found', 404);
    c.header('content-type', obj.contentType ?? 'application/octet-stream');
    c.header('cache-control', 'public, max-age=31536000, immutable');
    if (obj.contentType === 'image/svg+xml') c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return c.body(obj.data as any);
  });

  /* ───────── published sites ───────── */
  const serveSite = async (c: Context<Env>, ctxSite: string, base: string, path: string) => {
    // Site-facing module API alias used by islands: <base>/_api/m/<module>/...
    const apiMatch = /^\/_api\/m\/([a-z0-9-]+)(\/.*)?$/.exec(path);
    if (apiMatch) {
      if (!csrfOk(c)) throw new ForbiddenError('Cross-site request blocked');
      return moduleRoute(c, ctxSite, apiMatch[1]!, apiMatch[2] ?? '/', false, base);
    }
    // Non-JSON cookie-authenticated posts (plain HTML forms) run anonymously.
    const user = csrfOk(c) ? c.get('user') : null;
    const ctx = await kernel.context(ctxSite, user?.id ?? null, { meta: { base, ip: c.req.header('x-forwarded-for') ?? 'local', ua: c.req.header('user-agent') ?? '' } });
    const preview = c.req.query('preview') === 'draft';
    let body: unknown;
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const ct = c.req.header('content-type') ?? '';
      body = ct.includes('json') ? await c.req.json().catch(() => ({})) : ct.includes('form') ? await c.req.parseBody() : await c.req.text();
    }
    const query = { ...c.req.query() };
    delete query.preview;
    const origin = new URL(c.req.url).origin;
    const res = await handleSiteRequest(ctx, { method: c.req.method, path, query, headers: c.req.header(), body, base, origin, preview }, cache);
    for (const [k, v] of Object.entries(res.headers)) c.header(k, v);
    return res.status === 304 ? c.body(null, 304) : c.body(res.body, res.status as any);
  };
  app.all('/s/:slug', (c) => serveSite(c, c.req.param('slug')!, `/s/${c.req.param('slug')}`, '/'));
  app.all('/s/:slug/*', (c) => {
    const slug = c.req.param('slug')!;
    return serveSite(c, slug, `/s/${slug}`, c.req.path.slice(`/s/${slug}`.length) || '/');
  });

  /* ───────── editor static files ───────── */
  const dist = opts.editorDist && existsSync(opts.editorDist) ? resolve(opts.editorDist) : null;
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
  app.get('/_editor/*', (c) => {
    if (!dist) return c.text('Editor not built. Run `pnpm build:editor`, or use the Vite dev server (pnpm dev:editor).', 404);
    let file = resolve(dist, '.' + c.req.path.slice('/_editor'.length));
    if (!file.startsWith(dist + sep) && file !== dist) return c.text('Not found', 404);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    c.header('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    if (file.includes(`${sep}assets${sep}`)) c.header('cache-control', 'public, max-age=31536000, immutable');
    return c.body(readFileSync(file));
  });

  /* ───────── custom domains (Host header) and root ───────── */
  app.all('*', async (c) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    const site = host ? await kernel.findSiteByDomain(host) : null;
    if (site) return serveSite(c, site.id, '', c.req.path);
    if (c.req.path === '/') return dist ? c.redirect('/_editor/') : c.json({ name: 'Modulo', kernel: kernel.version, editor: '/_editor/', api: '/api/health' });
    return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });

  return { app, cache };
}
