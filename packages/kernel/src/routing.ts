import type { SiteContext } from './context.ts';
import { NotFoundError, UnauthorizedError, ForbiddenError } from './errors.ts';
import type { RouteResponse } from './module.ts';
import type { RouteEntry } from './runtime.ts';

/** Match a Hono-style path ("/products/:id") against a concrete path. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export function findRoute(routes: RouteEntry[], surface: 'api' | 'site', method: string, path: string, module?: string) {
  for (const r of routes) {
    if (r.surface !== surface || r.method !== method.toUpperCase()) continue;
    if (module && r.module !== module) continue;
    const params = matchPath(r.path, path);
    if (params) return { route: r, params };
  }
  return null;
}

/** Enforce a route's permission against a context. */
export function checkRoutePermission(route: RouteEntry, ctx: SiteContext) {
  const perm = route.permission ?? (route.surface === 'site' ? 'public' : 'auth');
  if (perm === 'public' || ctx.sudo) return;
  if (!ctx.user) throw new UnauthorizedError();
  if (perm === 'auth') return;
  if (!ctx.can(perm)) throw new ForbiddenError(`Missing permission "${perm}"`);
}

/**
 * Invoke a module route directly (tests, CLI, server). Path is relative to the
 * module for the api surface ("/products/123") and absolute for the site surface.
 */
export async function invokeRoute(
  ctx: SiteContext,
  opts: { surface?: 'api' | 'site'; module?: string; method: string; path: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> },
): Promise<RouteResponse> {
  const surface = opts.surface ?? 'api';
  const found = findRoute(ctx.runtime.routes, surface, opts.method, opts.path, opts.module);
  if (!found) throw new NotFoundError(`No ${surface} route ${opts.method} ${opts.path}${opts.module ? ` in ${opts.module}` : ''}`);
  checkRoutePermission(found.route, ctx);
  return found.route.handler({
    method: opts.method.toUpperCase(),
    path: opts.path,
    params: found.params,
    query: opts.query ?? {},
    headers: opts.headers ?? {},
    body: opts.body,
    ctx,
  });
}
