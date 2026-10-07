import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTheme, defineBlock, f, h, renderTree, slot, walk, type PageNode } from '@modulo/core';
import { createPgliteDb, defineModule, invokeRoute, Kernel, type SiteContext } from '@modulo/kernel';
import ai, { extractJson, normalizeLayout, type GenerateResult } from '../src/index.ts';

/* Stand-in for the core block library (same names and fields as the real one). */
const leaf = (type: string, fields: Record<string, any>) => defineBlock({ type, version: 1, label: type, fields, render: (_p, c) => c.root('div') });
const box = (type: string, fields: Record<string, any>) => defineBlock({ type, version: 1, label: type, fields, slots: [{ name: 'default' }], render: (_p, c) => c.root('div', null, slot()) });
const core = defineModule({
  name: 'core',
  version: '1.0.0',
  kernel: '^1.0.0',
  blocks: [
    defineBlock({ type: 'core:page', version: 1, label: 'Page', internal: true, fields: {}, slots: [{ name: 'default' }], render: (_p, c) => c.root('main', null, slot()) }),
    box('core:section', { tag: f.select(['section', 'div', 'header', 'footer']) }),
    box('core:stack', { direction: f.select(['column', 'row']), gap: f.token('space', { default: 'token:space.md' }) }),
    box('core:grid', { columns: f.number({ default: 3, min: 1, max: 6 }), gap: f.token('space', { default: 'token:space.lg' }) }),
    defineBlock({
      type: 'core:heading',
      version: 1,
      label: 'Heading',
      fields: { text: f.text({ default: 'Heading' }), level: f.select(['h2', 'h1', 'h3', 'h4']), align: f.select(['left', 'center', 'right']) },
      render: (p, c) => c.root(p.level, null, p.text),
    }),
    leaf('core:text', { html: f.richtext({ default: '<p>Text</p>' }) }),
    leaf('core:image', { src: f.image(), alt: f.text() }),
    leaf('core:button', { label: f.text({ default: 'Go' }), href: f.link({ default: '#' }), variant: f.select(['primary', 'secondary', 'ghost']) }),
    leaf('core:hero', { title: f.text({ default: 'Title' }), subtitle: f.textarea(), ctaLabel: f.text(), ctaHref: f.link(), image: f.image() }),
    leaf('core:features', { items: f.list({ icon: f.text(), title: f.text(), text: f.textarea() }) }),
    leaf('core:testimonial', { quote: f.textarea(), author: f.text(), role: f.text() }),
    leaf('core:pricing', {
      plans: f.list({ name: f.text(), price: f.text(), period: f.text(), features: f.textarea(), ctaLabel: f.text(), ctaHref: f.link(), highlighted: f.boolean() }),
    }),
    leaf('core:faq', { items: f.list({ q: f.text(), a: f.textarea() }) }),
    leaf('core:spacer', { size: f.token('space', { default: 'token:space.lg' }) }),
  ],
});

let kernel: Kernel;
let ctx: SiteContext;
let siteId: string;
const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  kernel = await Kernel.create({ db: await createPgliteDb(), modules: [core, ai] });
  const site = await kernel.createSite({ slug: 'ai', name: 'AI Site', modules: { core: '*', ai: '*' } });
  siteId = site.id;
  ctx = await kernel.context(site.id, null, { sudo: true });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  await kernel.close();
});

const generate = async (prompt: string, mode?: string, c: SiteContext = ctx) => (await invokeRoute(c, { module: 'ai', method: 'POST', path: '/generate', body: { prompt, mode } })).body as GenerateResult;
const types = (t: PageNode) => {
  const out: string[] = [];
  walk(t, (n) => void out.push(n.type));
  return out.slice(1);
};
const topTypes = (t: PageNode) => t.slots!.default!.map((n) => n.type);
const assertValid = (t: PageNode) => {
  expect(ctx.runtime.blocks.validateTree(t)).toEqual([]);
  const ids = new Set<string>();
  walk(t, (n) => void ids.add(n.id));
  expect(ids.size).toBe(types(t).length + 1);
  expect(() => renderTree(t, { registry: ctx.runtime.blocks, theme: defaultTheme })).not.toThrow();
};

describe('fallback generator', () => {
  it('builds valid, prompt-specific pages from keywords', async () => {
    const bakery = await generate('A website for my bakery called Sweet Crumbs in Portland, with pricing, testimonials and a contact section');
    expect(bakery.source).toBe('fallback');
    assertValid(bakery.tree);
    expect(topTypes(bakery.tree)).toEqual(['core:hero', 'core:features', 'core:testimonial', 'core:pricing', 'core:spacer', 'core:section']);
    const hero = bakery.tree.slots!.default![0]!;
    expect(hero.props).toMatchObject({ title: 'Sweet Crumbs', subtitle: expect.stringContaining('Portland') });
    expect(JSON.stringify(bakery.tree)).toContain('🥐');

    const saas = await generate('Landing page for "Taskly", a SaaS app for teams. Include an FAQ and pricing plans.');
    assertValid(saas.tree);
    expect(topTypes(saas.tree)).toEqual(['core:hero', 'core:features', 'core:pricing', 'core:faq']);
    expect(saas.tree.slots!.default![0]!.props.title).toBe('Taskly');

    const plain = await generate('something nice');
    assertValid(plain.tree);
    expect(topTypes(plain.tree)).toEqual(['core:hero', 'core:features', 'core:testimonial', 'core:spacer', 'core:section']);
    expect(types(plain.tree)).toEqual(expect.arrayContaining(['core:stack', 'core:heading', 'core:text', 'core:button']));

    const gallery = await generate('photographer portfolio with a gallery and an about section');
    assertValid(gallery.tree);
    expect(types(gallery.tree)).toEqual(expect.arrayContaining(['core:grid', 'core:image']));
  });

  it('section mode returns one section, and output is deterministic and escaped', async () => {
    const s = await generate('an faq for my coffee shop', 'section');
    assertValid(s.tree);
    expect(topTypes(s.tree)).toEqual(['core:faq']);
    const a = await generate('Bakery called <script>x</script> in Rome, contact us');
    const b = await generate('Bakery called <script>x</script> in Rome, contact us');
    const strip = (t: PageNode) => JSON.parse(JSON.stringify(t).replace(/"ai_[a-z0-9]+"/g, '"id"'));
    expect(strip(a.tree)).toEqual(strip(b.tree));
    const html = renderTree(a.tree, { registry: ctx.runtime.blocks, theme: defaultTheme }).html;
    expect(html).not.toContain('<script>');
  });
});

describe('Claude adapter (mocked fetch)', () => {
  const reply = (text: string, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], ...extra }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  async function withKey() {
    await kernel.updateModuleSettings(siteId, 'ai', { apiKey: 'sk-test' });
    ctx = await kernel.context(siteId, null, { sudo: true });
  }

  it('sends a well-formed Messages API request and uses a valid structured response', async () => {
    await withKey();
    const layout = {
      title: 'Bloom',
      sections: [
        { type: 'core:hero', props: JSON.stringify({ title: 'Bloom Florist', subtitle: 'Flowers for every day', ctaLabel: 'Order', ctaHref: '/order' }), children: [] },
        {
          type: 'core:section',
          props: '{"tag":"section"}',
          children: [{ type: 'core:heading', props: '{"text":"Bouquets","level":"h2"}', children: [] }, { type: 'core:text', props: '{"html":"<p>Fresh <strong>daily</strong></p>"}', children: [] }],
        },
      ],
    };
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => reply(JSON.stringify(layout)));
    vi.stubGlobal('fetch', fetchMock);
    const res = await generate('florist page');
    expect(res.source).toBe('claude');
    expect(res.warnings).toEqual([]);
    expect(res.title).toBe('Bloom');
    assertValid(res.tree);
    expect(topTypes(res.tree)).toEqual(['core:hero', 'core:section']);
    expect(res.tree.slots!.default![0]!.props).toMatchObject({ title: 'Bloom Florist', ctaHref: '/order' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, output_config: { format: { type: 'json_schema' } } });
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('florist page') }]);
    expect(body.system).toContain('"type":"core:hero"');
    expect(body.system).not.toContain('core:page'); // internal blocks are not offered
  });

  it('accepts JSON wrapped in prose and code fences', async () => {
    await withKey();
    const text = 'Here is your layout:\n```json\n{"title":"X","sections":[{"type":"core:faq","props":{"items":[{"q":"Open Sundays?","a":"Yes"}]}}]}\n```\nEnjoy!';
    vi.stubGlobal('fetch', vi.fn(async () => reply(text)));
    const res = await generate('faq please', 'section');
    expect(res.source).toBe('claude');
    expect(res.tree.slots!.default![0]!).toMatchObject({ type: 'core:faq', props: { items: [{ q: 'Open Sundays?', a: 'Yes' }] } });
    expect(extractJson('prefix {"a":[1,2]} suffix')).toEqual({ a: [1, 2] });
    expect(() => extractJson('no json here')).toThrow(/valid JSON/);
  });

  it('drops unknown block types and invalid props with warnings', async () => {
    await withKey();
    const layout = {
      title: 'T',
      sections: [
        { type: 'core:carousel', props: '{}', children: [{ type: 'core:heading', props: '{"text":"Kept","level":"h9","color":"red"}' }] },
        { type: 'evil:iframe', props: '{"src":"https://x"}' },
        { type: 'core:button', props: '{"label":"Click","href":"javascript:alert(1)","variant":"Primary"}', children: [{ type: 'core:text', props: '{}' }] },
        { type: 'core:text', props: '{"html":"<p onclick=\\"x()\\">Hi<script>bad()</script></p>"}' },
        { type: 'core:hero', props: 'not json' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => reply(JSON.stringify(layout))));
    const res = await generate('anything');
    expect(res.source).toBe('claude');
    assertValid(res.tree);
    expect(topTypes(res.tree)).toEqual(['core:heading', 'core:button', 'core:text', 'core:hero']);
    const [heading, button, text] = res.tree.slots!.default!;
    expect(heading!.props).toEqual({ text: 'Kept', level: 'h2', align: 'left' });
    expect(button!.props).toEqual({ label: 'Click', href: '#', variant: 'primary' });
    expect(text!.props.html).toBe('<p>Hi</p>');
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        'Dropped unknown block type "core:carousel" (kept 1 child block)',
        'Dropped unknown block type "evil:iframe"',
        'core:heading: invalid value for "level"; used the default',
        'core:heading: ignored unknown prop "color"',
        'core:button: invalid value for "href"; used the default',
        'core:button cannot contain other blocks; its children were dropped',
        'core:hero: props were not a JSON object; used defaults',
      ]),
    );
  });

  it('falls back to the built-in generator on HTTP errors, refusals and empty layouts', async () => {
    await withKey();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 })));
    let res = await generate('bakery with faq');
    expect(res.source).toBe('fallback');
    expect(res.warnings[0]).toMatch(/AI generation failed \(Claude API returned HTTP 529: Overloaded\)/);
    assertValid(res.tree);
    expect(topTypes(res.tree)).toContain('core:faq');

    vi.stubGlobal('fetch', vi.fn(async () => reply('', { stop_reason: 'refusal', content: [] })));
    res = await generate('bakery');
    expect(res.source).toBe('fallback');
    expect(res.warnings[0]).toMatch(/declined/);

    vi.stubGlobal('fetch', vi.fn(async () => reply('{"title":"x","sections":[{"type":"nope:x","props":"{}"}]}')));
    res = await generate('bakery');
    expect(res.source).toBe('fallback');
    expect(res.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no usable blocks/)]));

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    res = await generate('bakery');
    expect(res.warnings[0]).toMatch(/network error/);
  });

  it('uses ANTHROPIC_API_KEY from the environment when no setting is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => reply('{"title":"x","sections":[{"type":"core:spacer","props":"{}"}]}'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await generate('x')).source).toBe('claude');
    expect((fetchMock.mock.calls[0]![1].headers as any)['x-api-key']).toBe('sk-env');
  });
});

describe('normalizeLayout limits and permissions', () => {
  it('caps depth and size', () => {
    let deep: any = { type: 'core:spacer', props: {} };
    for (let i = 0; i < 20; i++) deep = { type: 'core:section', props: {}, children: [deep] };
    const out = normalizeLayout({ sections: [deep] }, ctx.runtime.blocks, { maxDepth: 4 });
    let depth = 0;
    walk(out.tree, (_n, p) => void (p && depth++));
    expect(depth).toBe(4);
    expect(out.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/truncated/)]));
    const many = normalizeLayout({ sections: Array.from({ length: 500 }, () => ({ type: 'core:spacer' })) }, ctx.runtime.blocks);
    expect(many.tree.slots!.default!.length).toBe(150);
  });

  it('requires ai.use (granted to editors)', async () => {
    const ed = await kernel.createUser({ email: 'ed@x.io', password: 'password1' });
    const viewer = await kernel.createUser({ email: 'v@x.io', password: 'password1' });
    await kernel.addMember(siteId, ed.id, 'editor');
    await kernel.addMember(siteId, viewer.id, 'viewer');
    await expect(generate('x', undefined, await kernel.context(siteId, null))).rejects.toMatchObject({ status: 401 });
    await expect(generate('x', undefined, await kernel.context(siteId, viewer.id))).rejects.toMatchObject({ status: 403 });
    expect((await generate('bakery', undefined, await kernel.context(siteId, ed.id))).source).toBe('fallback');
    await expect(generate('', undefined, await kernel.context(siteId, ed.id))).rejects.toMatchObject({ status: 400 });
    await expect(generate('x', 'site', await kernel.context(siteId, ed.id))).rejects.toMatchObject({ status: 400 });
  });
});

void h;
