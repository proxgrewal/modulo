import { z } from 'zod';

/**
 * Declarative model definitions (Odoo's models, minus the class MRO). The
 * kernel compiles these to real PostgreSQL tables; modules extend another
 * module's model with additive `extendModel` contributions.
 */
export type ModelFieldKind =
  | 'string'
  | 'text'
  | 'richtext'
  | 'int'
  | 'float'
  | 'money'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'json'
  | 'ref'
  | 'media'
  | 'slug'
  | 'email'
  | 'url';

export interface ModelField {
  kind: ModelFieldKind;
  label?: string;
  help?: string;
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  default?: unknown;
  /** string: max length */
  max?: number;
  /** enum: allowed values */
  options?: string[];
  /** ref: target model name ("shop.product"). */
  model?: string;
  onDelete?: 'cascade' | 'set null' | 'restrict';
  /** slug: field to derive from when empty. */
  from?: string;
  /** Not exposed through public (anonymous) APIs. */
  private?: boolean;
}

export interface ComputedField {
  kind: ModelFieldKind;
  label?: string;
  /** Fields this value depends on; recomputed on write when any changes. */
  depends: string[];
  compute: (record: Record<string, any>) => unknown;
  /** Stored computed fields get a real column (filterable/sortable). */
  stored?: boolean;
}

export interface ModelAccess {
  /** Permission needed to read; "public" = anonymous, "auth" = any signed-in user. */
  read?: string;
  create?: string;
  update?: string;
  delete?: string;
}

export interface ModelDef {
  /** "<module>.<name>", e.g. "shop.product". */
  name: string;
  label?: string;
  titleField?: string;
  fields: Record<string, ModelField>;
  computed?: Record<string, ComputedField>;
  indexes?: { fields: string[]; unique?: boolean }[];
  access?: ModelAccess;
  /** Default ordering, e.g. "created_at desc". */
  order?: string;
}

export interface ModelExtension {
  /** Model being extended. */
  model: string;
  fields?: Record<string, ModelField>;
  computed?: Record<string, ComputedField>;
  indexes?: { fields: string[]; unique?: boolean }[];
}

export function defineModel(def: ModelDef): ModelDef {
  return def;
}
export function extendModel(ext: ModelExtension): ModelExtension {
  return ext;
}

export const mf = {
  string: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'string', max: 255, ...o }),
  text: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'text', ...o }),
  richtext: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'richtext', ...o }),
  int: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'int', ...o }),
  float: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'float', ...o }),
  money: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'money', ...o }),
  boolean: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'boolean', default: false, ...o }),
  date: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'date', ...o }),
  datetime: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'datetime', ...o }),
  enum: (options: string[], o: Partial<ModelField> = {}): ModelField => ({ kind: 'enum', options, ...o }),
  json: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'json', ...o }),
  ref: (model: string, o: Partial<ModelField> = {}): ModelField => ({ kind: 'ref', model, onDelete: 'set null', ...o }),
  media: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'media', ...o }),
  slug: (from: string, o: Partial<ModelField> = {}): ModelField => ({ kind: 'slug', from, unique: true, ...o }),
  email: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'email', ...o }),
  url: (o: Partial<ModelField> = {}): ModelField => ({ kind: 'url', ...o }),
};

export const MODEL_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const RESERVED_FIELDS = new Set(['id', 'site_id', 'created_at', 'updated_at', 'created_by', 'key', 'module_key', 'user_modified']);

export function tableName(model: string): string {
  return 'm_' + model.replace('.', '__');
}

export function fieldValidator(f: ModelField): z.ZodType {
  let s: z.ZodType;
  switch (f.kind) {
    case 'string':
    case 'slug':
      s = z.string().max(f.max ?? 255);
      break;
    case 'text':
    case 'richtext':
    case 'media':
      s = z.string();
      break;
    case 'email':
      s = z.email();
      break;
    case 'url':
      s = z.string().regex(/^(https?:\/\/|\/)/, 'must be an http(s) or relative URL');
      break;
    case 'int':
      s = z.number().int();
      break;
    case 'float':
      s = z.number();
      break;
    case 'money':
      // Stored as numeric(14,2); accept numbers or numeric strings.
      s = z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/)]).transform((v) => Number(v));
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'date':
      s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      break;
    case 'datetime':
      s = z.union([z.string(), z.date()]).transform((v) => new Date(v).toISOString());
      break;
    case 'enum':
      s = z.enum((f.options ?? []) as [string, ...string[]]);
      break;
    case 'json':
      s = z.any();
      break;
    case 'ref':
      s = z.string().uuid();
      break;
  }
  return f.required ? s : s.nullable().optional();
}

/** Validator for create (required enforced) or update (all optional). */
export function recordValidator(fields: Record<string, ModelField>, mode: 'create' | 'update') {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, f] of Object.entries(fields)) {
    let v = fieldValidator(f);
    if (mode === 'update' || f.default !== undefined || f.kind === 'slug') v = v.optional();
    shape[k] = v;
  }
  return z.strictObject(shape);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
