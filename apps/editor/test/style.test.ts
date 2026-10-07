import { describe, expect, it } from 'vitest';
import { f, type PageNode, type PatchOp } from '@modulo/core';
import { applyLayoutOpLocally, mergeLayoutOp, mergeLayoutOps } from '../src/lib/layout-ops.ts';
import {
  childGroupVisible,
  cleanClassNames,
  effectiveValue,
  inheritedValue,
  layerCounts,
  layerValues,
  normalizeLength,
  parseLength,
  presetNameFrom,
  propVisible,
  sideValue,
  styleLayersOf,
  validateStyleValue,
  withValue,
} from '../src/lib/style.ts';
import { canvasSelectableId, createNode, instanceNode, instantiateTemplate, schemaMap, shareTree, slotAccepts } from '../src/lib/tree.ts';
import type { BlockSchema, StyleCatalogEntry } from '../src/types.ts';

const node: PageNode = {
  id: 'n',
  type: 'core:box',
  props: {},
  style: { display: 'grid', columns: '3', paddingTop: '24px' },
  responsive: { md: { columns: '2' }, sm: { columns: '1' } },
  states: { hover: { background: '#eee' } },
};

describe('style layers', () => {
  it('reads values per layer and resolves inheritance down the breakpoints', () => {
    expect(layerValues(node, {})).toEqual(node.style);
    expect(layerValues(node, { bp: 'sm' })).toEqual({ columns: '1' });
    expect(layerValues(node, { state: 'hover' })).toEqual({ background: '#eee' });
    expect(inheritedValue(node, 'columns', {})).toBeNull();
    expect(inheritedValue(node, 'columns', { bp: 'md' })).toEqual({ value: '3', from: 'Desktop' });
    expect(inheritedValue(node, 'columns', { bp: 'sm' })).toEqual({ value: '2', from: 'Tablet' });
    expect(inheritedValue(node, 'columns', { bp: 'xs' })).toEqual({ value: '1', from: 'Mobile' });
    expect(inheritedValue(node, 'paddingTop', { state: 'hover' })).toEqual({ value: '24px', from: 'Desktop' });
    expect(effectiveValue(node, 'display', { bp: 'xs' })).toBe('grid');
    expect(effectiveValue(node, 'background', {})).toBeUndefined();
    expect(layerCounts(node)).toEqual({ base: 3, bp: { md: 1, sm: 1, xs: 0 }, state: { hover: 1, focus: 0, active: 0 } });
  });

  it('writes values immutably and drops empty layers', () => {
    const a = withValue(node, { bp: 'sm' }, { columns: undefined });
    expect(a.responsive).toEqual({ md: { columns: '2' } });
    expect(node.responsive?.sm).toEqual({ columns: '1' });
    const b = withValue({}, { state: 'focus' }, { outline: '2px solid red' });
    expect(b.states).toEqual({ focus: { outline: '2px solid red' } });
    expect(withValue(b, { state: 'focus' }, { outline: '' }).states).toBeUndefined();
    expect(styleLayersOf({ style: { a: '1' }, responsive: { md: {} }, states: {} })).toEqual({ style: { a: '1' } });
  });

  it('gates properties by display / parent display / position', () => {
    const p = (key: string, when?: StyleCatalogEntry['when'], group: StyleCatalogEntry['group'] = 'layout'): StyleCatalogEntry => ({ key, when, group, label: key, control: 'text' });
    expect(propVisible(p('gap', 'flex-or-grid'), { display: 'block' })).toBe(false);
    expect(propVisible(p('gap', 'flex-or-grid'), { display: 'inline-flex' })).toBe(true);
    expect(propVisible(p('columns', 'grid'), { display: 'flex' })).toBe(false);
    expect(propVisible(p('grow', 'parent-flex', 'child'), { parentDisplay: 'flex' })).toBe(true);
    expect(propVisible(p('order', undefined, 'child'), { parentDisplay: 'block' })).toBe(false);
    expect(propVisible(p('top', 'positioned', 'position'), { position: 'static' })).toBe(false);
    expect(propVisible(p('top', 'positioned', 'position'), { position: 'sticky' })).toBe(true);
    expect(propVisible(p('top', 'positioned', 'position'), { unknown: true })).toBe(true);
    expect(childGroupVisible({ parentDisplay: 'grid' })).toBe(true);
    expect(childGroupVisible({ parentDisplay: 'block' })).toBe(false);
  });

  it('parses, normalises and validates values with the renderer rules', () => {
    expect(parseLength('24px')).toEqual({ num: '24', unit: 'px' });
    expect(parseLength('1.5')).toEqual({ num: '1.5', unit: '' });
    expect(parseLength('token:space.lg')).toBeNull();
    expect(normalizeLength('24', ['px', '%'])).toBe('24px');
    expect(normalizeLength('2', ['px', 'rem'], 'rem')).toBe('2rem');
    expect(normalizeLength('1.4', ['', 'px'])).toBe('1.4');
    expect(normalizeLength('auto', ['px', 'auto'])).toBe('auto');
    expect(validateStyleValue('padding', '24px')).toBeNull();
    expect(validateStyleValue('columns', 'repeat(auto-fit,minmax(220px,1fr))')).toBeNull();
    expect(validateStyleValue('display', 'banana')).not.toBeNull();
    expect(validateStyleValue('width', 'expression(alert(1))')).not.toBeNull();
    expect(validateStyleValue('backgroundImage', 'javascript:alert(1)')).not.toBeNull();
    expect(validateStyleValue('background', 'linear-gradient(90deg,#fff,#000)')).toBeNull();
  });

  it('resolves box-model sides (side, then axis, then all)', () => {
    expect(sideValue({ padding: '8px', paddingY: '12px', paddingTop: '4px' }, 'padding', 'Top')).toEqual({ value: '4px', key: 'paddingTop' });
    expect(sideValue({ padding: '8px', paddingY: '12px' }, 'padding', 'Bottom')).toEqual({ value: '12px', key: 'paddingY' });
    expect(sideValue({ padding: '8px' }, 'padding', 'Left')).toEqual({ value: '8px', key: 'padding' });
    expect(sideValue({}, 'margin', 'Left')).toBeNull();
  });

  it('names presets and cleans class names', () => {
    expect(presetNameFrom('Soft card')).toBe('soft-card');
    expect(presetNameFrom('Soft card', ['soft-card'])).toBe('soft-card-2');
    expect(presetNameFrom('123 go')).toMatch(/^p-123-go$/);
    expect(cleanClassNames('brand-glow  bad.class ok_2 ')).toBe('brand-glow ok_2');
  });
});

describe('layout ops with breakpoints, states and fields', () => {
  it('keeps one setStyle op per target + layer and merges them', () => {
    let ops: PatchOp[] = [];
    ops = mergeLayoutOp(ops, { op: 'setStyle', target: 'header', style: { background: '#111' } });
    ops = mergeLayoutOp(ops, { op: 'setStyle', target: 'header', bp: 'sm', style: { paddingY: '4px' } });
    ops = mergeLayoutOp(ops, { op: 'setStyle', target: 'header', bp: 'sm', style: { color: '#fff' } });
    ops = mergeLayoutOp(ops, { op: 'setStyle', target: 'logo', state: 'hover', style: { opacity: '0.8' } });
    expect(ops).toEqual([
      { op: 'setStyle', target: 'header', style: { background: '#111' } },
      { op: 'setStyle', target: 'header', bp: 'sm', style: { paddingY: '4px', color: '#fff' } },
      { op: 'setStyle', target: 'logo', state: 'hover', style: { opacity: '0.8' } },
    ]);
    // Resetting every key of a layer drops the op.
    ops = mergeLayoutOp(ops, { op: 'setStyle', target: 'logo', state: 'hover', style: { opacity: undefined } });
    expect(ops).toHaveLength(2);
  });

  it('setField replaces earlier values; edits on site-inserted nodes are folded into the insert', () => {
    let ops: PatchOp[] = [{ op: 'append', target: 'header#nav', node: { id: 'about', type: 'core:link', props: { label: 'About' } } }];
    ops = mergeLayoutOps(ops, [
      { op: 'setField', target: 'footer', field: 'presets', value: ['a'] },
      { op: 'setField', target: 'footer', field: 'presets', value: ['b'] },
      { op: 'setStyle', target: 'site.about', bp: 'md', style: { color: 'red' } },
      { op: 'setStyle', target: 'site.about', state: 'hover', style: { color: 'blue' } },
      { op: 'setField', target: 'site.about', field: 'name', value: 'About link' },
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toEqual({ op: 'setField', target: 'footer', field: 'presets', value: ['b'] });
    const ins = ops[0] as unknown as { node: PageNode };
    expect(ins.node).toMatchObject({ responsive: { md: { color: 'red' } }, states: { hover: { color: 'blue' } }, name: 'About link' });
  });

  it('applies ops optimistically to the composed tree', () => {
    const tree: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'header', type: 'core:header', props: {}, style: { color: 'red' } }] } };
    applyLayoutOpLocally(tree, { op: 'setStyle', target: 'header', bp: 'sm', style: { color: 'blue' } });
    applyLayoutOpLocally(tree, { op: 'setStyle', target: 'header', style: { color: '' } });
    applyLayoutOpLocally(tree, { op: 'setField', target: 'header', field: 'className', value: 'x' });
    expect(tree.slots!.default![0]).toMatchObject({ style: {}, responsive: { sm: { color: 'blue' } }, className: 'x' });
  });
});

describe('node factories', () => {
  const box: BlockSchema = { type: 'core:box', version: 1, label: 'Box', module: 'core', fields: { tag: f.select(['div', 'section'], { label: 'Tag' }) }, slots: [{ name: 'default' }] };
  const columns: BlockSchema = {
    type: 'core:columns',
    version: 1,
    label: 'Columns',
    module: 'core',
    fields: { count: f.number({ label: 'Columns', default: 2 }) },
    slots: [{ name: 'default' }],
    defaultChildren: { default: [{ type: 'core:box', props: {}, style: {}, name: 'Column 1' }, { type: 'core:box', props: {}, name: 'Column 2' }] },
    defaultStyle: { gap: 'token:space.lg' },
  };
  const instance: BlockSchema = { type: 'library:instance', version: 1, label: 'Instance', module: 'library', fields: {}, slots: [{ name: 'default' }], internal: true };
  const schemas = schemaMap([box, columns, instance]);

  it('createNode instantiates default children with fresh ids and the default style', () => {
    const a = createNode(columns);
    const b = createNode(columns);
    expect(a.slots!.default).toHaveLength(2);
    expect(a.slots!.default!.map((n) => n.name)).toEqual(['Column 1', 'Column 2']);
    expect(a.style).toEqual({ gap: 'token:space.lg' });
    const ids = [a.id, b.id, ...a.slots!.default!.map((n) => n.id), ...b.slots!.default!.map((n) => n.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('instantiates layout presets with defaults, versions and slots', () => {
    const n = instantiateTemplate({ type: 'core:box', style: { display: 'grid' }, slots: { default: [{ type: 'core:box' }] } }, 'user', schemas);
    expect(n).toMatchObject({ type: 'core:box', v: 1, props: { tag: 'div' }, style: { display: 'grid' } });
    expect(n.slots!.default![0]!.slots).toEqual({ default: [] });
  });

  it('synced instances: canvas ids map to the instance and nothing can be dropped inside', () => {
    expect(canvasSelectableId('i1~p2')).toBe('i1');
    expect(canvasSelectableId('i1~p2~q')).toBe('i1');
    expect(canvasSelectableId('plain')).toBe('plain');
    expect(instanceNode('c1')).toMatchObject({ type: 'library:instance', props: { component: 'c1' }, slots: { default: [] } });
    expect(slotAccepts(schemas, 'library:instance', 'default', 'core:box')).toBe(false);
  });

  it('shareTree notices style states, presets, class names and layer names', () => {
    const a: PageNode = { id: 'r', type: 'core:page', props: {}, slots: { default: [{ id: 'x', type: 'core:box', props: {} }] } };
    for (const patch of [{ states: { hover: { color: 'red' } } }, { presets: ['p'] }, { className: 'c' }, { name: 'Hero' }]) {
      const b: PageNode = { ...a, slots: { default: [{ ...a.slots!.default![0]!, ...patch }] } };
      expect(shareTree(a, b)).not.toBe(a);
    }
  });
});
