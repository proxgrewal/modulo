import { defaultsFor, type Field, type FieldMap, type StyleProps, type TokenGroup } from '@modulo/core';
import type { ModelFieldDef, ModelInfo } from '../types.ts';

/** The inspector control used for a block field. */
export type ControlKind =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'number'
  | 'slider'
  | 'switch'
  | 'select'
  | 'segmented'
  | 'swatches'
  | 'token-select'
  | 'image'
  | 'link'
  | 'color'
  | 'list'
  | 'collection';

export interface FieldSpec {
  key: string;
  label: string;
  control: ControlKind;
  field: Field;
}

export function humanize(key: string): string {
  const s = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function controlFor(field: Field): ControlKind {
  switch (field.kind) {
    case 'text':
      return 'text';
    case 'textarea':
      return 'textarea';
    case 'richtext':
      return 'richtext';
    case 'number':
      return field.min !== undefined && field.max !== undefined && field.max - field.min <= 24 ? 'slider' : 'number';
    case 'boolean':
      return 'switch';
    case 'select':
      // Few short options read better as a segmented control.
      return field.options.length <= 4 && field.options.every((o) => o.label.length <= 8) ? 'segmented' : 'select';
    case 'token':
      return field.group === 'color' ? 'swatches' : 'token-select';
    case 'image':
      return 'image';
    case 'link':
      return 'link';
    case 'color':
      return 'color';
    case 'list':
      return 'list';
    case 'collection':
      return 'collection';
  }
}

/** Visible fields of a schema in declaration order, with labels and controls. */
export function fieldSpecs(fields: FieldMap | undefined): FieldSpec[] {
  return Object.entries(fields ?? {})
    .filter(([, f]) => !f.hidden)
    .map(([key, field]) => ({ key, field, label: field.label ?? humanize(key), control: controlFor(field) }));
}

/** Value for a field: stored prop, else the field default. */
export function fieldValue(field: Field, props: Record<string, unknown>, key: string): unknown {
  return props[key] !== undefined ? props[key] : field.default;
}

/** Clamp/parse a number input according to the field's min/max. */
export function coerceNumber(raw: string, field: { min?: number; max?: number }): number | undefined {
  if (raw.trim() === '') return undefined;
  let n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (field.min !== undefined) n = Math.max(field.min, n);
  if (field.max !== undefined) n = Math.min(field.max, n);
  return n;
}

/** New list item with the sub-fields' defaults. */
export function newListItem(of: FieldMap): Record<string, unknown> {
  return defaultsFor(of);
}

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length || from === to) return arr.slice();
  const out = arr.slice();
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it!);
  return out;
}

/** Label for a list item: the itemLabel sub-field, else the first text sub-field, else "Item n". */
export function listItemLabel(item: Record<string, unknown>, of: FieldMap, itemLabel: string | undefined, index: number): string {
  const key = itemLabel ?? Object.entries(of).find(([, f]) => f.kind === 'text')?.[0];
  const v = key ? item[key] : undefined;
  return typeof v === 'string' && v.trim() ? v.slice(0, 48) : `Item ${index + 1}`;
}

/* ───────── style props ───────── */

export interface StyleSpec {
  key: keyof StyleProps;
  label: string;
  group?: TokenGroup;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export const STYLE_SPECS: { section: string; items: StyleSpec[] }[] = [
  {
    section: 'Spacing',
    items: [
      { key: 'padding', label: 'Padding', group: 'space' },
      { key: 'paddingX', label: 'Padding X', group: 'space' },
      { key: 'paddingY', label: 'Padding Y', group: 'space' },
      { key: 'margin', label: 'Margin', group: 'space' },
      { key: 'gap', label: 'Gap', group: 'space' },
    ],
  },
  {
    section: 'Appearance',
    items: [
      { key: 'background', label: 'Background', group: 'color' },
      { key: 'color', label: 'Text color', group: 'color' },
      { key: 'radius', label: 'Corner radius', group: 'radius' },
      { key: 'shadow', label: 'Shadow', group: 'shadow' },
    ],
  },
  {
    section: 'Typography & layout',
    items: [
      { key: 'fontSize', label: 'Font size', group: 'fontSize' },
      {
        key: 'align',
        label: 'Text align',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
        ],
      },
      { key: 'maxWidth', label: 'Max width', placeholder: 'e.g. 720px' },
    ],
  },
];

/* ───────── model (data) fields ───────── */

export type ModelControl =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'int'
  | 'float'
  | 'money'
  | 'switch'
  | 'date'
  | 'datetime'
  | 'select'
  | 'json'
  | 'ref'
  | 'media'
  | 'slug'
  | 'email'
  | 'url';

export function modelControlFor(f: Pick<ModelFieldDef, 'kind'>): ModelControl {
  switch (f.kind) {
    case 'string':
      return 'text';
    case 'text':
      return 'textarea';
    case 'boolean':
      return 'switch';
    case 'enum':
      return 'select';
    case 'richtext':
    case 'int':
    case 'float':
    case 'money':
    case 'date':
    case 'datetime':
    case 'json':
    case 'ref':
    case 'media':
    case 'slug':
    case 'email':
    case 'url':
      return f.kind;
    default:
      return 'text';
  }
}

/** Editable fields of a model (computed and system columns are read-only). */
export function editableModelFields(model: ModelInfo): ModelFieldDef[] {
  return Object.entries(model.fields).map(([name, f]) => ({ ...f, name: f.name ?? name }));
}

/** Convert a form value (strings from inputs) to the API value for a model field. */
export function coerceModelValue(f: Pick<ModelFieldDef, 'kind' | 'required'>, raw: unknown): unknown {
  const empty = raw === '' || raw === undefined || raw === null;
  switch (f.kind) {
    case 'boolean':
      return !!raw;
    case 'int':
      return empty ? null : Math.trunc(Number(raw));
    case 'float':
    case 'money':
      return empty ? null : Number(raw);
    case 'json':
      if (typeof raw !== 'string') return raw ?? null;
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    case 'datetime':
      return empty ? null : new Date(String(raw)).toISOString();
    case 'slug':
      return empty ? undefined : raw;
    default:
      return empty ? (f.required ? '' : null) : raw;
  }
}

/** Format an API value for an input. */
export function formatModelValue(f: Pick<ModelFieldDef, 'kind'>, v: unknown): string | boolean {
  if (f.kind === 'boolean') return !!v;
  if (v === null || v === undefined) return '';
  if (f.kind === 'json') return JSON.stringify(v, null, 2);
  if (f.kind === 'datetime') {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (f.kind === 'date') return String(v).slice(0, 10);
  return String(v);
}

/** Short cell text for the data table. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return s.replace(/<[^>]*>/g, ' ').slice(0, 80);
}
