import { defineModule } from '@modulo/kernel';
import { defineBlock, defineModel, f, h, mf, raw, slot } from '@modulo/core';

/** Minimal stand-ins for the real `core` and `pages` modules (built elsewhere). */
export const coreStub = defineModule({
  name: 'core',
  version: '1.0.0',
  kernel: '^1.0.0',
  required: true,
  blocks: [
    defineBlock({ type: 'core:section', version: 1, label: 'Section', fields: {}, slots: [{ name: 'default' }], render: (_p, c) => c.root('section', null, slot('default')) }),
    defineBlock({
      type: 'core:heading',
      version: 1,
      label: 'Heading',
      fields: { text: f.text(), level: f.select(['h2', 'h1', 'h3', 'h4']) },
      render: (p: any, c) => c.root(p.level || 'h2', null, p.text),
    }),
    defineBlock({ type: 'core:text', version: 1, label: 'Text', fields: { html: f.richtext() }, render: (p: any, c) => c.root('div', null, raw(p.html)) }),
    defineBlock({ type: 'core:link', version: 1, label: 'Link', fields: { label: f.text(), href: f.link() }, render: (p: any, c) => c.root('a', { href: p.href }, p.label) }),
    defineBlock({ type: 'core:image', version: 1, label: 'Image', fields: { src: f.image(), alt: f.text() }, render: (p: any, c) => c.root('img', { src: p.src, alt: p.alt }) }),
    defineBlock({
      type: 'core:button',
      version: 1,
      label: 'Button',
      fields: { label: f.text(), href: f.link(), variant: f.select(['primary', 'secondary']) },
      render: (p: any, c) => c.root('a', { href: p.href }, p.label),
    }),
    defineBlock({ type: 'core:outlet', version: 1, label: 'Outlet', fields: {}, render: (_p, c) => c.root('main', null) }),
    defineBlock({
      type: 'core:header',
      version: 1,
      label: 'Header',
      fields: {},
      slots: [{ name: 'brand' }, { name: 'nav' }, { name: 'actions' }],
      render: (_p, c) => c.root('header', null, slot('brand'), h('nav', null, slot('nav')), slot('actions')),
    }),
    defineBlock({ type: 'core:footer', version: 1, label: 'Footer', fields: {}, slots: [{ name: 'default' }], render: (_p, c) => c.root('footer', null, slot('default')) }),
  ],
  templates: [
    {
      id: 'core:layout',
      tree: {
        id: 'layout',
        type: 'core:page',
        props: {},
        slots: {
          default: [
            { id: 'header', type: 'core:header', props: {}, slots: { brand: [], nav: [], actions: [] } },
            { id: 'main', type: 'core:outlet', props: {} },
            { id: 'footer', type: 'core:footer', props: {}, slots: { default: [] } },
          ],
        },
      },
    },
  ],
});

export const pagesStub = defineModule({
  name: 'pages',
  version: '1.0.0',
  kernel: '^1.0.0',
  models: [
    defineModel({
      name: 'pages.page',
      titleField: 'title',
      fields: {
        title: mf.string({ required: true }),
        path: mf.string({ required: true, unique: true }),
        status: mf.enum(['draft', 'published'], { default: 'draft' }),
        draft: mf.json(),
        published: mf.json(),
        published_at: mf.datetime(),
        description: mf.text(),
      },
      access: { read: 'public' },
    }),
  ],
  permissions: [{ key: 'pages.manage', label: 'Manage pages' }],
  grants: { editor: ['pages.manage'] },
});

/** Tiny well-formedness check for generated XML: balanced tags, legal entities, no raw '<' or '&'. */
export function assertWellFormedXml(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[6]) throw new Error(`Stray '<' at ${m.index}: ${body.slice(m.index, m.index + 40)}`);
    const text = m[5] ?? m[3] ?? '';
    const amp = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(text);
    if (amp) throw new Error(`Unescaped '&' near: ${text.slice(Math.max(0, amp.index - 20), amp.index + 20)}`);
    if (m[5]) continue;
    if (m[4]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`Mismatched </${m[2]}>, expected </${open}>`);
    } else stack.push(m[2]!);
  }
  if (stack.length) throw new Error(`Unclosed tags: ${stack.join(',')}`);
}
