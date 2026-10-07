import type { BlockDefinition, RenderContext, VNode } from '@modulo/core';
import { ForbiddenError, ModuloError, SiteContext, type ModuleDefinition, type RouteResponse, type TrustTier } from '@modulo/kernel';
import { runInSandbox, safeJson, SandboxError, type SandboxLimits } from './engine.ts';
import { capMatch, hasCapability, hostAllowed, validatePackage, type AppManifest, type AppPackage } from './manifest.ts';
import { jsonToVNode } from './vnode.ts';

export interface AppLimits {
  memoryBytes?: number;
  /** CPU budget for blocks and filters/actions (ms). Default 200. */
  fastMs?: number;
  /** CPU budget for routes and events (ms). Default 2000. */
  slowMs?: number;
  /** Wall-clock limit for blocks/hooks (ms, includes host I/O). Default 5000. */
  fastWallMs?: number;
  /** Wall-clock limit for routes/events (ms). Default 15000. */
  slowWallMs?: number;
  maxHostCalls?: number;
}

export interface AppToModuleOptions {
  limits?: AppLimits;
  /** Receives host.log / console.log output. Default: console.log with an [app:<name>] prefix. */
  log?: (app: string, message: string) => void;
  /** Trust tier, recorded on the definition for UIs. */
  trust?: TrustTier;
  /** host.fetch limits. */
  fetchTimeoutMs?: number;
  fetchMaxBytes?: number;
}

export type AppModuleDefinition = ModuleDefinition & {
  app: { manifest: AppManifest; capabilities: string[]; trust?: TrustTier };
};

const REQ_HEADER_DENY = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-api-key']);
const RES_HEADER_ALLOW = /^(cache-control|content-language|etag|last-modified|vary|x-[a-z0-9-]+)$/i;
const FETCH_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

class CapabilityError extends ForbiddenError {}

/** Turn a (validated) app package into a kernel ModuleDefinition whose handlers run in QuickJS. */
export function appToModule(input: AppPackage, opts: AppToModuleOptions = {}): AppModuleDefinition {
  const pkg = validatePackage(input);
  const m = pkg.manifest;
  const name = m.name;
  const L = opts.limits ?? {};
  const fast: SandboxLimits = { memoryBytes: L.memoryBytes, cpuMs: L.fastMs ?? 200, wallMs: L.fastWallMs ?? 5_000, maxHostCalls: L.maxHostCalls };
  const slow: SandboxLimits = { memoryBytes: L.memoryBytes, cpuMs: L.slowMs ?? 2_000, wallMs: L.slowWallMs ?? 15_000, maxHostCalls: L.maxHostCalls };
  const log = opts.log ?? ((app, msg) => console.log(`[app:${app}]`, msg));

  const deny = (cap: string, what: string): never => {
    throw new CapabilityError(`Capability denied: ${name} lacks "${cap}" (${what})`);
  };

  /** Host API implementation for one invocation. `ctx` is the site context the hook/route/event/block runs in. */
  const makeHost = (ctx: SiteContext | undefined) => {
    let logs = 0;
    const needCtx = (what: string): SiteContext => {
      if (!ctx) throw new Error(`${what} is not available here (no site context)`);
      return ctx;
    };
    const repoFor = (model: unknown, write: boolean, what: string) => {
      if (typeof model !== 'string' || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(model)) throw new Error(`${what}: invalid model name`);
      const cap = `${write ? 'write' : 'read'}:${model}`;
      if (!hasCapability(m, cap)) deny(cap, `host.repo('${model}').${what}`);
      // The app acts as its own principal: capabilities (consented at install)
      // are the access control, so the repository runs with sudo — still
      // bound to this site by RLS, validation, hooks and events.
      return needCtx('host.repo').asSudo().repo(model);
    };
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
    return async (op: string, args: unknown[]): Promise<unknown> => {
      switch (op) {
        case 'repo.find': {
          const q = obj(args[1]);
          return repoFor(args[0], false, 'find').find({
            where: q.where,
            order: typeof q.order === 'string' ? q.order : undefined,
            limit: Math.min(Number(q.limit) || 50, 200),
            offset: Number(q.offset) || undefined,
            search: typeof q.search === 'string' ? q.search : undefined,
          });
        }
        case 'repo.findOne':
          return repoFor(args[0], false, 'findOne').findOne(obj(args[1]));
        case 'repo.count':
          return repoFor(args[0], false, 'count').count(obj(args[1]));
        case 'repo.get':
          return repoFor(args[0], false, 'get').get(String(args[1]));
        case 'repo.create':
          return repoFor(args[0], true, 'create').create(obj(args[1]));
        case 'repo.update':
          return repoFor(args[0], true, 'update').update(String(args[1]), obj(args[2]));
        case 'repo.delete':
          await repoFor(args[0], true, 'delete').delete(String(args[1]));
          return null;
        case 'fetch':
          return hostFetch(String(args[0]), obj(args[1]));
        case 'emit': {
          const event = String(args[0]);
          if (!/^[a-z0-9_.:-]+$/i.test(event)) throw new Error('host.emit: invalid event name');
          const allowed = m.capabilities.some((c) => c.startsWith('emit:') && capMatch(c.slice(5), event));
          if (!allowed) deny(`emit:${event}`, `host.emit('${event}')`);
          const payload = obj(args[1]);
          if (safeJson(payload).length > 64 * 1024) throw new Error('host.emit: payload too large');
          await needCtx('host.emit').emit(event, payload);
          return null;
        }
        case 'settings':
          return needCtx('host.settings').settings(name);
        case 'log':
          if (++logs <= 50) log(name, args.map((a) => String(a).slice(0, 2000)).join(' '));
          return null;
        default:
          throw new Error(`Unknown host operation "${op}"`);
      }
    };
  };

  const hostFetch = async (rawUrl: string, init: Record<string, any>) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`host.fetch: invalid URL "${rawUrl}"`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CapabilityError(`Capability denied: host.fetch only supports http(s) URLs`);
    if (url.username || url.password) throw new Error('host.fetch: credentials in URLs are not allowed');
    if (!hostAllowed(m, url)) deny(`http:${url.hostname}${url.port ? ':' + url.port : ''}`, `host.fetch('${url.origin}')`);
    const method = String(init.method ?? 'GET').toUpperCase();
    if (!FETCH_METHODS.includes(method)) throw new Error(`host.fetch: method ${method} not allowed`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers && typeof init.headers === 'object' ? init.headers : {})) {
      if (/^[A-Za-z0-9-]+$/.test(k) && !/^(host|connection|content-length|transfer-encoding)$/i.test(k)) headers[k] = String(v);
    }
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.fetchTimeoutMs ?? 5_000);
    try {
      // redirect: 'manual' so a redirect can never escape the host allowlist.
      const res = await globalThis.fetch(url.toString(), { method, headers, body, redirect: 'manual', signal: ac.signal });
      const max = opts.fetchMaxBytes ?? 1024 * 1024;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > max) throw new Error(`host.fetch: response exceeds ${max} bytes`);
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'set-cookie') outHeaders[k] = v;
      });
      return { status: res.status, headers: outHeaders, text: new TextDecoder().decode(buf) };
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('host.fetch: request timed out');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  const invoke = async (kind: string, key: string, args: unknown[], ctx: SiteContext | undefined, limits: SandboxLimits): Promise<unknown> => {
    try {
      return await runInSandbox({
        app: name,
        code: pkg.code,
        kind,
        key,
        args: JSON.parse(safeJson(args, (v) => v instanceof SiteContext)),
        host: makeHost(ctx),
        limits,
      });
    } catch (e) {
      if (e instanceof SandboxError) throw e;
      throw new ModuloError(`App "${name}" ${kind} "${key}" failed: ${(e as Error)?.message ?? e}`, 500, 'app_error', { app: name });
    }
  };

  const def: AppModuleDefinition = {
    name,
    version: m.version,
    kernel: m.kernel,
    label: m.label,
    description: m.description,
    category: 'apps',
    depends: m.depends ?? {},
    models: m.models ?? [],
    settings: m.settings ?? {},
    app: { manifest: m, capabilities: [...m.capabilities], trust: opts.trust },

    hooks: (m.hooks ?? []).map((hk) => ({
      hook: hk.hook,
      kind: hk.kind,
      id: hk.id,
      fn: async (...args: unknown[]) => {
        const ctx = args.find((a): a is SiteContext => a instanceof SiteContext);
        const plain = args.filter((a) => !(a instanceof SiteContext));
        const out = await invoke('hook', hk.hook, plain, ctx, fast);
        if (hk.kind === 'filter') return out === undefined ? args[0] : out;
      },
    })),

    routes: (m.routes ?? []).map((r) => ({
      method: r.method,
      path: r.path,
      surface: r.surface,
      permission: r.permission,
      handler: async (req) => {
        const headers = Object.fromEntries(Object.entries(req.headers ?? {}).filter(([k]) => !REQ_HEADER_DENY.has(k.toLowerCase())));
        const out = await invoke(
          'route',
          `${r.method} ${r.path}`,
          [{ method: req.method, path: req.path, params: req.params, query: req.query, headers, body: req.body, user: req.ctx.user ? { id: req.ctx.user.id, name: req.ctx.user.name } : null }],
          req.ctx,
          slow,
        );
        return toRouteResponse(out, r.surface);
      },
    })),

    events: (m.events ?? []).map((ev) => ({
      event: ev.event,
      handler: async (payload: unknown, ctx: SiteContext) => {
        await invoke('on', ev.event, [payload], ctx, slow);
      },
    })),

    blocks: (m.blocks ?? []).map(
      (b): BlockDefinition => ({
        type: b.type,
        version: 1,
        label: b.label,
        category: b.category ?? 'Apps',
        description: b.description,
        fields: b.fields ?? {},
        // render() must be synchronous, so the sandboxed render runs in load() and is cached in ctx.data.
        load: async (props, loadCtx) => {
          const ctx = loadCtx.services?.ctx instanceof SiteContext ? (loadCtx.services.ctx as SiteContext) : undefined;
          const scope = loadCtx.scope ?? {};
          const out = await invoke('block', b.type, [props, { path: scope.path, params: scope.params, query: scope.query }], ctx, fast);
          return { vnode: jsonToVNode(out) };
        },
        render: (_props, rctx: RenderContext<{ vnode?: VNode; __error?: string } | undefined>) => {
          const d = rctx.data;
          if (!d || d.__error || d.vnode === undefined) {
            return rctx.mode === 'edit'
              ? rctx.root('div', { class: 'm-app-block' }, d?.__error ? `App block error: ${d.__error}` : `${b.label} (rendered on publish)`)
              : rctx.root('div', { class: 'm-app-block' });
          }
          const v = d.vnode;
          if (v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'el') return rctx.root(v.tag, v.attrs, ...v.children);
          return rctx.root('div', { class: 'm-app-block' }, v);
        },
      }),
    ),
  };
  return def;
}

function toRouteResponse(out: unknown, surface: 'api' | 'site'): RouteResponse {
  const o = out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, any>) : null;
  const shaped = o && ('status' in o || 'body' in o || 'headers' in o || 'page' in o);
  const status = shaped && Number.isInteger(o!.status) && o!.status >= 100 && o!.status <= 599 ? (o!.status as number) : 200;
  const body = shaped ? o!.body : out;
  const headers: Record<string, string> = {};
  if (shaped && o!.headers && typeof o!.headers === 'object') {
    for (const [k, v] of Object.entries(o!.headers)) if (RES_HEADER_ALLOW.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k.toLowerCase()] = v;
  }
  if (shaped && surface === 'site' && o!.page && typeof o!.page === 'object' && o!.page.tree) {
    return { status, headers, page: { tree: o!.page.tree, title: String(o!.page.title ?? '') } };
  }
  if (typeof body === 'string') {
    // Never let sandboxed code serve active HTML on the site origin.
    headers['content-type'] = 'text/plain; charset=utf-8';
    headers['x-content-type-options'] = 'nosniff';
    headers['content-security-policy'] = "sandbox; default-src 'none'";
  }
  return { status, headers, body: body ?? null };
}
