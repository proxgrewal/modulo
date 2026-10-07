import { ValidationError } from '@modulo/kernel';
import type { FieldMap, ModelDef } from '@modulo/core';

/** Declarative description of a community app (everything the kernel needs at compose time). */
export interface AppManifest {
  /** Module name; must start with "app-". */
  name: string;
  version: string;
  /** semver range of the kernel API. */
  kernel: string;
  label: string;
  description: string;
  depends?: Record<string, string>;
  /** e.g. ["read:shop.product", "write:forms.submission", "http:api.example.com", "emit:app-x.*"] */
  capabilities: string[];
  hooks?: { hook: string; kind: 'filter' | 'action'; id?: string }[];
  routes?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; surface: 'api' | 'site'; permission?: string }[];
  events?: { event: string }[];
  blocks?: { type: string; label: string; fields: FieldMap; category?: string; description?: string }[];
  settings?: FieldMap;
  /** Field-only model definitions, namespaced "<app_name>.*". */
  models?: ModelDef[];
}

export interface AppPackage {
  manifest: AppManifest;
  /** JavaScript run inside QuickJS; registers handlers via app.hook/route/on/block. */
  code: string;
}

export const MAX_CODE_BYTES = 512 * 1024;
const NAME_RE = /^app-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const FIELD_KINDS = ['text', 'textarea', 'richtext', 'number', 'boolean', 'select', 'token', 'image', 'link', 'color', 'list', 'collection'];
const MODEL_FIELD_KINDS = ['string', 'text', 'richtext', 'int', 'float', 'money', 'boolean', 'date', 'datetime', 'enum', 'json', 'ref', 'media', 'slug', 'email', 'url'];
const CAP_RE = /^(?:(?:read|write):[a-z0-9_]+(?:\.[a-z0-9_]+)*(?:\.\*)?|http:(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?|emit:[a-z0-9_.:-]+\*?)$/;

/** Model namespace of an app: "app-foo-bar" -> "app_foo_bar". */
export function appNamespace(name: string) {
  return name.replace(/-/g, '_');
}

/** Glob-ish match: a trailing "*" matches any suffix. */
export function capMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return false;
}

/** Does the app hold `needed` (e.g. "read:shop.product")? Own models are implicitly allowed. */
export function hasCapability(manifest: Pick<AppManifest, 'name' | 'capabilities'>, needed: string): boolean {
  const idx = needed.indexOf(':');
  const verb = needed.slice(0, idx);
  const target = needed.slice(idx + 1);
  if ((verb === 'read' || verb === 'write') && target.startsWith(appNamespace(manifest.name) + '.')) return true;
  return manifest.capabilities.some((c) => {
    const i = c.indexOf(':');
    return c.slice(0, i) === verb && capMatch(c.slice(i + 1), target);
  });
}

/** http:<host> capability check (exact host, or "*.example.com" for subdomains; port must match if given). */
export function hostAllowed(manifest: Pick<AppManifest, 'capabilities'>, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return manifest.capabilities.some((c) => {
    if (!c.startsWith('http:')) return false;
    let spec = c.slice(5).toLowerCase();
    let port = '';
    const m = /:(\d+)$/.exec(spec);
    if (m) {
      port = m[1]!;
      spec = spec.slice(0, -m[0].length);
    }
    if (port ? url.port !== port : url.port !== '') return false;
    if (spec.startsWith('*.')) return host.endsWith(spec.slice(1));
    return host === spec;
  });
}

/** Capability required for an app to subscribe to a model hook ("model.<model>.<op>"); null for other hooks. */
export function hookCapability(hook: string, kind: 'filter' | 'action'): string | null {
  const m = /^model\.(.+)\.[A-Za-z]+$/.exec(hook);
  if (!m) return null;
  return `${kind === 'filter' ? 'write' : 'read'}:${m[1]}`;
}

/** Validate an app package; throws ValidationError listing every problem. Returns a normalised copy. */
export function validatePackage(pkg: AppPackage): AppPackage {
  const problems: string[] = [];
  const p = (msg: string) => problems.push(msg);
  if (!pkg || typeof pkg !== 'object') throw new ValidationError('App package must be an object');
  const m = pkg.manifest as AppManifest;
  if (!m || typeof m !== 'object') throw new ValidationError('App package is missing its manifest');
  if (typeof pkg.code !== 'string') p('code must be a string');
  else if (Buffer.byteLength(pkg.code) > MAX_CODE_BYTES) p(`code exceeds ${MAX_CODE_BYTES} bytes`);

  const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!isStr(m.name, 50) || !NAME_RE.test(m.name)) p('manifest.name must match "app-<lowercase-name>"');
  if (!isStr(m.version, 64) || !SEMVER_RE.test(m.version)) p('manifest.version must be a semver version');
  if (!isStr(m.kernel, 64)) p('manifest.kernel must be a semver range');
  if (!isStr(m.label, 100)) p('manifest.label is required');
  if (typeof m.description !== 'string' || m.description.length > 2000) p('manifest.description must be a string');
  if (m.depends !== undefined && (typeof m.depends !== 'object' || Object.entries(m.depends).some(([k, v]) => typeof k !== 'string' || typeof v !== 'string')))
    p('manifest.depends must map module names to ranges');
  if (!Array.isArray(m.capabilities)) p('manifest.capabilities must be an array');
  else {
    for (const c of m.capabilities) if (typeof c !== 'string' || !CAP_RE.test(c)) p(`unknown or malformed capability "${String(c)}"`);
    if (new Set(m.capabilities).size !== m.capabilities.length) p('manifest.capabilities contains duplicates');
  }
  const name = typeof m.name === 'string' ? m.name : '';
  const ns = appNamespace(name);
  const caps = Array.isArray(m.capabilities) ? m.capabilities : [];

  const seenHooks = new Set<string>();
  for (const h of arr(m.hooks, 'hooks', p)) {
    if (!isStr(h?.hook, 200) || !/^[A-Za-z0-9_.:-]+$/.test(h.hook)) p(`hook name "${String(h?.hook)}" is invalid`);
    else {
      if (h.kind !== 'filter' && h.kind !== 'action') p(`hook ${h.hook}: kind must be "filter" or "action"`);
      if (seenHooks.has(h.hook)) p(`hook ${h.hook} declared twice`);
      seenHooks.add(h.hook);
      const need = hookCapability(h.hook, h.kind === 'filter' ? 'filter' : 'action');
      if (need && !hasCapability({ name, capabilities: caps }, need)) p(`hook ${h.hook} requires capability "${need}"`);
    }
    if (h?.id !== undefined && !/^[a-z0-9_-]+$/i.test(String(h.id))) p(`hook ${h?.hook}: invalid id`);
  }
  const seenRoutes = new Set<string>();
  for (const r of arr(m.routes, 'routes', p)) {
    if (!METHODS.includes(r?.method)) p(`route ${r?.path}: invalid method "${r?.method}"`);
    if (!isStr(r?.path, 200) || !/^\/[A-Za-z0-9_\-/:.]*$/.test(r.path)) p(`route path "${String(r?.path)}" is invalid`);
    if (r?.surface !== 'api' && r?.surface !== 'site') p(`route ${r?.path}: surface must be "api" or "site"`);
    if (r?.surface === 'site' && typeof r.path === 'string' && !(r.path === `/${name}` || r.path.startsWith(`/${name}/`)))
      p(`site route ${r.path} must live under /${name}/`);
    if (r?.permission !== undefined && !isStr(r.permission, 100)) p(`route ${r?.path}: invalid permission`);
    const k = `${r?.surface} ${r?.method} ${r?.path}`;
    if (seenRoutes.has(k)) p(`route ${k} declared twice`);
    seenRoutes.add(k);
  }
  for (const e of arr(m.events, 'events', p)) if (!isStr(e?.event, 200) || !/^[a-z0-9_.:*-]+$/i.test(e.event)) p(`event "${String(e?.event)}" is invalid`);
  for (const b of arr(m.blocks, 'blocks', p)) {
    if (!isStr(b?.type, 100) || !b.type.startsWith(`${name}:`) || !/^[a-z0-9-]+:[a-z0-9-]+$/.test(b.type)) p(`block type "${String(b?.type)}" must be "${name}:<name>"`);
    if (!isStr(b?.label, 100)) p(`block ${b?.type}: label is required`);
    checkFields(b?.fields ?? {}, `block ${b?.type}`, p);
  }
  if (m.settings !== undefined) checkFields(m.settings, 'settings', p);
  const models: ModelDef[] = [];
  for (const md of arr(m.models, 'models', p)) {
    if (!isStr(md?.name, 100) || !md.name.startsWith(`${ns}.`) || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(md.name)) {
      p(`model "${String(md?.name)}" must be named "${ns}.<name>"`);
      continue;
    }
    if (!md.fields || typeof md.fields !== 'object') p(`model ${md.name}: fields required`);
    else
      for (const [fname, fld] of Object.entries(md.fields)) {
        if (!/^[a-z_][a-z0-9_]*$/.test(fname)) p(`model ${md.name}: invalid field name ${fname}`);
        if (!fld || !MODEL_FIELD_KINDS.includes((fld as any).kind)) p(`model ${md.name}.${fname}: unknown kind`);
      }
    const access = md.access && typeof md.access === 'object' ? Object.fromEntries(Object.entries(md.access).filter(([k, v]) => ['read', 'create', 'update', 'delete'].includes(k) && typeof v === 'string')) : undefined;
    // Only data is kept: no computed fields (functions) from untrusted packages.
    models.push({ name: md.name, label: md.label, titleField: md.titleField, fields: md.fields, indexes: md.indexes, access, order: md.order });
  }
  if (problems.length) throw new ValidationError(`Invalid app package${name ? ` ${name}` : ''}: ${problems.join('; ')}`, problems);
  return { manifest: { ...m, capabilities: [...caps], models }, code: pkg.code };
}

function arr(v: any, label: string, p: (m: string) => void): any[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    p(`manifest.${label} must be an array`);
    return [];
  }
  return v;
}

function checkFields(fields: unknown, where: string, p: (m: string) => void) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return p(`${where}: fields must be an object`);
  for (const [k, f] of Object.entries(fields as Record<string, any>)) {
    if (!f || !FIELD_KINDS.includes(f.kind)) p(`${where}.${k}: unknown field kind "${f?.kind}"`);
    else if (f.kind === 'select' && (!Array.isArray(f.options) || !f.options.length)) p(`${where}.${k}: select needs options`);
    else if (f.kind === 'list') checkFields(f.of, `${where}.${k}`, p);
  }
}
