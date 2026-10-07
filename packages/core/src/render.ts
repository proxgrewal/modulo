import { renderToString, h, raw, escapeHtml, type VNode } from './h.ts';
import { BlockRegistry, makeRoot, type LoadContext, type RenderContext, type RenderMode, type RegisteredBlock } from './blocks.ts';
import { withDefaults } from './fields.ts';
import { StyleSheet, type StylePreset } from './style.ts';
import { themeToCss, type Theme } from './tokens.ts';
import { walk, type PageNode } from './tree.ts';

export interface RenderOptions {
  registry: BlockRegistry;
  theme: Theme;
  mode?: RenderMode;
  scope?: Record<string, unknown>;
  /** Pre-loaded data per node id (from loadData). */
  data?: Map<string, unknown>;
  /** Site style presets (named reusable styles). */
  presets?: Record<string, StylePreset>;
}

export interface RenderResult {
  html: string;
  css: string;
  islands: Map<string, string>;
  /** Bytes of island JS this page ships. */
  jsBytes: number;
}

/** Look up "a.b.c" in an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Apply node.bind expressions ("record.title") against the render scope. */
export function resolveProps(node: PageNode, def: RegisteredBlock | undefined, scope: Record<string, unknown>): Record<string, any> {
  const props = def ? withDefaults(def.fields, node.props) : { ...node.props };
  for (const [key, expr] of Object.entries(node.bind ?? {})) {
    const v = getPath(scope, expr);
    if (v !== undefined) props[key] = v;
  }
  return props;
}

/** Run every block's load() in parallel; result keyed by node id. */
export async function loadData(root: PageNode, registry: BlockRegistry, ctx: LoadContext): Promise<Map<string, unknown>> {
  const jobs: Promise<void>[] = [];
  const out = new Map<string, unknown>();
  walk(root, (n) => {
    const def = registry.get(n.type);
    if (def?.load) {
      const props = resolveProps(n, def, ctx.scope);
      jobs.push(
        def.load(props, ctx).then(
          (d) => void out.set(n.id, d),
          (err) => void out.set(n.id, { __error: String(err?.message ?? err) }),
        ),
      );
    }
  });
  await Promise.all(jobs);
  return out;
}

/** Build the VNode for one node (slots are left as markers). Shared by publish renderer and editor canvas. */
export function renderNodeShell(node: PageNode, opts: RenderOptions, sheet: StyleSheet, islands?: Map<string, string>): VNode {
  const { registry, theme } = opts;
  const mode = opts.mode ?? 'publish';
  const scope = opts.scope ?? {};
  const def = registry.get(node.type);
  if (!def) {
    return mode === 'edit'
      ? h('div', { class: 'm-missing', 'data-node-id': node.id }, `Missing block: ${node.type}`)
      : raw(`<!-- missing block ${escapeHtml(node.type)} -->`);
  }
  if (def.css) sheet.addBlockCss(`block:${def.type}`, def.css);
  const classes: string[] = [];
  for (const name of node.presets ?? []) {
    const c = sheet.presetClass(name, opts.presets?.[name]);
    if (c) classes.push(c);
  }
  classes.push(...sheet.classesFor(node.style, node.responsive, node.states));
  for (const c of String(node.className ?? '').split(/\s+/)) if (/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(c)) classes.push(c);
  const props = resolveProps(node, def, scope);
  const data = opts.data?.get(node.id);
  const attrs: Record<string, any> = { class: classes.join(' ') || undefined };
  if (mode === 'edit') attrs['data-node-id'] = node.id;
  if (def.island) {
    islands?.set(def.island.name, def.island.script);
    attrs['data-island'] = def.island.name;
    const ip = def.islandProps?.(props, data);
    if (ip) attrs['data-props'] = JSON.stringify(ip);
  }
  const ctx: RenderContext = { node, mode, theme, data, attrs, root: makeRoot(attrs), scope };
  try {
    return def.render(props, ctx);
  } catch (err: any) {
    return mode === 'edit' ? h('div', { class: 'm-error', 'data-node-id': node.id }, `Render error in ${node.type}: ${err?.message}`) : raw(`<!-- render error ${escapeHtml(node.type)} -->`);
  }
}

export function renderTree(root: PageNode, opts: RenderOptions): RenderResult {
  const sheet = new StyleSheet();
  const islands = new Map<string, string>();
  const edit = opts.mode === 'edit';
  const slotHtml = (node: PageNode, name: string): string => {
    const inner = (node.slots?.[name] ?? []).map(renderNode).join('');
    // In the editor, slots are marked (display:contents) so the canvas can hit-test drop zones.
    return edit ? `<m-slot data-parent="${escapeHtml(node.id)}" data-slot="${escapeHtml(name)}">${inner}</m-slot>` : inner;
  };
  const renderNode = (node: PageNode): string => {
    const shell = renderNodeShell(node, opts, sheet, islands);
    return renderToString(shell, (s) => slotHtml(node, s.name));
  };
  // The page root is a plain container.
  const body = root.type === 'core:page' && !opts.registry.has('core:page') ? slotHtml(root, 'default') : renderNode(root);
  const js = islandRuntime(islands);
  return { html: body, css: sheet.toString(), islands, jsBytes: js.length };
}

export function islandRuntime(islands: Map<string, string>): string {
  if (!islands.size) return '';
  const entries = [...islands.entries()].map(([name, src]) => `${JSON.stringify(name)}:(${src})`).join(',');
  return `(()=>{const I={${entries}};document.querySelectorAll('[data-island]').forEach(e=>{const f=I[e.dataset.island];if(f)try{f(e,JSON.parse(e.dataset.props||'{}'))}catch(x){console.error(x)}})})();`;
}

export const BASE_CSS =
  '*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:var(--font-body);color:var(--color-text);background:var(--color-bg);line-height:1.6}' +
  'h1,h2,h3,h4{font-family:var(--font-heading);line-height:1.2;margin:0 0 .5em}p{margin:0 0 1em}img{max-width:100%;height:auto;display:block}a{color:var(--color-primary)}';

/** Extra CSS the editor canvas injects (slot markers, empty-slot drop zones, selection affordances). */
export const EDIT_CSS =
  'm-slot{display:contents}m-slot:empty{display:block;min-height:56px;border:1px dashed #9aa7c7;border-radius:6px;background:repeating-linear-gradient(45deg,transparent,transparent 6px,rgba(47,91,234,.04) 6px,rgba(47,91,234,.04) 12px)}' +
  '[data-node-id]{cursor:default}.m-missing,.m-error{padding:12px;border:1px dashed #d33;color:#a11;font:13px system-ui}';

export interface DocumentOptions extends RenderOptions {
  title: string;
  lang?: string;
  /** Extra <head> HTML contributed by modules (SEO meta etc.). Trusted. */
  head?: string;
  /** Extra end-of-body HTML (trusted). */
  bodyEnd?: string;
  /** Site custom CSS (edited by designers; cannot break out of the style element). */
  customCss?: string;
}

export function safeCustomCss(css: string | undefined): string {
  return String(css ?? '').slice(0, 100_000).replace(/<\/?(style|script)/gi, '').replace(/<!--|-->/g, '');
}

/** Full HTML document for a published page. */
export function renderDocument(root: PageNode, opts: DocumentOptions): RenderResult & { document: string } {
  const r = renderTree(root, opts);
  const js = islandRuntime(r.islands);
  const document =
    `<!doctype html><html lang="${escapeHtml(opts.lang ?? 'en')}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)}</title>` +
    (opts.head ?? '') +
    `<style>${themeToCss(opts.theme)}${BASE_CSS}${r.css}${safeCustomCss(opts.customCss)}</style></head><body>${r.html}` +
    (js ? `<script type="module">${js}</script>` : '') +
    (opts.bodyEnd ?? '') +
    `</body></html>`;
  return { ...r, document };
}
