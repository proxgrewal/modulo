import { describe, expect, it } from 'vitest';
import {
  applyPatches,
  BlockRegistry,
  defaultTheme,
  defineBlock,
  detectConflicts,
  f,
  h,
  moveNode,
  renderDocument,
  renderToString,
  slot,
  StyleSheet,
  type PageNode,
  type Patch,
} from '../src/index.ts';

describe('h / renderToString', () => {
  it('escapes text and attributes and drops unsafe attrs/urls', () => {
    const html = renderToString(h('a', { href: 'javascript:alert(1)', onclick: 'x()', title: '"<b>' }, '<script>'));
    expect(html).toBe('<a href="#" title="&quot;&lt;b&gt;">&lt;script&gt;</a>');
  });
});

const layout: PageNode = {
  id: 'root',
  type: 'core:page',
  props: {},
  slots: {
    default: [
      { id: 'header', type: 't:box', props: {}, slots: { actions: [{ id: 'login', type: 't:text', props: { text: 'Login' } }] } },
      { id: 'main', type: 't:box', props: {}, slots: { default: [] } },
    ],
  },
};
const node = (id: string, text = id): PageNode => ({ id, type: 't:text', props: { text } });

describe('patch engine', () => {
  it('applies slot/id-addressed ops with provenance and module-prefixed ids', () => {
    const patches: Patch[] = [
      { id: 'shop.cart', module: 'shop', template: 'layout', ops: [{ op: 'append', target: 'header#actions', node: node('cart') }] },
      { id: 'blog.nav', module: 'blog', template: 'layout', ops: [{ op: 'insertBefore', target: 'login', node: node('blog-link') }] },
    ];
    const r = applyPatches(layout, patches);
    expect(r.failures).toEqual([]);
    const actions = r.tree.slots!.default![0]!.slots!.actions!.map((n) => n.id);
    expect(actions).toEqual(['blog.blog-link', 'login', 'shop.cart']);
    expect(r.provenance['shop.cart']).toBe('shop');
  });

  it('detects conflicting destructive ops and honours resolutions', () => {
    const patches: Patch[] = [
      { id: 'a.p', module: 'a', template: 'layout', ops: [{ op: 'replace', target: 'login', node: node('x', 'A') }] },
      { id: 'b.p', module: 'b', template: 'layout', ops: [{ op: 'remove', target: 'login' }] },
    ];
    const c = detectConflicts(patches);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ target: 'login', modules: ['a', 'b'], winner: 'b' });
    const r = applyPatches(layout, patches, { 'login|structure': 'a' });
    expect(r.tree.slots!.default![0]!.slots!.actions!.map((n) => n.id)).toEqual(['a.x']);
    expect(r.failures).toEqual([{ patch: 'b.p', module: 'b', op: 'remove', target: 'login', reason: 'lost conflict' }]);
  });

  it('setProp overrides a data binding on that prop', () => {
    const t: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'f', type: 't:text', props: {}, bind: { text: 'site.copyright', other: 'x' } }] } };
    const r = applyPatches(t, [{ id: 's.p', module: 'site', template: 'layout', ops: [{ op: 'setProp', target: 'f', prop: 'text', value: 'Mine' }] }]);
    expect(r.tree.slots!.default![0]).toMatchObject({ props: { text: 'Mine' }, bind: { other: 'x' } });
  });

  it('reports missing targets instead of throwing', () => {
    const r = applyPatches(layout, [{ id: 'z.p', module: 'z', template: 'layout', ops: [{ op: 'append', target: 'nope#x', node: node('n') }] }]);
    expect(r.failures[0]!.reason).toMatch(/not found/);
    expect(r.applied).toEqual([]);
  });
});

describe('tree ops', () => {
  it('moves nodes within and across slots', () => {
    const t: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [node('a'), node('b'), node('c')] } };
    expect(moveNode(t, 'a', 'root', 'default', 3).slots!.default!.map((n) => n.id)).toEqual(['b', 'c', 'a']);
    expect(moveNode(t, 'c', 'root', 'default', 0).slots!.default!.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('render', () => {
  const reg = new BlockRegistry();
  reg.register(
    defineBlock({
      type: 't:box',
      version: 1,
      label: 'Box',
      fields: {},
      slots: [{ name: 'default' }],
      render: (_p, ctx) => ctx.root('section', null, slot('default')),
    }),
    't',
  );
  reg.register(
    defineBlock({
      type: 't:text',
      version: 2,
      label: 'Text',
      fields: { text: f.text({ default: 'hi' }) },
      migrate: (p, from) => (from === 1 ? { text: p.label } : p),
      island: { name: 't:clicker', script: '(el)=>{el.dataset.ready="1"}' },
      render: (p, ctx) => ctx.root('p', null, p.text),
    }),
    't',
  );

  it('renders a full document with atomic css, tokens and islands', () => {
    const tree: PageNode = {
      id: 'root',
      type: 'core:page',
      props: {},
      slots: { default: [{ id: 'b', type: 't:box', props: {}, style: { padding: 'token:space.lg' }, responsive: { sm: { padding: 'token:space.sm' } }, slots: { default: [node('t', 'Hello')] } }] },
    };
    const r = renderDocument(tree, { registry: reg, theme: defaultTheme, title: 'T' });
    expect(r.html).toMatch(/<section class="m-padding-\w+ m-sm-padding-\w+"><p data-island="t:clicker">Hello<\/p><\/section>/);
    expect(r.document).toContain('--space-lg:2rem');
    expect(r.document).toContain('@media (max-width:640px)');
    expect(r.document).toContain('"t:clicker":((el)=>');
    expect(r.jsBytes).toBeLessThan(500);
  });

  it('migrates old block versions and validates slot rules', () => {
    const { tree, changed } = reg.migrateTree({ id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'x', type: 't:text', v: 1, props: { label: 'old' } }] } });
    expect(changed).toBe(1);
    expect(tree.slots!.default![0]).toMatchObject({ v: 2, props: { text: 'old' } });
    expect(reg.validateTree({ id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'x', type: 't:text', props: { text: 5 } }] } })[0]).toMatch(/text/);
  });

  it('compiles the full style catalog: per-side spacing, flex/grid, states, presets, breakpoints, images', () => {
    const s = new StyleSheet();
    const cls = s.classesFor(
      { display: 'grid', columns: '3', gap: 'token:space.md', paddingTop: '12px', position: 'relative', fontWeight: '700', radiusTopLeft: '8px', backgroundImage: '/media/a b.png', transform: 'translateY(-2px) scale(1.02)' },
      { xs: { columns: '1' } },
      { hover: { shadow: 'token:shadow.lg', transform: 'translateY(-4px)' } },
    );
    expect(cls).toHaveLength(12);
    const pre = s.presetClass('card', { style: { padding: '24px', radius: 'token:radius.md' }, states: { hover: { background: '#f0f0f0' } } });
    expect(pre).toBe('s-card');
    const css = s.toString();
    expect(css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    expect(css).toContain('padding-top:12px');
    expect(css).toContain('background-image:url("/media/a%20b.png")');
    expect(css).toMatch(/:hover\{box-shadow:var\(--shadow-lg\)\}/);
    expect(css).toContain('@media (max-width:420px)');
    expect(css.indexOf('.s-card{')).toBeLessThan(css.indexOf('.m-display')); // presets before atomic overrides
  });

  it('rejects injection through style values', () => {
    const s = new StyleSheet();
    expect(s.classesFor({ background: 'red;}</style><script>', width: '10px/* x */', backgroundImage: 'javascript:alert(1)', transform: 'url(x)', filter: 'blur(2px);x' })).toHaveLength(0);
  });

  it('ignores unsafe style values', () => {
    const s = new StyleSheet();
    expect(s.classesFor({ background: 'url(javascript:x)', color: 'token:color.primary' })).toHaveLength(1);
  });
});
