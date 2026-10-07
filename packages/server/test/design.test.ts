import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyPage, instantiate, type PageNode } from '@modulo/core';
import { createPgliteDb, Kernel } from '@modulo/kernel';
import core, { LAYOUT_PRESETS } from '../../../modules/core/src/index.ts';
import pages from '../../../modules/pages/src/index.ts';
import media from '../../../modules/media/src/index.ts';
import library from '../../../modules/library/src/index.ts';
import { createApp, LocalStorage } from '../src/index.ts';

/** Style system, layout presets, unpacking and the component library through the HTTP API. */
let kernel: Kernel;
let app: ReturnType<typeof createApp>['app'];
let dir: string;
let cookie = '';
let homeId = '';

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc?.startsWith('modulo_session=')) cookie = sc.split(';')[0]!;
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}
const publishTree = async (tree: PageNode) => {
  expect((await call('PUT', `/api/sites/d/m/pages/pages/${homeId}/draft`, { tree })).status).toBe(200);
  expect((await call('POST', `/api/sites/d/m/pages/pages/${homeId}/publish`, {})).status).toBe(200);
  await kernel.drain();
  const res = await app.request('/s/d');
  return res.text();
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'modulo-design-'));
  kernel = await Kernel.create({ db: await createPgliteDb(), modules: [core, pages, media, library] });
  ({ app } = createApp({ kernel, storage: new LocalStorage(dir), openSignup: true }));
  await call('POST', '/api/auth/signup', { email: 'd@x.io', password: 'design-pass-1' });
  await call('POST', '/api/sites', { slug: 'd', name: 'Design' });
  homeId = (await call('GET', '/api/sites/d/m/pages/pages')).data[0].id;
});
afterAll(async () => {
  await kernel.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('design system', () => {
  it('exposes the style catalog, breakpoints, states and layout presets to the editor', async () => {
    const rt = (await call('GET', '/api/sites/d/runtime')).data;
    expect(rt.styleCatalog.length).toBeGreaterThan(60);
    expect(rt.styleCatalog.find((p: any) => p.key === 'columns')).toMatchObject({ group: 'layout', control: 'tracks', when: 'grid' });
    expect(rt.styleCatalog[0].css).toBeUndefined();
    expect(Object.keys(rt.breakpoints)).toEqual(['md', 'sm', 'xs']);
    expect(rt.styleStates).toEqual(['hover', 'focus', 'active']);
    expect(rt.presets.map((p: any) => p.id)).toContain('core.card-grid');
    expect(rt.blocks.find((b: any) => b.type === 'core:hero').unpackable).toBe(true);
    expect(rt.blocks.find((b: any) => b.type === 'core:box')).toBeTruthy();
  });

  it('every layout preset and every unpacked composite is a valid document', async () => {
    const rt = await kernel.runtime((await kernel.getSite('d')).id);
    for (const p of LAYOUT_PRESETS) {
      const problems = rt.blocks.validateTree({ ...emptyPage(), slots: { default: [instantiate(p.node)] } });
      expect(problems, p.id).toEqual([]);
    }
    for (const b of rt.blocks.list().filter((x) => x.toPrimitives)) {
      const node = rt.blocks.create(b.type, 'x');
      const r = await call('POST', '/api/sites/d/blocks/unpack', { node: { ...node, style: { marginTop: '10px' } } });
      expect(r.status, b.type).toBe(200);
      expect(rt.blocks.validateTree({ ...emptyPage(), slots: { default: [r.data.node] } }), b.type).toEqual([]);
      expect(r.data.node.style.marginTop).toBe('10px');
    }
  });

  it('renders full styles: grid + breakpoints + hover state + site presets + custom CSS', async () => {
    const saved = await call('PUT', '/api/sites/d/styles', {
      presets: { 'card-soft': { label: 'Soft card', style: { padding: '24px', radius: 'token:radius.lg' }, states: { hover: { shadow: 'token:shadow.lg' } } } },
      customCss: '.brand-glow{box-shadow:0 0 40px #2f5bea55}</style><script>alert(1)</script>',
    });
    expect(saved.status).toBe(200);
    const bad = await call('PUT', '/api/sites/d/styles', { presets: { 'Bad Name': {}, ok: { style: { width: 'expression(alert(1))' } } } });
    expect(bad.status).toBe(400);
    const tree: PageNode = {
      ...emptyPage(),
      slots: {
        default: [
          {
            id: 'g',
            type: 'core:box',
            props: {},
            presets: ['card-soft'],
            className: 'brand-glow',
            style: { display: 'grid', columns: '3', gap: 'token:space.lg' },
            responsive: { sm: { columns: '1' } },
            states: { hover: { transform: 'translateY(-4px)' } },
            slots: { default: [{ id: 'h', type: 'core:heading', props: { text: 'Styled' }, style: { fontWeight: '800', letterSpacing: '-0.02em' } }] },
          },
        ],
      },
    };
    const html = await publishTree(tree);
    const classes = /<div class="([^"]*brand-glow[^"]*)"/.exec(html)![1]!.split(' ');
    expect(classes[0]).toBe('s-card-soft'); // preset first, atomic overrides after
    for (const prefix of ['m-display-', 'm-columns-', 'm-gap-', 'm-sm-columns-', 'm-h-transform-']) expect(classes.some((c) => c.startsWith(prefix)), prefix).toBe(true);
    expect(classes.at(-1)).toBe('brand-glow');
    expect(html).toContain('.s-card-soft:hover{box-shadow:var(--shadow-lg)}');
    expect(html).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    expect(html).toContain('letter-spacing:-0.02em');
    expect(html).toContain('.brand-glow{box-shadow:0 0 40px #2f5bea55}');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('blocks that render buttons ship the button styles themselves (hero without a Button block)', async () => {
    const html = await publishTree({ ...emptyPage(), slots: { default: [{ id: 'hero', type: 'core:hero', props: { title: 'Hi', ctaLabel: 'Go', ctaHref: '#' } }] } });
    expect(html).toContain('<a class="c-btn primary lg"');
    expect(html).toContain('.c-btn.primary{background:var(--color-primary)');
  });

  it('component library: synced instances update everywhere when the component changes', async () => {
    const comp = await call('POST', '/api/sites/d/m/library/components', {
      name: 'Promo',
      category: 'Marketing',
      node: { id: 'p1', type: 'core:box', props: {}, slots: { default: [{ id: 'p2', type: 'core:heading', props: { text: 'Summer sale' } }] } },
    });
    expect(comp.status).toBe(201);
    const inst = (id: string): PageNode => ({ id, type: 'library:instance', props: { component: comp.data.id }, slots: { default: [] } });
    let html = await publishTree({ ...emptyPage(), slots: { default: [inst('i1'), inst('i2')] } });
    expect(html.match(/Summer sale/g)).toHaveLength(2);
    // Edit the component once -> both instances change.
    await call('PUT', `/api/sites/d/m/library/components/${comp.data.id}`, { node: { id: 'p1', type: 'core:box', props: {}, slots: { default: [{ id: 'p2', type: 'core:heading', props: { text: 'Winter sale' } }] } } });
    await kernel.drain();
    html = await (await app.request('/s/d')).text();
    expect(html.match(/Winter sale/g)).toHaveLength(2);
    // Editor render maps expanded ids as <instance>~<node>.
    const r = await call('POST', '/api/sites/d/render', { tree: { ...emptyPage(), slots: { default: [inst('i9')] } } });
    expect(r.data.html).toContain('data-node-id="i9~p2"');
    // Invalid component trees are rejected; self-nesting is cut, not infinite.
    expect((await call('POST', '/api/sites/d/m/library/components', { name: 'x', node: { id: 'z', type: 'nope:block', props: {} } })).status).toBe(400);
    const selfRef = await call('POST', '/api/sites/d/m/library/components', { name: 'loop', node: { id: 'l', type: 'core:box', props: {}, slots: { default: [] } } });
    await call('PUT', `/api/sites/d/m/library/components/${selfRef.data.id}`, { node: { id: 'l', type: 'library:instance', props: { component: selfRef.data.id }, slots: { default: [] } } });
    const loop = await call('POST', '/api/sites/d/render', { tree: { ...emptyPage(), slots: { default: [{ id: 'L', type: 'library:instance', props: { component: selfRef.data.id }, slots: { default: [] } }] } } });
    expect(loop.status).toBe(200);
  });

  it('layout (header/footer) can be styled per breakpoint and state via patch ops', async () => {
    const r = await call('PUT', '/api/sites/d/layout', {
      ops: [
        { op: 'setStyle', target: 'header', style: { background: '#111111', color: '#ffffff' } },
        { op: 'setStyle', target: 'header', bp: 'sm', style: { paddingY: '4px' } },
        { op: 'setStyle', target: 'logo', state: 'hover', style: { opacity: '0.8' } },
        { op: 'setField', target: 'footer', field: 'presets', value: ['card-soft'] },
      ],
    });
    expect(r.data.failures).toEqual([]);
    await kernel.drain();
    const html = await (await app.request('/s/d')).text();
    expect(html).toContain('background:#111111');
    expect(html).toMatch(/@media \(max-width:640px\)\{[^}]*padding-top:4px/);
    expect(html).toContain(':hover{opacity:0.8}');
    expect(html).toMatch(/<footer class="[^"]*s-card-soft/);
  });
});
