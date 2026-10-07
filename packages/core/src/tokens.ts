import type { TokenGroup } from './fields.ts';

/**
 * Site-level design tokens (theme.json-style). Block props and style props
 * reference tokens as "token:<group>.<name>", compiled to CSS variables, so a
 * theme change restyles the whole site without touching page documents.
 */
export type Theme = Record<TokenGroup, Record<string, string>>;

export const defaultTheme: Theme = {
  color: {
    bg: '#ffffff',
    surface: '#f6f6f4',
    text: '#1b1b1f',
    muted: '#5f6168',
    primary: '#2f5bea',
    'primary-contrast': '#ffffff',
    accent: '#e8590c',
    border: '#e2e2e0',
  },
  space: { none: '0', xs: '0.25rem', sm: '0.5rem', md: '1rem', lg: '2rem', xl: '4rem', xxl: '6rem' },
  radius: { none: '0', sm: '4px', md: '8px', lg: '16px', full: '999px' },
  font: {
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    heading: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  fontSize: { sm: '0.875rem', md: '1rem', lg: '1.25rem', xl: '1.75rem', '2xl': '2.5rem', '3xl': '3.5rem' },
  shadow: { none: 'none', sm: '0 1px 2px rgba(0,0,0,.08)', md: '0 4px 14px rgba(0,0,0,.1)', lg: '0 12px 32px rgba(0,0,0,.14)' },
};

const TOKEN_RE = /^token:([a-zA-Z]+)\.([a-zA-Z0-9-]+)$/;
const SAFE_VALUE = /^[#a-zA-Z0-9\s.,%()\-+*/"']+$/;

export function isTokenRef(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export function tokenVar(group: string, name: string): string {
  return `--${group}-${name}`;
}

/** Resolve a value that may be a token ref to a CSS value (var(...)) or a sanitised literal. */
export function cssValue(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  const m = TOKEN_RE.exec(s);
  if (m) return `var(${tokenVar(m[1]!, m[2]!)})`;
  if (!SAFE_VALUE.test(s) || /url\s*\(|expression\s*\(|\/\*|\*\//i.test(s) || s.length > 400) return null;
  return s;
}

export function mergeTheme(base: Theme, override: Partial<Record<TokenGroup, Record<string, string>>> | undefined): Theme {
  const out = structuredClone(base);
  for (const [g, vals] of Object.entries(override ?? {})) {
    out[g as TokenGroup] = { ...(out[g as TokenGroup] ?? {}), ...(vals ?? {}) };
  }
  return out;
}

export function themeToCss(theme: Theme): string {
  const vars: string[] = [];
  for (const [group, vals] of Object.entries(theme)) {
    for (const [name, value] of Object.entries(vals)) {
      const safe = cssValue(value);
      if (safe) vars.push(`${tokenVar(group, name)}:${safe}`);
    }
  }
  return `:root{${vars.join(';')}}`;
}

export function tokenOptions(theme: Theme, group: TokenGroup): { value: string; label: string; preview: string }[] {
  return Object.entries(theme[group] ?? {}).map(([name, value]) => ({ value: `token:${group}.${name}`, label: name, preview: value }));
}
