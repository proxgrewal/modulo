import { describe, expect, it } from 'vitest';
import { f, type PageNode, type PatchOp } from '@modulo/core';
import { aiNodes } from '../src/lib/ai.ts';
import { insertAfterSelection, keyToCommand, planCommand, replacePageOps } from '../src/lib/commands.ts';
import { coerceModelValue, coerceNumber, controlFor, fieldSpecs, formatModelValue, humanize, listItemLabel, modelControlFor, moveItem, newListItem } from '../src/lib/fields.ts';
import { describeOp, mergeLayoutOp, mergeLayoutOps, navLinkOp, siteNodeId } from '../src/lib/layout-ops.ts';
import { canvasToDocParent, createNode, docToCanvasParent, flattenTree, locateNode, pathTo, schemaMap, shareTree, slotAccepts } from '../src/lib/tree.ts';
import type { BlockSchema } from '../src/types.ts';

const schemas = schemaMap([
  { type: 'core:section', version: 1, label: 'Section', module: 'core', fields: { padding: f.token('space') }, slots: [{ name: 'default' }] },
  { type: 'core:heading', version: 1, label: 'Heading', module: 'core', fields: { text: f.text({ default: 'Heading' }), level: f.select(['h2', 'h1']) } },
  { type: 'core:text', version: 1, label: 'Text', module: 'core', fields: { html: f.richtext() } },
  { type: 'shop:cart', version: 2, label: 'Cart', module: 'shop', fields: {}, slots: [{ name: 'items', allow: ['shop:*'] }] },
  { type: 'shop:line', version: 1, label: 'Line', module: 'shop', fields: {} },
] as BlockSchema[]);

const tree = (): PageNode => ({
  id: 'root',
  type: 'core:page',
  props: {},
  slots: {
    default: [
      { id: 's1', type: 'core:section', props: {}, slots: { default: [{ id: 'h1', type: 'core:heading', props: { text: 'Hello' } }, { id: 't1', type: 'core:text', props: { html: '<p>x</p>' } }] } },
      { id: 's2', type: 'core:section', props: {}, slots: { default: [] } },
      { id: 'lock', type: 'core:heading', props: {}, locked: true },
    ],
  },
});

describe('main -> root mapping', () => {
  it('maps the layout outlet to the page document root and back', () => {
    expect(canvasToDocParent('main')).toBe('root');
    expect(canvasToDocParent('main', 'main')).toBe('root');
    expect(canvasToDocParent('s1')).toBe('s1');
    expect(canvasToDocParent('main', null)).toBe('main'); // rendered without layout
    expect(docToCanvasParent('root')).toBe('main');
    expect(docToCanvasParent('s1')).toBe('s1');
  });
});

describe('tree helpers', () => {
  it('checks slot allow lists (glob patterns) and unknown slots', () => {
    expect(slotAccepts(schemas, 'core:page', 'default', 'core:heading')).toBe(true);
    expect(slotAccepts(schemas, 'core:section', 'default', 'shop:line')).toBe(true);
    expect(slotAccepts(schemas, 'shop:cart', 'items', 'shop:line')).toBe(true);
    expect(slotAccepts(schemas, 'shop:cart', 'items', 'core:heading')).toBe(false);
    expect(slotAccepts(schemas, 'core:section', 'nope', 'core:heading')).toBe(false);
    expect(slotAccepts(schemas, 'core:heading', 'default', 'core:text')).toBe(false);
  });
  it('creates nodes with defaults, version, origin and empty slots', () => {
    const n = createNode(schemas.get('core:heading')!);
    expect(n).toMatchObject({ type: 'core:heading', v: 1, origin: 'user', props: { text: 'Heading', level: 'h2' } });
    expect(n.id).toMatch(/^n_/);
    expect(createNode(schemas.get('shop:cart')!).slots).toEqual({ items: [] });
  });
  it('shares unchanged subtrees between reads', () => {
    const a = tree();
    const b = tree();
    expect(shareTree(a, b)).toBe(a);
    const c = tree();
    c.slots!.default![0]!.slots!.default![0]!.props.text = 'Changed';
    const shared = shareTree(a, c)!;
    expect(shared).not.toBe(a);
    expect(shared.slots!.default![1]).toBe(a.slots!.default![1]); // untouched section reused
    expect(shared.slots!.default![0]!.slots!.default![1]).toBe(a.slots!.default![0]!.slots!.default![1]);
    expect(shared.slots!.default![0]!.slots!.default![0]!.props.text).toBe('Changed');
  });
  it('locates, paths and flattens', () => {
    const t = tree();
    expect(locateNode(t, 't1')).toMatchObject({ slot: 'default', index: 1 });
    expect(pathTo(t, 't1')).toEqual(['root', 's1', 't1']);
    expect(flattenTree(t, new Set()).map((x) => `${x.depth}:${x.node.id}`)).toEqual(['0:s1', '1:h1', '1:t1', '0:s2', '0:lock']);
    expect(flattenTree(t, new Set(['s1'])).map((x) => x.node.id)).toEqual(['s1', 's2', 'lock']);
  });
});

describe('field-to-form mapping', () => {
  it('maps every field kind to an inspector control', () => {
    expect(controlFor(f.text())).toBe('text');
    expect(controlFor(f.textarea())).toBe('textarea');
    expect(controlFor(f.richtext())).toBe('richtext');
    expect(controlFor(f.number())).toBe('number');
    expect(controlFor(f.number({ min: 1, max: 6 }))).toBe('slider');
    expect(controlFor(f.boolean())).toBe('switch');
    expect(controlFor(f.select(['a', 'b']))).toBe('segmented');
    expect(controlFor(f.select(['section', 'div', 'header', 'footer', 'aside']))).toBe('select');
    expect(controlFor(f.token('color'))).toBe('swatches');
    expect(controlFor(f.token('space'))).toBe('token-select');
    expect(controlFor(f.image())).toBe('image');
    expect(controlFor(f.link())).toBe('link');
    expect(controlFor(f.color())).toBe('color');
    expect(controlFor(f.list({ a: f.text() }))).toBe('list');
    expect(controlFor(f.collection({ model: 'shop.product' }))).toBe('collection');
  });
  it('builds labelled specs, skipping hidden fields', () => {
    const specs = fieldSpecs({ ctaLabel: f.text(), secret: f.text({ hidden: true }), title: f.text({ label: 'Headline' }) });
    expect(specs.map((s) => [s.key, s.label])).toEqual([
      ['ctaLabel', 'Cta label'],
      ['title', 'Headline'],
    ]);
    expect(humanize('max_width')).toBe('Max width');
  });
  it('coerces numbers within min/max and handles list items', () => {
    expect(coerceNumber('12', { min: 1, max: 6 })).toBe(6);
    expect(coerceNumber('0', { min: 1 })).toBe(1);
    expect(coerceNumber('', {})).toBeUndefined();
    expect(coerceNumber('abc', {})).toBeUndefined();
    const of = { q: f.text({ default: 'Question?' }), a: f.textarea({ default: 'Answer.' }) };
    expect(newListItem(of)).toEqual({ q: 'Question?', a: 'Answer.' });
    expect(listItemLabel({ q: 'Why?' }, of, 'q', 0)).toBe('Why?');
    expect(listItemLabel({ q: '' }, of, undefined, 2)).toBe('Item 3');
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
  it('maps model field kinds to data-form controls and coerces values', () => {
    expect(['string', 'text', 'richtext', 'int', 'float', 'money', 'boolean', 'date', 'datetime', 'enum', 'json', 'ref', 'media', 'slug', 'email', 'url'].map((k) => modelControlFor({ kind: k }))).toEqual([
      'text', 'textarea', 'richtext', 'int', 'float', 'money', 'switch', 'date', 'datetime', 'select', 'json', 'ref', 'media', 'slug', 'email', 'url',
    ]);
    expect(coerceModelValue({ kind: 'int' }, '4.7')).toBe(4);
    expect(coerceModelValue({ kind: 'money' }, '9.99')).toBe(9.99);
    expect(coerceModelValue({ kind: 'json' }, '{"a":1}')).toEqual({ a: 1 });
    expect(coerceModelValue({ kind: 'string' }, '')).toBeNull();
    expect(coerceModelValue({ kind: 'string', required: true }, '')).toBe('');
    expect(coerceModelValue({ kind: 'slug' }, '')).toBeUndefined();
    expect(coerceModelValue({ kind: 'boolean' }, 1)).toBe(true);
    expect(formatModelValue({ kind: 'date' }, '2026-01-05T00:00:00Z')).toBe('2026-01-05');
    expect(formatModelValue({ kind: 'json' }, { a: 1 })).toContain('"a": 1');
  });
});

describe('layout op generation & merging', () => {
  it('generates nav link appends and merges setProp by target+prop', () => {
    const add = navLinkOp('About', '/about', 'about-link');
    expect(add).toEqual({ op: 'append', target: 'header#nav', node: { id: 'about-link', type: 'core:link', props: { label: 'About', href: '/about' } } });
    let ops = mergeLayoutOps([], [add, { op: 'setProp', target: 'footer', prop: 'text', value: 'A' }]);
    ops = mergeLayoutOp(ops, { op: 'setProp', target: 'footer', prop: 'text', value: 'B' });
    expect(ops).toHaveLength(2);
    expect(ops[1]).toEqual({ op: 'setProp', target: 'footer', prop: 'text', value: 'B' });
  });
  it('edits a site-added node in place instead of stacking ops', () => {
    const ops = mergeLayoutOp([navLinkOp('About', '/about', 'about-link')], { op: 'setProp', target: siteNodeId('about-link'), prop: 'label', value: 'Our story' });
    expect(ops).toHaveLength(1);
    expect((ops[0] as any).node.props.label).toBe('Our story');
  });
  it('removing a site-added node drops its insert; removing a module node adds a remove op', () => {
    const start: PatchOp[] = [navLinkOp('About', '/about', 'about-link'), { op: 'setProp', target: 'nav-home', prop: 'label', value: 'Start' }];
    expect(mergeLayoutOp(start, { op: 'remove', target: 'site.about-link' })).toEqual([start[1]]);
    const removed = mergeLayoutOp(start, { op: 'remove', target: 'nav-home' });
    expect(removed).toEqual([start[0], { op: 'remove', target: 'nav-home' }]);
    // idempotent
    expect(mergeLayoutOp(removed, { op: 'remove', target: 'nav-home' })).toEqual(removed);
  });
  it('merges setStyle and does not mutate the input', () => {
    const start: PatchOp[] = [{ op: 'setStyle', target: 'header', style: { padding: 'token:space.sm' } }];
    const out = mergeLayoutOp(start, { op: 'setStyle', target: 'header', style: { background: 'token:color.surface', padding: undefined } });
    expect(out).toEqual([{ op: 'setStyle', target: 'header', style: { background: 'token:color.surface' } }]);
    expect(start[0]).toEqual({ op: 'setStyle', target: 'header', style: { padding: 'token:space.sm' } });
    expect(describeOp(navLinkOp('About', '/about'))).toContain('About');
  });
});

describe('keyboard commands', () => {
  it('maps keys (platform aware)', () => {
    expect(keyToCommand({ key: 'Delete' })).toBe('delete');
    expect(keyToCommand({ key: 'Backspace' })).toBe('delete');
    expect(keyToCommand({ key: 'd', ctrlKey: true })).toBe('duplicate');
    expect(keyToCommand({ key: 'd', metaKey: true }, true)).toBe('duplicate');
    expect(keyToCommand({ key: 'd', metaKey: true }, false)).toBeNull();
    expect(keyToCommand({ key: 'z', ctrlKey: true })).toBe('undo');
    expect(keyToCommand({ key: 'Z', ctrlKey: true, shiftKey: true })).toBe('redo');
    expect(keyToCommand({ key: 'y', ctrlKey: true })).toBe('redo');
    expect(keyToCommand({ key: 'c', ctrlKey: true })).toBe('copy');
    expect(keyToCommand({ key: 'v', ctrlKey: true })).toBe('paste');
    expect(keyToCommand({ key: 'ArrowUp' })).toBe('selectPrev');
    expect(keyToCommand({ key: 'ArrowDown' })).toBe('selectNext');
    expect(keyToCommand({ key: 'ArrowUp', altKey: true })).toBe('moveUp');
    expect(keyToCommand({ key: 'Escape' })).toBe('selectParent');
    expect(keyToCommand({ key: '/' })).toBe('focusSearch');
    expect(keyToCommand({ key: 'a' })).toBeNull();
  });

  const ctx = (selection: string | null, clipboard: PageNode | null = null) => ({ tree: tree(), selection, clipboard, schemas });

  it('delete removes the selection and selects a neighbour', () => {
    expect(planCommand('delete', ctx('h1'))).toMatchObject({ ops: [{ op: 'remove', id: 'h1' }], select: 't1' });
    expect(planCommand('delete', ctx('t1')).select).toBe('h1');
    expect(planCommand('delete', ctx('lock')).ops).toEqual([]); // locked
    expect(planCommand('delete', ctx(null)).ops).toEqual([]);
  });
  it('duplicate inserts a re-id copy right after', () => {
    const r = planCommand('duplicate', ctx('s1'));
    const op = r.ops[0] as any;
    expect(op).toMatchObject({ op: 'insert', parentId: 'root', slot: 'default', index: 1 });
    expect(op.node.id).not.toBe('s1');
    expect(op.node.slots.default[0].id).not.toBe('h1');
    expect(op.node.slots.default[0].props.text).toBe('Hello');
    expect(r.select).toBe(op.node.id);
  });
  it('copy/paste: into an empty container, else after the selection', () => {
    const copied = planCommand('copy', ctx('h1')).clipboard!;
    expect(copied.id).toBe('h1');
    const intoEmpty = planCommand('paste', ctx('s2', copied)).ops[0] as any;
    expect(intoEmpty).toMatchObject({ op: 'insert', parentId: 's2', slot: 'default', index: 0 });
    const after = planCommand('paste', ctx('t1', copied)).ops[0] as any;
    expect(after).toMatchObject({ parentId: 's1', index: 2 });
    expect(after.node.id).not.toBe('h1');
    const atEnd = planCommand('paste', ctx(null, copied)).ops[0] as any;
    expect(atEnd).toMatchObject({ parentId: 'root', index: 3 });
  });
  it('selection navigation and moves', () => {
    expect(planCommand('selectNext', ctx('h1')).select).toBe('t1');
    expect(planCommand('selectPrev', ctx('t1')).select).toBe('h1');
    expect(planCommand('selectPrev', ctx('h1')).select).toBeUndefined();
    expect(planCommand('selectParent', ctx('h1')).select).toBe('s1');
    expect(planCommand('selectParent', ctx('s1')).select).toBeNull();
    expect(planCommand('moveDown', ctx('h1')).ops).toEqual([{ op: 'move', id: 'h1', parentId: 's1', slot: 'default', index: 1 }]);
    expect(planCommand('moveUp', ctx('h1')).ops).toEqual([]);
  });
  it('insertAfterSelection / replacePageOps', () => {
    const n = { id: 'x', type: 'core:text', props: {} };
    expect(insertAfterSelection(tree(), 'h1', [n], schemas)[0]).toMatchObject({ parentId: 's1', index: 1 });
    expect(insertAfterSelection(tree(), null, [n], schemas)[0]).toMatchObject({ parentId: 'root', index: 3 });
    const rep = replacePageOps(tree(), [n]);
    expect(rep.filter((o) => o.op === 'remove')).toHaveLength(3);
    expect(rep.at(-1)).toMatchObject({ op: 'insert', index: 0 });
  });
  it('extracts AI result nodes from common shapes', () => {
    const page = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'a', type: 'core:text', props: {} }] } };
    expect(aiNodes({ tree: page }).map((n) => n.id)).toEqual(['a']);
    expect(aiNodes({ id: 'b', type: 'core:hero', props: {} }).map((n) => n.id)).toEqual(['b']);
    expect(aiNodes({ nodes: [{ id: 'c', type: 'core:text', props: {} }, { nope: 1 }] }).map((n) => n.id)).toEqual(['c']);
    expect(aiNodes(null)).toEqual([]);
  });
});
