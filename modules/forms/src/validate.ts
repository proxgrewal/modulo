/** Form field definitions and server-side validation of submissions. */

export const FIELD_TYPES = ['text', 'email', 'textarea', 'select', 'checkbox', 'number'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FormFieldDef {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
}

export const MAX_LENGTH = 5000;
export const HONEYPOT = '_hp';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Coerce stored (untrusted, editor-authored) JSON into clean field definitions. */
export function normaliseFields(raw: unknown): FormFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const out: FormFieldDef[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    if (!NAME_RE.test(name) || name === HONEYPOT || seen.has(name)) continue;
    seen.add(name);
    const type = (FIELD_TYPES as readonly string[]).includes(String(r.type)) ? (String(r.type) as FieldType) : 'text';
    const options = Array.isArray(r.options) ? r.options.map((o) => String(o ?? '').slice(0, 200)).filter(Boolean).slice(0, 200) : [];
    out.push({ name, label: String(r.label ?? name).slice(0, 200) || name, type, required: r.required === true || r.required === 'true', options });
  }
  return out;
}

export interface ValidationResult {
  ok: boolean;
  data: Record<string, string | number | boolean | null>;
  errors: Record<string, string>;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'on' || v === 'true' || v === '1' || v === 1 || v === 'yes';
}

/** Validate an untrusted submission body against the form's field definitions. Unknown keys are dropped. */
export function validateSubmission(fields: FormFieldDef[], body: Record<string, unknown>): ValidationResult {
  const data: ValidationResult['data'] = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = Object.prototype.hasOwnProperty.call(body, f.name) ? body[f.name] : undefined;
    if (f.type === 'checkbox') {
      const v = Array.isArray(raw) ? raw.some(truthy) : truthy(raw);
      if (f.required && !v) errors[f.name] = `${f.label} must be checked`;
      data[f.name] = v;
      continue;
    }
    if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      errors[f.name] = `${f.label} is invalid`;
      continue;
    }
    const s = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!s) {
      if (f.required) errors[f.name] = `${f.label} is required`;
      data[f.name] = null;
      continue;
    }
    if (s.length > MAX_LENGTH) {
      errors[f.name] = `${f.label} must be at most ${MAX_LENGTH} characters`;
      continue;
    }
    switch (f.type) {
      case 'email':
        if (s.length > 254 || !EMAIL_RE.test(s)) errors[f.name] = `${f.label} must be a valid email address`;
        else data[f.name] = s;
        break;
      case 'number': {
        const n = Number(s);
        if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) || !Number.isFinite(n)) errors[f.name] = `${f.label} must be a number`;
        else data[f.name] = n;
        break;
      }
      case 'select':
        if (!f.options.includes(s)) errors[f.name] = `${f.label} must be one of the listed options`;
        else data[f.name] = s;
        break;
      case 'text':
        // Single-line field: newlines are not expected.
        data[f.name] = s.replace(/[\r\n]+/g, ' ');
        break;
      default:
        data[f.name] = s;
    }
  }
  return { ok: Object.keys(errors).length === 0, data, errors };
}

/** Parse a urlencoded body (no-JS POST) into a plain object; repeated keys keep the last value. */
export function parseBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (typeof (body as any).forEach === 'function' && typeof (body as any).get === 'function') {
      const out: Record<string, unknown> = {};
      (body as URLSearchParams).forEach((v, k) => (out[k] = v));
      return out;
    }
    return body as Record<string, unknown>;
  }
  if (typeof body === 'string') {
    const t = body.trim();
    if (t.startsWith('{')) {
      try {
        const j = JSON.parse(t);
        return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
      } catch {
        return {};
      }
    }
    const out: Record<string, unknown> = {};
    new URLSearchParams(t).forEach((v, k) => (out[k] = v));
    return out;
  }
  return {};
}
