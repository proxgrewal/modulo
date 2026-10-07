import { defaultsFor, fieldToZod, matchType, nodeId, type BlockRegistry, type Field, type FieldMap, type PageNode, type RegisteredBlock } from '@modulo/core';

/** What the model is told about each insertable block. */
export interface CatalogField {
  kind: Field['kind'];
  label?: string;
  options?: string[];
  default?: unknown;
  /** list fields: item shape */
  of?: Record<string, CatalogField>;
}
export interface CatalogBlock {
  type: string;
  label: string;
  description?: string;
  category?: string;
  fields: Record<string, CatalogField>;
  /** Slot names; blocks without slots cannot have children. */
  slots: string[];
}

function describeFields(fields: FieldMap): Record<string, CatalogField> {
  const out: Record<string, CatalogField> = {};
  for (const [k, fld] of Object.entries(fields)) {
    if (fld.hidden) continue;
    const c: CatalogField = { kind: fld.kind };
    if (fld.label) c.label = fld.label;
    if (fld.kind === 'select') c.options = fld.options.map((o) => o.value);
    if (fld.kind === 'list') c.of = describeFields(fld.of);
    else if (fld.default !== undefined && fld.default !== '') c.default = fld.default;
    out[k] = c;
  }
  return out;
}

/** Insertable (non-internal) blocks of the site runtime, described for the model. */
export function buildCatalog(registry: BlockRegistry): CatalogBlock[] {
  return registry
    .list()
    .filter((b) => !b.internal && b.type !== 'core:page')
    .map((b) => ({
      type: b.type,
      label: b.label,
      ...(b.description ? { description: b.description } : {}),
      ...(b.category ? { category: b.category } : {}),
      fields: describeFields(b.fields),
      slots: (b.slots ?? []).map((s) => s.name),
    }));
}

export interface NormalizeOptions {
  mode?: 'page' | 'section';
  maxDepth?: number;
  maxNodes?: number;
  maxListItems?: number;
}

const INVALID = Symbol('invalid');

/** Strip active content from model-written rich text (core escapes everything else). */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|svg|math|template|noscript|link|meta|base|form)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|svg|math|template|noscript|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action|formaction|xlink:href)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'\s>]*\2?/gi, '');
}

const unsafeUrl = (s: string) => /^\s*(javascript|vbscript|data):/i.test(s) && !/^\s*data:image\/(png|jpe?g|gif|webp);/i.test(s);

function cleanField(field: Field, v: unknown, maxListItems: number): unknown {
  let out: unknown = v;
  switch (field.kind) {
    case 'number':
      if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) out = Number(v);
      if (typeof out === 'number') {
        if (field.min !== undefined) out = Math.max(field.min, out as number);
        if (field.max !== undefined) out = Math.min(field.max, out as number);
      }
      break;
    case 'boolean':
      if (v === 'true' || v === 'false') out = v === 'true';
      break;
    case 'select': {
      if (typeof v !== 'string') return INVALID;
      const hit = field.options.find((o) => o.value === v) ?? field.options.find((o) => o.value.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase());
      if (!hit) return INVALID;
      out = hit.value;
      break;
    }
    case 'text':
    case 'textarea':
      if (typeof v === 'number') out = String(v);
      if (typeof out === 'string' && field.kind === 'text' && field.maxLength) out = (out as string).slice(0, field.maxLength);
      break;
    case 'richtext':
      if (typeof v === 'string') out = sanitizeHtml(v);
      break;
    case 'link':
    case 'image':
      if (typeof v === 'string' && unsafeUrl(v)) return INVALID;
      break;
    case 'list': {
      if (!Array.isArray(v)) return INVALID;
      out = v
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, maxListItems)
        .map((item) => {
          const row = defaultsFor(field.of);
          for (const [k, sub] of Object.entries(field.of)) {
            if (!(k in item)) continue;
            const c = cleanField(sub, (item as any)[k], maxListItems);
            if (c !== INVALID) row[k] = c;
          }
          return row;
        });
      break;
    }
  }
  return fieldToZod(field).safeParse(out).success ? out : INVALID;
}

function parseProps(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** Pull the list of top-level nodes out of whatever shape the model returned. */
function topLevel(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  if (o.tree) return topLevel(o.tree);
  if (o.type === 'core:page') return o.slots?.default ?? o.children ?? [];
  if (Array.isArray(o.sections)) return o.sections;
  if (Array.isArray(o.blocks)) return o.blocks;
  if (Array.isArray(o.children)) return o.children;
  if (typeof o.type === 'string') return [o];
  return null;
}

/**
 * Turn model output into a valid page tree for this runtime: unknown block
 * types are dropped (their children hoisted), invalid props fall back to
 * defaults, ids are fresh, depth/size are capped, and the result is checked
 * with registry.validateTree().
 */
export function normalizeLayout(raw: unknown, registry: BlockRegistry, opts: NormalizeOptions = {}): { tree: PageNode; warnings: string[]; title?: string } {
  const warnings: string[] = [];
  const maxDepth = opts.maxDepth ?? 6;
  const maxNodes = opts.maxNodes ?? 150;
  const maxListItems = opts.maxListItems ?? 12;
  let count = 0;
  let truncated = false;
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  const convertList = (items: unknown[], depth: number, parent: RegisteredBlock | null, slotName: string): PageNode[] => {
    const out: PageNode[] = [];
    for (const item of items) out.push(...convert(item, depth, parent, slotName));
    return out;
  };

  const convert = (n: unknown, depth: number, parent: RegisteredBlock | null, slotName: string): PageNode[] => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return [];
    const o = n as Record<string, any>;
    const kids: unknown[] = Array.isArray(o.children) ? o.children : [];
    const slotMap: Record<string, unknown[]> = o.slots && typeof o.slots === 'object' && !Array.isArray(o.slots) ? o.slots : {};
    const def = typeof o.type === 'string' ? registry.get(o.type) : undefined;
    if (!def || def.internal || def.type === 'core:page') {
      const allKids = [...kids, ...Object.values(slotMap).flat()];
      warn(`Dropped unknown block type "${String(o.type)}"${allKids.length ? ` (kept ${allKids.length} child block${allKids.length === 1 ? '' : 's'})` : ''}`);
      return convertList(allKids, depth, parent, slotName);
    }
    if (parent) {
      const spec = parent.slots?.find((s) => s.name === slotName);
      if (spec?.allow?.length && !spec.allow.some((a) => matchType(a, def.type))) {
        warn(`Dropped ${def.type}: not allowed inside ${parent.type}`);
        return [];
      }
    }
    if (depth > maxDepth || count >= maxNodes) {
      truncated = true;
      return [];
    }
    count++;
    const props = defaultsFor(def.fields);
    const given = parseProps(o.props);
    if (given === null) warn(`${def.type}: props were not a JSON object; used defaults`);
    for (const [k, v] of Object.entries(given ?? {})) {
      const field = def.fields[k];
      if (!field) {
        warn(`${def.type}: ignored unknown prop "${k}"`);
        continue;
      }
      const c = cleanField(field, v, maxListItems);
      if (c === INVALID) warn(`${def.type}: invalid value for "${k}"; used the default`);
      else props[k] = c;
    }
    const node: PageNode = { id: nodeId('ai'), type: def.type, v: def.version, props, origin: 'ai' };
    if (def.slots?.length) {
      node.slots = {};
      for (const s of def.slots) node.slots[s.name] = [];
      const first = def.slots[0]!.name;
      node.slots[first] = convertList(kids, depth + 1, def, first);
      for (const [name, list] of Object.entries(slotMap)) {
        if (!Array.isArray(list)) continue;
        if (!node.slots[name]) {
          warn(`${def.type} has no slot "${name}"; its blocks were dropped`);
          continue;
        }
        node.slots[name]!.push(...convertList(list, depth + 1, def, name));
      }
    } else if (kids.length || Object.keys(slotMap).length) {
      warn(`${def.type} cannot contain other blocks; its children were dropped`);
    }
    return [node];
  };

  const top = topLevel(raw);
  if (!top) warn('Model output did not contain a layout');
  let nodes = convertList(top ?? [], 1, null, 'default');
  if (truncated) warn(`Layout was truncated (max depth ${maxDepth}, max ${maxNodes} blocks)`);
  if (opts.mode === 'section' && nodes.length > 1) {
    warn(`Section mode: kept the first of ${nodes.length} top-level blocks`);
    nodes = nodes.slice(0, 1);
  }
  const tree: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: nodes } };
  for (const p of registry.validateTree(tree)) warn(`Validation: ${p}`);
  const title = raw && typeof raw === 'object' && typeof (raw as any).title === 'string' ? String((raw as any).title).slice(0, 120) : undefined;
  return { tree, warnings, title };
}
