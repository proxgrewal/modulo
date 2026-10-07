import { compileDecl, type Breakpoint, type PageNode, type StyleProps, type StyleState } from '@modulo/core';
import type { StyleCatalogEntry } from '../types.ts';

/**
 * Pure helpers for the Style panel: layers (base / breakpoint / state),
 * inheritance, catalog grouping and `when` gating, length parsing and
 * local validation (the same compileDecl the server uses).
 */

/** The style-bearing part of a node or a site preset. */
export interface StyleData {
  style?: StyleProps;
  responsive?: Partial<Record<Breakpoint, StyleProps>>;
  states?: Partial<Record<StyleState, StyleProps>>;
  presets?: string[];
  className?: string;
}

/** Which layer edits write to. A state layer applies at every breakpoint. */
export interface StyleLayer {
  bp?: Breakpoint;
  state?: StyleState;
}

/** Breakpoints from widest to narrowest: values cascade down this list. */
export const BP_ORDER: Breakpoint[] = ['md', 'sm', 'xs'];
export const BP_LABEL: Record<Breakpoint, string> = { md: 'Tablet', sm: 'Mobile', xs: 'Small phone' };
export const STATE_LABEL: Record<StyleState, string> = { hover: 'Hover', focus: 'Focus', active: 'Active' };

export function layerName(l: StyleLayer): string {
  if (l.state) return `${STATE_LABEL[l.state]} state`;
  if (l.bp) return BP_LABEL[l.bp];
  return 'Desktop (base)';
}

/** Values stored at exactly this layer. */
export function layerValues(d: StyleData | null | undefined, l: StyleLayer): StyleProps {
  if (!d) return {};
  if (l.state) return d.states?.[l.state] ?? {};
  if (l.bp) return d.responsive?.[l.bp] ?? {};
  return d.style ?? {};
}

export interface Inherited {
  value: string;
  from: string;
}

/**
 * The value a property would have at this layer if it were not set here:
 * a state falls back to the base style; a breakpoint to the wider breakpoints, then base.
 */
export function inheritedValue(d: StyleData | null | undefined, key: string, l: StyleLayer): Inherited | null {
  if (!d) return null;
  const has = (s: StyleProps | undefined) => s && s[key] !== undefined && s[key] !== '';
  if (l.state) {
    // Hover etc. also sit on top of the active breakpoint's value in the browser; show the base.
    return has(d.style) ? { value: String(d.style![key]), from: 'Desktop' } : null;
  }
  if (!l.bp) return null;
  const idx = BP_ORDER.indexOf(l.bp);
  for (let i = idx - 1; i >= 0; i--) {
    const bp = BP_ORDER[i]!;
    if (has(d.responsive?.[bp])) return { value: String(d.responsive![bp]![key]), from: BP_LABEL[bp] };
  }
  return has(d.style) ? { value: String(d.style![key]), from: 'Desktop' } : null;
}

/** Value set here, else inherited (what the element effectively gets at this layer, ignoring presets). */
export function effectiveValue(d: StyleData | null | undefined, key: string, l: StyleLayer): string | undefined {
  const own = layerValues(d, l)[key];
  if (own !== undefined && own !== '') return String(own);
  return inheritedValue(d, key, l)?.value;
}

/** Count of values set at each layer (for the context bar badges). */
export function layerCounts(d: StyleData | null | undefined): { base: number; bp: Partial<Record<Breakpoint, number>>; state: Partial<Record<StyleState, number>> } {
  const n = (s?: StyleProps) => Object.values(s ?? {}).filter((v) => v !== undefined && v !== '').length;
  return {
    base: n(d?.style),
    bp: Object.fromEntries(BP_ORDER.map((b) => [b, n(d?.responsive?.[b])])),
    state: Object.fromEntries((['hover', 'focus', 'active'] as StyleState[]).map((s) => [s, n(d?.states?.[s])])),
  };
}

/* ───────── catalog grouping & gating ───────── */

export const GROUP_ORDER: { group: StyleCatalogEntry['group']; label: string }[] = [
  { group: 'layout', label: 'Layout' },
  { group: 'child', label: 'Flex / Grid child' },
  { group: 'spacing', label: 'Spacing' },
  { group: 'size', label: 'Size' },
  { group: 'position', label: 'Position' },
  { group: 'typography', label: 'Typography' },
  { group: 'background', label: 'Background' },
  { group: 'border', label: 'Border' },
  { group: 'effects', label: 'Effects' },
];

export interface GateContext {
  /** Effective display of the element (style value, else computed in the canvas). */
  display?: string;
  /** Effective position of the element. */
  position?: string;
  /** Computed display of the parent element (canvas). */
  parentDisplay?: string;
  /** No canvas element (e.g. editing a preset): show everything. */
  unknown?: boolean;
}

const isFlex = (d?: string) => d === 'flex' || d === 'inline-flex';
const isGrid = (d?: string) => d === 'grid' || d === 'inline-grid';

export function propVisible(p: StyleCatalogEntry, g: GateContext): boolean {
  if (g.unknown) return true;
  switch (p.when) {
    case undefined:
      return p.group === 'child' ? isFlex(g.parentDisplay) || isGrid(g.parentDisplay) : true;
    case 'flex':
      return isFlex(g.display);
    case 'grid':
      return isGrid(g.display);
    case 'flex-or-grid':
      return isFlex(g.display) || isGrid(g.display);
    case 'parent-flex':
      return isFlex(g.parentDisplay);
    case 'parent-grid':
      return isGrid(g.parentDisplay);
    case 'positioned':
      return !!g.position && g.position !== 'static';
  }
}

/** Whether the whole "Flex/Grid child" group applies. */
export function childGroupVisible(g: GateContext): boolean {
  return !!g.unknown || isFlex(g.parentDisplay) || isGrid(g.parentDisplay);
}

/* ───────── values ───────── */

export interface ParsedLength {
  num: string;
  unit: string;
}

/** "24px" → {num:"24", unit:"px"}; "1.5" → {num:"1.5", unit:""}; tokens / keywords / expressions → null. */
export function parseLength(v: string | undefined): ParsedLength | null {
  if (v === undefined) return null;
  const m = /^\s*(-?\d*\.?\d+)\s*([a-z%]*)\s*$/i.exec(String(v));
  if (!m) return null;
  return { num: m[1]!, unit: m[2]!.toLowerCase() };
}

/** Normalise a typed length: a bare number gets the default unit (first non-empty catalog unit unless '' is allowed first). */
export function normalizeLength(raw: string, units: string[] | undefined, currentUnit?: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^-?\d*\.?\d+$/.test(v)) {
    const list = (units ?? ['px']).filter((u) => u !== 'auto');
    const unit = currentUnit !== undefined && list.includes(currentUnit) ? currentUnit : (list[0] ?? 'px');
    if (v === '0') return '0';
    return v + unit;
  }
  return v;
}

/** Validate a value with the same rules the renderer uses. Returns an error message or null. */
export function validateStyleValue(key: string, value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return compileDecl(key, value) === null ? `“${value}” isn’t a valid value here` : null;
}

export function tokenLabel(v: string | undefined): string | null {
  if (!v) return null;
  const m = /^token:([a-zA-Z]+)\.(.+)$/.exec(v);
  return m ? m[2]! : null;
}

/** Human display of a stored value (tokens shown by name). */
export function displayValue(v: string | undefined): string {
  if (v === undefined) return '';
  const t = tokenLabel(v);
  return t ? `${t} (token)` : v;
}

/* ───────── layer edits (pure, used for presets and paste) ───────── */

/** Return a copy of style data with one value set (or cleared) at a layer. */
export function withValue(d: StyleData, l: StyleLayer, values: Record<string, string | undefined>): StyleData {
  const out: StyleData = structuredClone(d);
  const apply = (cur: StyleProps | undefined) => {
    const next: StyleProps = { ...(cur ?? {}) };
    for (const [k, v] of Object.entries(values)) v === undefined || v === '' ? delete next[k] : (next[k] = v);
    return next;
  };
  if (l.state) {
    const st = apply(out.states?.[l.state]);
    out.states = { ...(out.states ?? {}), [l.state]: st };
    if (!Object.keys(st).length) delete out.states[l.state];
    if (!Object.keys(out.states).length) delete out.states;
  } else if (l.bp) {
    const st = apply(out.responsive?.[l.bp]);
    out.responsive = { ...(out.responsive ?? {}), [l.bp]: st };
    if (!Object.keys(st).length) delete out.responsive[l.bp];
    if (!Object.keys(out.responsive).length) delete out.responsive;
  } else out.style = apply(out.style);
  return out;
}

/** Just the style layers of a node (for copy/paste and "create preset"). */
export function styleLayersOf(n: Pick<PageNode, 'style' | 'responsive' | 'states'> | null | undefined): Required<Pick<StyleData, 'style'>> & Pick<StyleData, 'responsive' | 'states'> {
  const out: Required<Pick<StyleData, 'style'>> & Pick<StyleData, 'responsive' | 'states'> = { style: { ...(n?.style ?? {}) } };
  const resp = Object.fromEntries(Object.entries(n?.responsive ?? {}).filter(([, v]) => v && Object.keys(v).length));
  const states = Object.fromEntries(Object.entries(n?.states ?? {}).filter(([, v]) => v && Object.keys(v).length));
  if (Object.keys(resp).length) out.responsive = structuredClone(resp);
  if (Object.keys(states).length) out.states = structuredClone(states);
  return out;
}

export function hasAnyStyle(n: Pick<PageNode, 'style' | 'responsive' | 'states'> | null | undefined): boolean {
  const l = styleLayersOf(n);
  return Object.keys(l.style).length > 0 || !!l.responsive || !!l.states;
}

/** "Soft card" → "soft-card" (site preset names: lowercase letters, digits, dashes). */
export function presetNameFrom(label: string, taken: string[] = []): string {
  let base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  if (!/^[a-z]/.test(base)) base = `p-${base}`.replace(/-+$/, '');
  if (base === 'p') base = 'preset';
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}

/** Sanitise a class name list (custom CSS hooks): [a-z0-9-_], space separated. */
export function cleanClassNames(v: string): string {
  return v
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(c))
    .join(' ');
}

/** Keys of the box-model widget. */
export const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;
export type Side = (typeof SIDES)[number];

/** The value that applies to one side of padding/margin within a layer (side, then axis, then all). */
export function sideValue(values: StyleProps, prop: 'padding' | 'margin', side: Side): { value: string; key: string } | null {
  const axis = side === 'Top' || side === 'Bottom' ? 'Y' : 'X';
  for (const k of [`${prop}${side}`, `${prop}${axis}`, prop]) {
    const v = values[k];
    if (v !== undefined && v !== '') return { value: String(v), key: k };
  }
  return null;
}
