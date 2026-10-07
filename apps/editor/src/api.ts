/** Thin fetch wrapper for the Modulo HTTP API (same origin; session cookie). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(err?.message ?? (typeof data === 'string' && data ? data.slice(0, 200) : `Request failed (${res.status})`), res.status, err?.code, err?.details);
  }
  return data;
}

export async function api<T = any>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-modulo-client': '1', ...((init.headers as Record<string, string>) ?? {}) };
  const opts: RequestInit = { ...init, method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof FormData) opts.body = body;
    else {
      headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  return parse(res);
}

export const get = <T = any>(path: string, init?: RequestInit) => api<T>('GET', path, undefined, init);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const put = <T = any>(path: string, body: unknown = {}) => api<T>('PUT', path, body);
export const patch = <T = any>(path: string, body: unknown = {}) => api<T>('PATCH', path, body);
export const del = <T = any>(path: string) => api<T>('DELETE', path);

export const sitePath = (site: string, rest = '') => `/api/sites/${encodeURIComponent(site)}${rest}`;
export const pagesPath = (site: string, rest = '') => sitePath(site, `/m/pages${rest}`);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
