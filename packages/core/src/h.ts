/**
 * A tiny isomorphic virtual-node format. Blocks render to VNodes, which the
 * publish renderer serialises to HTML and the editor converts to React
 * elements — so the canvas and the published site share one render path.
 */
export type Attrs = Record<string, string | number | boolean | null | undefined>;

export interface ElementNode {
  kind: 'el';
  tag: string;
  attrs: Attrs;
  children: VNode[];
}
export interface SlotNode {
  kind: 'slot';
  name: string;
  /** Optional wrapper tag/attrs the editor uses as the drop zone. */
  tag?: string;
  attrs?: Attrs;
}
export interface RawNode {
  kind: 'raw';
  html: string;
}
export type VNode = ElementNode | SlotNode | RawNode | string | number | null | undefined | false | VNode[];

export function h(tag: string, attrs?: Attrs | null, ...children: VNode[]): ElementNode {
  return { kind: 'el', tag, attrs: attrs ?? {}, children };
}

/** Placeholder replaced by the rendered children of a named slot. */
export function slot(name = 'default', tag?: string, attrs?: Attrs): SlotNode {
  return { kind: 'slot', name, tag, attrs };
}

/** Trusted HTML (already sanitised, e.g. rich text output). */
export function raw(html: string): RawNode {
  return { kind: 'raw', html };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const SAFE_ATTR = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster']);

/** Blocks javascript:/data: URLs except data:image. */
export function safeUrl(url: string): string {
  const u = url.trim();
  if (/^(javascript|vbscript):/i.test(u)) return '#';
  if (/^data:/i.test(u) && !/^data:image\//i.test(u)) return '#';
  return u;
}

export function renderAttrs(attrs: Attrs): string {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (!SAFE_ATTR.test(k) || /^on/i.test(k)) continue; // never emit inline handlers
    if (v === true) {
      out += ` ${k}`;
      continue;
    }
    const val = URL_ATTRS.has(k) ? safeUrl(String(v)) : String(v);
    out += ` ${k}="${escapeHtml(val)}"`;
  }
  return out;
}

export type SlotResolver = (slot: SlotNode) => string;

export function renderToString(node: VNode, resolveSlot?: SlotResolver): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return escapeHtml(node);
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => renderToString(n, resolveSlot)).join('');
  switch (node.kind) {
    case 'raw':
      return node.html;
    case 'slot': {
      const inner = resolveSlot ? resolveSlot(node) : '';
      return node.tag ? `<${node.tag}${renderAttrs(node.attrs ?? {})}>${inner}</${node.tag}>` : inner;
    }
    case 'el': {
      const tag = /^[a-zA-Z][a-zA-Z0-9-]*$/.test(node.tag) ? node.tag : 'div';
      const open = `<${tag}${renderAttrs(node.attrs)}>`;
      if (VOID.has(tag)) return open;
      return `${open}${node.children.map((c) => renderToString(c, resolveSlot)).join('')}</${tag}>`;
    }
  }
}
