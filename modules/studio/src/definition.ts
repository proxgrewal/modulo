import { z } from 'zod';
import {
  FIELD_NAME_RE,
  MODEL_NAME_RE,
  RESERVED_FIELDS,
  fieldValidator,
  mf,
  tableName,
  type ModelDef,
  type ModelExtension,
  type ModelField,
  type ModelFieldKind,
  type PageNode,
} from '@modulo/core';
import type { ModuleDefinition, PatchDef } from '@modulo/kernel';

/**
 * Local (site-defined) modules are pure data: a definition validated here and
 * compiled into a real ModuleDefinition. Only declarative pieces are allowed
 * (no computed functions, hooks, routes or lifecycle code).
 */

export const LOCAL_NAME_RE = /^[a-z][a-z0-9_]{1,30}$/;
const SHORT_RE = /^[a-z][a-z0-9_]*$/;
const PERM_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_.*-]+$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const TEMPLATE_RE = /^[a-z][a-z0-9_-]*:[a-z0-9_.-]+$/;

export const FIELD_KINDS = [
  'string',
  'text',
  'richtext',
  'int',
  'float',
  'money',
  'boolean',
  'date',
  'datetime',
  'enum',
  'json',
  'ref',
  'media',
  'slug',
  'email',
  'url',
] as const satisfies readonly ModelFieldKind[];

const STRINGISH = new Set<string>(['string', 'slug', 'email', 'url']);

/** Metadata for the editor's field-kind picker (GET /field-kinds). */
export const FIELD_KIND_INFO: { kind: ModelFieldKind; label: string; description: string; props: string[] }[] = [
  { kind: 'string', label: 'Short text', description: 'Single line of text', props: ['max'] },
  { kind: 'text', label: 'Long text', description: 'Multi-line plain text', props: [] },
  { kind: 'richtext', label: 'Rich text', description: 'Formatted HTML content', props: [] },
  { kind: 'int', label: 'Whole number', description: 'Integer', props: [] },
  { kind: 'float', label: 'Decimal number', description: 'Floating point number', props: [] },
  { kind: 'money', label: 'Money', description: 'Amount with two decimals', props: [] },
  { kind: 'boolean', label: 'Yes / No', description: 'Checkbox', props: [] },
  { kind: 'date', label: 'Date', description: 'Calendar date (YYYY-MM-DD)', props: [] },
  { kind: 'datetime', label: 'Date & time', description: 'Timestamp', props: [] },
  { kind: 'enum', label: 'Choice', description: 'One of a fixed list of options', props: ['options'] },
  { kind: 'json', label: 'JSON', description: 'Structured data', props: [] },
  { kind: 'ref', label: 'Link to record', description: 'Reference to a record of another model', props: ['model', 'onDelete'] },
  { kind: 'media', label: 'Media', description: 'Image or file from the media library', props: [] },
  { kind: 'slug', label: 'Slug', description: 'URL-friendly identifier derived from another field', props: ['from', 'max'] },
  { kind: 'email', label: 'Email', description: 'Email address', props: ['max'] },
  { kind: 'url', label: 'URL', description: 'Web address', props: ['max'] },
];
export const COMMON_FIELD_PROPS = ['label', 'help', 'required', 'unique', 'index', 'default', 'private'];

/* ───────────────────────── zod schema (syntax) ───────────────────────── */

export const fieldSchema = z
  .strictObject({
    kind: z.enum(FIELD_KINDS),
    label: z.string().max(120).optional(),
    help: z.string().max(500).optional(),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    index: z.boolean().optional(),
    default: z.unknown().optional(),
    max: z.number().int().min(1).max(10_000).optional(),
    options: z.array(z.string().min(1).max(100)).optional(),
    model: z.string().optional(),
    onDelete: z.enum(['cascade', 'set null', 'restrict']).optional(),
    from: z.string().optional(),
    private: z.boolean().optional(),
  })
  .superRefine((f, c) => {
    const issue = (message: string, path: string) => c.addIssue({ code: 'custom', message, path: [path] });
    if (f.kind === 'enum') {
      if (!f.options?.length) issue('enum fields need at least one option', 'options');
      else if (new Set(f.options).size !== f.options.length) issue('enum options must be unique', 'options');
    } else if (f.options !== undefined) issue(`"options" only applies to enum fields`, 'options');
    if (f.kind === 'ref') {
      if (!f.model) issue('ref fields need a target model', 'model');
    } else {
      if (f.model !== undefined) issue(`"model" only applies to ref fields`, 'model');
      if (f.onDelete !== undefined) issue(`"onDelete" only applies to ref fields`, 'onDelete');
    }
    if (f.kind === 'slug') {
      if (!f.from) issue('slug fields need a source field ("from")', 'from');
    } else if (f.from !== undefined) issue(`"from" only applies to slug fields`, 'from');
    if (f.max !== undefined && !STRINGISH.has(f.kind)) issue(`"max" only applies to string, slug, email and url fields`, 'max');
    if (f.kind === 'ref' && f.default !== undefined) issue('ref fields cannot have a default', 'default');
    if (f.default !== undefined && f.default !== null) {
      const res = fieldValidator({ ...f, required: true } as ModelField).safeParse(f.default);
      if (!res.success) issue(`invalid default: ${res.error.issues.map((i) => i.message).join(', ')}`, 'default');
    }
  });

export type LocalField = z.infer<typeof fieldSchema>;

const fieldMapSchema = z.record(z.string(), fieldSchema).superRefine((m, c) => {
  for (const k of Object.keys(m)) {
    if (!FIELD_NAME_RE.test(k)) c.addIssue({ code: 'custom', message: `invalid field name "${k}" (lowercase letters, digits, underscores)`, path: [k] });
    else if (RESERVED_FIELDS.has(k)) c.addIssue({ code: 'custom', message: `"${k}" is a reserved field name`, path: [k] });
  }
});

const accessRule = z.string().refine((s) => s === 'public' || s === 'auth' || PERM_RE.test(s), 'must be "public", "auth" or a permission key');

const indexSchema = z.strictObject({ fields: z.array(z.string()).min(1).max(8), unique: z.boolean().optional() });

const modelSchema = z.strictObject({
  name: z.string().regex(MODEL_NAME_RE, 'model names look like "<module>.<name>"'),
  label: z.string().max(120).optional(),
  titleField: z.string().optional(),
  fields: fieldMapSchema,
  indexes: z.array(indexSchema).optional(),
  access: z
    .strictObject({ read: accessRule.optional(), create: accessRule.optional(), update: accessRule.optional(), delete: accessRule.optional() })
    .optional(),
  order: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*(\s+(asc|desc))?(\s*,\s*[a-z_][a-z0-9_]*(\s+(asc|desc))?)*$/i, 'order looks like "field desc, other asc"')
    .optional(),
});

const extensionSchema = z.strictObject({
  model: z.string().regex(MODEL_NAME_RE),
  fields: fieldMapSchema,
  indexes: z.array(indexSchema).optional(),
});

const styleSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export const pageNodeSchema: z.ZodType<PageNode> = z.lazy(() =>
  z.strictObject({
    id: z.string().regex(NODE_ID_RE),
    type: z.string().regex(/^[a-z][a-z0-9_-]*:[a-z0-9_-]+$/, 'block types look like "<module>:<name>"'),
    v: z.number().int().optional(),
    props: z.record(z.string(), z.unknown()),
    style: styleSchema.optional(),
    responsive: z.record(z.enum(['md', 'sm']), styleSchema).optional(),
    slots: z.record(z.string(), z.array(pageNodeSchema)).optional(),
    bind: z.record(z.string(), z.string()).optional(),
    locked: z.boolean().optional(),
  }),
) as any;

const target = z.string().min(1).max(200);
const patchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.enum(['append', 'prepend', 'insertBefore', 'insertAfter', 'replace']), target, node: pageNodeSchema }),
  z.strictObject({ op: z.literal('remove'), target }),
  z.strictObject({ op: z.literal('setProp'), target, prop: z.string().min(1).max(100), value: z.unknown() }),
  z.strictObject({ op: z.literal('setStyle'), target, style: styleSchema }),
  z.strictObject({ op: z.literal('wrap'), target, node: pageNodeSchema, slot: z.string().optional() }),
]);

const patchSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,80}$/),
  template: z.string().regex(TEMPLATE_RE, 'template ids look like "core:layout"'),
  ops: z.array(patchOpSchema).min(1),
});

export const definitionSchema = z.strictObject({
  models: z.array(modelSchema).default([]),
  extendModels: z.array(extensionSchema).default([]),
  patches: z.array(patchSchema).default([]),
  permissions: z.array(z.strictObject({ key: z.string().regex(PERM_RE), label: z.string().min(1).max(120) })).default([]),
  grants: z.record(z.string().regex(ROLE_RE), z.array(z.string())).default({}),
  editor: z
    .strictObject({
      collections: z
        .array(z.strictObject({ model: z.string(), label: z.string().min(1).max(120), icon: z.string().max(40).optional(), columns: z.array(z.string()).optional() }))
        .default([]),
    })
    .default({ collections: [] }),
});

export type LocalDefinition = z.infer<typeof definitionSchema>;

export function emptyDefinition(): LocalDefinition {
  return { models: [], extendModels: [], patches: [], permissions: [], grants: {}, editor: { collections: [] } };
}

/* ───────────────────────── naming ───────────────────────── */

/** Generated module name: x_<first 8 hex of the site id>_<local name>. */
export function localModuleName(siteId: string, localName: string): string {
  return `x_${siteId.replace(/-/g, '').slice(0, 8).toLowerCase()}_${localName}`;
}

/** Replace a leading "<from>." namespace with "<to>.". */
export function renamePrefix(s: string, from: string, to: string): string {
  return s.startsWith(from + '.') ? to + s.slice(from.length) : s;
}

/* ───────────────────────── semantic validation ───────────────────────── */

export interface SiteModelInfo {
  module: string;
  fields: Record<string, { kind: string; module: string }>;
}

export interface ValidationEnv {
  localName: string;
  /** Generated module name (x_<id8>_<name>). */
  moduleName: string;
  /** Models available on the site (exact names), including other local modules' generated names. */
  siteModels: Map<string, SiteModelInfo>;
  /** Friendly name -> generated module name of the site's other local modules. */
  otherLocals?: Map<string, string>;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
  definition?: LocalDefinition;
  /** ref/extend targets written with another local module's friendly prefix -> generated model name. */
  refMap: Record<string, string>;
}

export function validateDefinition(input: unknown, env: ValidationEnv): ValidationResult {
  const parsed = definitionSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(definition)'}: ${i.message}`),
      refMap: {},
    };
  }
  const def = parsed.data;
  const problems: string[] = [];
  const refMap: Record<string, string> = {};
  const { localName, moduleName } = env;
  const own = new Map(def.models.map((m) => [m.name, m]));
  const ownPerms = new Set(def.permissions.map((p) => p.key));

  /** Resolve a model reference to its final (generated) name, or null. */
  const resolveModel = (name: string): string | null => {
    if (own.has(name)) return renamePrefix(name, localName, moduleName);
    const site = env.siteModels.get(name);
    if (site && site.module !== moduleName) return name;
    const [prefix, rest] = name.split('.') as [string, string];
    const other = env.otherLocals?.get(prefix);
    if (other && other !== moduleName && env.siteModels.has(`${other}.${rest}`)) return (refMap[name] = `${other}.${rest}`);
    return null;
  };

  const seen = new Set<string>();
  def.models.forEach((m, i) => {
    const at = `models.${i} (${m.name})`;
    if (!m.name.startsWith(localName + '.')) problems.push(`${at}: model names must be namespaced "${localName}.<name>"`);
    if (seen.has(m.name)) problems.push(`${at}: duplicate model`);
    seen.add(m.name);
    const short = m.name.split('.')[1] ?? '';
    if (!SHORT_RE.test(short)) problems.push(`${at}: invalid model name`);
    const table = tableName(renamePrefix(m.name, localName, moduleName));
    if (table.length > 63) problems.push(`${at}: name too long (table "${table}" exceeds 63 characters)`);
    if (!Object.keys(m.fields).length) problems.push(`${at}: a model needs at least one field`);
    checkFields(m.fields, at, m.fields);
    if (m.titleField && !m.fields[m.titleField]) problems.push(`${at}: titleField "${m.titleField}" is not a field`);
    for (const idx of m.indexes ?? []) for (const f of idx.fields) if (!m.fields[f]) problems.push(`${at}: index field "${f}" is not a field`);
    if (m.order) {
      for (const part of m.order.split(',')) {
        const f = part.trim().split(/\s+/)[0]!;
        if (!m.fields[f] && !['id', 'created_at', 'updated_at'].includes(f)) problems.push(`${at}: order field "${f}" is not a field`);
      }
    }
    for (const [op, rule] of Object.entries(m.access ?? {})) checkPermRef(rule!, `${at}: access.${op}`);
  });

  def.extendModels.forEach((e, i) => {
    const at = `extendModels.${i} (${e.model})`;
    if (own.has(e.model)) {
      problems.push(`${at}: add fields to your own model directly instead of extending it`);
      return;
    }
    const resolved = resolveModel(e.model);
    if (!resolved) {
      problems.push(`${at}: model ${e.model} is not installed on this site`);
      return;
    }
    const existing = env.siteModels.get(resolved)!;
    for (const fname of Object.keys(e.fields)) {
      const cur = existing.fields[fname];
      if (cur && cur.module !== moduleName) problems.push(`${at}: field "${fname}" already exists on ${e.model} (from ${cur.module})`);
    }
    if (!Object.keys(e.fields).length) problems.push(`${at}: an extension needs at least one field`);
    checkFields(e.fields, at, { ...existing.fields, ...e.fields });
    for (const idx of e.indexes ?? []) for (const f of idx.fields) if (!e.fields[f] && !existing.fields[f]) problems.push(`${at}: index field "${f}" is unknown`);
  });

  const extendedTwice = new Set<string>();
  for (const e of def.extendModels) {
    if (extendedTwice.has(e.model)) problems.push(`extendModels: ${e.model} is extended twice; merge the fields into one extension`);
    extendedTwice.add(e.model);
  }

  def.permissions.forEach((p, i) => {
    if (!p.key.startsWith(localName + '.')) problems.push(`permissions.${i}: key "${p.key}" must start with "${localName}."`);
  });
  if (ownPerms.size !== def.permissions.length) problems.push('permissions: duplicate keys');
  for (const [role, perms] of Object.entries(def.grants)) {
    for (const p of perms) if (!ownPerms.has(p)) problems.push(`grants.${role}: "${p}" is not a permission declared by this module`);
  }
  def.editor.collections.forEach((c, i) => {
    const m = own.get(c.model);
    if (!m) problems.push(`editor.collections.${i}: ${c.model} is not one of this module's models`);
    else for (const col of c.columns ?? []) if (!m.fields[col]) problems.push(`editor.collections.${i}: column "${col}" is not a field`);
  });
  const patchIds = new Set<string>();
  def.patches.forEach((p, i) => {
    if (patchIds.has(p.id)) problems.push(`patches.${i}: duplicate patch id "${p.id}"`);
    patchIds.add(p.id);
  });

  return { ok: problems.length === 0, problems, definition: def, refMap };

  function checkFields(fields: Record<string, LocalField>, at: string, siblings: Record<string, unknown>) {
    for (const [fname, f] of Object.entries(fields)) {
      if (f.kind === 'ref' && f.model && !resolveModel(f.model)) {
        problems.push(`${at}.${fname}: ref target ${f.model} does not exist (define it in this module or install the module that provides it)`);
      }
      if (f.kind === 'slug' && f.from && !siblings[f.from]) problems.push(`${at}.${fname}: slug source "${f.from}" is not a field`);
    }
  }
  function checkPermRef(rule: string, at: string) {
    if (rule === 'public' || rule === 'auth') return;
    if (rule.startsWith(localName + '.') && !ownPerms.has(rule) && !rule.endsWith('.manage')) {
      problems.push(`${at}: permission "${rule}" is not declared`);
    }
  }
}

/* ───────────────────────── build ───────────────────────── */

/** Build a field through the same mf.* helpers hand-written modules use (so exports round-trip). */
export function buildField(f: LocalField, mapModel: (n: string) => string): ModelField {
  const { kind, options, model, from, ...rest } = f;
  const o = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<ModelField>;
  switch (kind) {
    case 'enum':
      return mf.enum([...(options ?? [])], o);
    case 'ref':
      return mf.ref(mapModel(model!), o);
    case 'slug':
      return mf.slug(from!, o);
    default:
      return (mf[kind] as (o?: Partial<ModelField>) => ModelField)(o);
  }
}

export interface BuildInput {
  moduleName: string;
  localName: string;
  version: string;
  label: string;
  description?: string;
  definition: LocalDefinition;
  refMap?: Record<string, string>;
  depends?: Record<string, string>;
}

/** Compile a validated local definition into a ModuleDefinition (pure data, JSON-serialisable). */
export function buildModule(input: BuildInput): ModuleDefinition {
  const { moduleName, localName, definition: def } = input;
  const refMap = input.refMap ?? {};
  const mapModel = (n: string) => refMap[n] ?? renamePrefix(n, localName, moduleName);
  const mapPerm = (p: string) => renamePrefix(p, localName, moduleName);
  const fields = (fs: Record<string, LocalField>) => Object.fromEntries(Object.entries(fs).map(([k, f]) => [k, buildField(f, mapModel)]));
  const models: ModelDef[] = def.models.map((m) =>
    clean({
      name: mapModel(m.name),
      label: m.label,
      titleField: m.titleField,
      fields: fields(m.fields),
      indexes: m.indexes?.length ? m.indexes : undefined,
      access: m.access ? (Object.fromEntries(Object.entries(m.access).map(([k, v]) => [k, mapPerm(v!)])) as ModelDef['access']) : undefined,
      order: m.order,
    }),
  );
  const extendModels: ModelExtension[] = def.extendModels.map((e) =>
    clean({ model: mapModel(e.model), fields: fields(e.fields), indexes: e.indexes?.length ? e.indexes : undefined }),
  );
  const out: ModuleDefinition = {
    name: moduleName,
    version: input.version,
    label: input.label,
    description: input.description || undefined,
    kernel: '^1.0.0',
    category: 'local',
    depends: input.depends && Object.keys(input.depends).length ? { ...input.depends } : undefined,
    models: models.length ? models : undefined,
    extendModels: extendModels.length ? extendModels : undefined,
    patches: def.patches.length ? (structuredClone(def.patches) as PatchDef[]) : undefined,
    permissions: def.permissions.length ? def.permissions.map((p) => ({ key: mapPerm(p.key), label: p.label })) : undefined,
    grants: Object.keys(def.grants).length ? Object.fromEntries(Object.entries(def.grants).map(([r, ps]) => [r, ps.map(mapPerm)])) : undefined,
    editor: def.editor.collections.length ? { collections: def.editor.collections.map((c) => clean({ ...c, model: mapModel(c.model) })) } : undefined,
  };
  return clean(out);
}

/** Rename a built module (and its own model/permission namespace) to `to`. */
export function renameModule(def: ModuleDefinition, to: string): ModuleDefinition {
  const from = def.name.replace(/-/g, '_');
  const ns = to.replace(/-/g, '_');
  const r = (s: string) => renamePrefix(s, from, ns);
  const copy = structuredClone(def);
  copy.name = to;
  for (const m of copy.models ?? []) {
    m.name = r(m.name);
    for (const f of Object.values(m.fields)) if (f.model) f.model = r(f.model);
    if (m.access) for (const k of Object.keys(m.access) as (keyof NonNullable<ModelDef['access']>)[]) m.access[k] = r(m.access[k]!);
  }
  for (const e of copy.extendModels ?? []) {
    e.model = r(e.model);
    for (const f of Object.values(e.fields ?? {})) if (f.model) f.model = r(f.model);
  }
  for (const p of copy.permissions ?? []) p.key = r(p.key);
  if (copy.grants) for (const role of Object.keys(copy.grants)) copy.grants[role] = copy.grants[role]!.map(r);
  for (const c of copy.editor?.collections ?? []) c.model = r(c.model);
  return copy;
}

/** Columns (table.column) and tables present in `prev` but gone from `next` — the kernel never drops them. */
export function retainedSchema(prev: ModuleDefinition | null, next: ModuleDefinition) {
  const retainedColumns: string[] = [];
  const retainedTables: string[] = [];
  if (!prev) return { retainedColumns, retainedTables };
  const nextModels = new Map((next.models ?? []).map((m) => [m.name, m]));
  for (const m of prev.models ?? []) {
    const nm = nextModels.get(m.name);
    if (!nm) {
      retainedTables.push(tableName(m.name));
      continue;
    }
    for (const f of Object.keys(m.fields)) if (!nm.fields[f]) retainedColumns.push(`${tableName(m.name)}.${f}`);
  }
  const nextExt = new Map((next.extendModels ?? []).map((e) => [e.model, e]));
  for (const e of prev.extendModels ?? []) {
    for (const f of Object.keys(e.fields ?? {})) if (!nextExt.get(e.model)?.fields?.[f]) retainedColumns.push(`${tableName(e.model)}.${f}`);
  }
  return { retainedColumns, retainedTables };
}

const SQL_FAMILY: Record<string, string> = {
  string: 'varchar',
  slug: 'varchar',
  email: 'varchar',
  url: 'varchar',
  text: 'text',
  richtext: 'text',
  media: 'text',
  enum: 'text',
  int: 'integer',
  float: 'double',
  money: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  json: 'jsonb',
  ref: 'uuid',
};

/** Field type changes between published versions that the schema sync cannot apply. */
export function incompatibleChanges(prev: ModuleDefinition | null, next: ModuleDefinition): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const collect = (d: ModuleDefinition) => {
    const m = new Map<string, ModelField>();
    for (const md of d.models ?? []) for (const [k, f] of Object.entries(md.fields)) m.set(`${md.name}.${k}`, f);
    for (const e of d.extendModels ?? []) for (const [k, f] of Object.entries(e.fields ?? {})) m.set(`${e.model}.${k}`, f);
    return m;
  };
  const before = collect(prev);
  for (const [k, f] of collect(next)) {
    const p = before.get(k);
    if (!p) continue;
    if (SQL_FAMILY[p.kind] !== SQL_FAMILY[f.kind]) out.push(`${k}: changing the field type from ${p.kind} to ${f.kind} is not supported — add a new field instead`);
    else if (p.kind === 'ref' && p.model !== f.model) out.push(`${k}: changing a reference target (${p.model} → ${f.model}) is not supported`);
    else if (STRINGISH.has(f.kind) && (f.max ?? 255) < (p.max ?? 255)) out.push(`${k}: max length can only grow (${p.max ?? 255} → ${f.max ?? 255})`);
  }
  return out;
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/* ───────────────────────── storage (jsonb does not keep key order) ───────────────────────── */

type WithFields = { models?: { fields?: unknown }[]; extendModels?: { fields?: unknown }[] };

/** Store field maps as ordered arrays ([{ name, ...field }]) so jsonb keeps the author's field order. */
export function packOrder<T>(def: T): T {
  const copy = structuredClone(def) as WithFields;
  for (const m of [...(copy.models ?? []), ...(copy.extendModels ?? [])]) {
    if (m.fields && !Array.isArray(m.fields)) m.fields = Object.entries(m.fields as Record<string, object>).map(([name, f]) => ({ name, ...f }));
  }
  return copy as T;
}

/** Inverse of packOrder (maps that are already records are left alone). */
export function unpackOrder<T>(def: T): T {
  if (!def || typeof def !== 'object') return def;
  const copy = structuredClone(def) as WithFields;
  for (const m of [...(copy.models ?? []), ...(copy.extendModels ?? [])]) {
    if (Array.isArray(m.fields)) m.fields = Object.fromEntries((m.fields as { name: string }[]).map(({ name, ...f }) => [name, f]));
  }
  return copy as T;
}
