import { z } from 'zod';

/**
 * Field DSL for block props and module settings. One declaration yields the
 * runtime validator (zod), the default value, and the metadata the editor's
 * inspector uses to auto-generate a form.
 */
export type TokenGroup = 'color' | 'space' | 'radius' | 'font' | 'fontSize' | 'shadow';

interface Base<K extends string, T> {
  kind: K;
  label?: string;
  help?: string;
  default?: T;
  /** Hide from the inspector (still validated). */
  hidden?: boolean;
}
export type TextField = Base<'text', string> & { placeholder?: string; maxLength?: number };
export type TextareaField = Base<'textarea', string> & { rows?: number };
export type RichTextField = Base<'richtext', string>;
export type NumberField = Base<'number', number> & { min?: number; max?: number; step?: number };
export type BooleanField = Base<'boolean', boolean>;
export type SelectField = Base<'select', string> & { options: { value: string; label: string }[] };
export type TokenField = Base<'token', string> & { group: TokenGroup };
export type ImageField = Base<'image', string>;
export type LinkField = Base<'link', string>;
export type ColorField = Base<'color', string>;
export type ListField = Base<'list', Record<string, unknown>[]> & { of: Record<string, Field>; itemLabel?: string };
export type CollectionField = Base<'collection', string> & { model?: string };

export type Field =
  | TextField
  | TextareaField
  | RichTextField
  | NumberField
  | BooleanField
  | SelectField
  | TokenField
  | ImageField
  | LinkField
  | ColorField
  | ListField
  | CollectionField;

export type FieldMap = Record<string, Field>;

type Opt<F> = Omit<F, 'kind'>;
export const f = {
  text: (o: Opt<TextField> = {}): TextField => ({ kind: 'text', default: '', ...o }),
  textarea: (o: Opt<TextareaField> = {}): TextareaField => ({ kind: 'textarea', default: '', ...o }),
  richtext: (o: Opt<RichTextField> = {}): RichTextField => ({ kind: 'richtext', default: '', ...o }),
  number: (o: Opt<NumberField> = {}): NumberField => ({ kind: 'number', default: 0, ...o }),
  boolean: (o: Opt<BooleanField> = {}): BooleanField => ({ kind: 'boolean', default: false, ...o }),
  select: (options: (string | { value: string; label: string })[], o: Omit<Opt<SelectField>, 'options'> = {}): SelectField => {
    const opts = options.map((x) => (typeof x === 'string' ? { value: x, label: x } : x));
    return { kind: 'select', options: opts, default: opts[0]?.value, ...o };
  },
  token: (group: TokenGroup, o: Omit<Opt<TokenField>, 'group'> = {}): TokenField => ({ kind: 'token', group, default: '', ...o }),
  image: (o: Opt<ImageField> = {}): ImageField => ({ kind: 'image', default: '', ...o }),
  link: (o: Opt<LinkField> = {}): LinkField => ({ kind: 'link', default: '', ...o }),
  color: (o: Opt<ColorField> = {}): ColorField => ({ kind: 'color', default: '', ...o }),
  list: (of: FieldMap, o: Omit<Opt<ListField>, 'of'> = {}): ListField => ({ kind: 'list', of, default: [], ...o }),
  collection: (o: Opt<CollectionField> = {}): CollectionField => ({ kind: 'collection', default: '', ...o }),
};

export function fieldToZod(field: Field): z.ZodType {
  switch (field.kind) {
    case 'text': {
      let s = z.string();
      if (field.maxLength) s = s.max(field.maxLength);
      return s;
    }
    case 'textarea':
    case 'richtext':
    case 'image':
    case 'link':
    case 'color':
    case 'collection':
    case 'token':
      return z.string();
    case 'number': {
      let n = z.number();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum(field.options.map((o) => o.value) as [string, ...string[]]);
    case 'list':
      return z.array(fieldsToZod(field.of));
  }
}

export function fieldsToZod(fields: FieldMap) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, fld] of Object.entries(fields)) shape[k] = fieldToZod(fld).optional();
  return z.looseObject(shape);
}

export function defaultsFor(fields: FieldMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, fld] of Object.entries(fields)) {
    if (fld.default !== undefined) out[k] = structuredClone(fld.default);
  }
  return out;
}

/** Merge defaults under given props (props win). */
export function withDefaults<T extends Record<string, unknown>>(fields: FieldMap, props: T | undefined): T {
  return { ...defaultsFor(fields), ...(props ?? {}) } as T;
}
