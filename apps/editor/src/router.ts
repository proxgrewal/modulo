import { useSyncExternalStore } from 'react';

/** Minimal history router: /sites/:slug/pages/:id under the app base (/_editor/ when built). */
const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

export interface Route {
  name: 'home' | 'login' | 'signup' | 'sites' | 'new-site' | 'editor';
  site?: string;
  page?: string;
}

export function parseRoute(pathname: string): Route {
  let p = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  p = p.replace(/\/+$/, '') || '/';
  let m = /^\/sites\/([^/]+)(?:\/pages\/([^/]+))?$/.exec(p);
  if (m) return { name: 'editor', site: decodeURIComponent(m[1]!), page: m[2] ? decodeURIComponent(m[2]) : undefined };
  if (p === '/login') return { name: 'login' };
  if (p === '/signup') return { name: 'signup' };
  if (p === '/sites/new' || p === '/new') return { name: 'new-site' };
  if (p === '/sites') return { name: 'sites' };
  m = null;
  return { name: 'home' };
}

export function routeUrl(r: Route): string {
  switch (r.name) {
    case 'editor':
      return `${BASE}/sites/${encodeURIComponent(r.site!)}${r.page ? `/pages/${encodeURIComponent(r.page)}` : ''}`;
    case 'login':
      return `${BASE}/login`;
    case 'signup':
      return `${BASE}/signup`;
    case 'new-site':
      return `${BASE}/new`;
    case 'sites':
      return `${BASE}/sites`;
    default:
      return `${BASE}/`;
  }
}

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(r: Route, replace = false) {
  const url = routeUrl(r);
  if (url === location.pathname) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
  return parseRoute(path);
}
