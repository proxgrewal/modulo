import { defineBlock, f, h, slot, type NodeTemplate, type LayoutPreset } from '@modulo/core';
import { href } from './blocks.ts';

/**
 * Layout primitives: with Box + the style system any layout can be built
 * (flex, grid, absolute overlays, sticky bars...). Columns/Icon/Embed/List
 * round out the set. Composite blocks (hero, features, ...) can be "unpacked"
 * into these primitives so every inner element becomes individually editable.
 */
const TAGS = ['div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'ul', 'ol', 'li', 'span', 'p', 'blockquote'];

export const box = defineBlock({
  type: 'core:box',
  version: 1,
  label: 'Box',
  category: 'Layout',
  icon: 'square',
  description: 'Generic container — style it as flex, grid, card, overlay… anything.',
  fields: {
    tag: f.select(TAGS, { label: 'HTML tag' }),
    href: f.link({ label: 'Link (makes the whole box clickable)' }),
    newTab: f.boolean({ label: 'Open link in new tab' }),
    ariaLabel: f.text({ label: 'Accessible label' }),
  },
  slots: [{ name: 'default' }],
  render: (p, ctx) => {
    if (p.href) return ctx.root('a', { href: href(p.href, ctx), class: 'c-box-link', target: p.newTab ? '_blank' : undefined, rel: p.newTab ? 'noopener noreferrer' : undefined, 'aria-label': p.ariaLabel || undefined }, slot('default'));
    return ctx.root(TAGS.includes(p.tag) ? p.tag : 'div', { 'aria-label': p.ariaLabel || undefined }, slot('default'));
  },
  css: '.c-box-link{display:block;color:inherit;text-decoration:none}',
});

const boxT = (children: NodeTemplate[] = [], style: Record<string, string> = {}, name?: string): NodeTemplate => ({ type: 'core:box', props: {}, style, name, slots: { default: children } });

export const columns = defineBlock({
  type: 'core:columns',
  version: 1,
  label: 'Columns',
  category: 'Layout',
  icon: 'grid',
  description: 'Side-by-side columns that stack on mobile. Add or remove boxes freely.',
  fields: {
    count: f.number({ label: 'Columns', default: 2, min: 1, max: 6 }),
    gap: f.token('space', { label: 'Gap', default: 'token:space.lg' }),
    align: f.select(['stretch', 'start', 'center', 'end'], { label: 'Vertical align' }),
    stackAt: f.select([{ value: 'sm', label: 'Mobile' }, { value: 'md', label: 'Tablet' }, { value: 'never', label: 'Never' }], { label: 'Stack below' }),
  },
  slots: [{ name: 'default' }],
  defaultChildren: { default: [boxT([], {}, 'Column 1'), boxT([], {}, 'Column 2')] },
  css: '.c-cols{display:grid}@media (max-width:1024px){.c-cols.st-md{grid-template-columns:1fr!important}}@media (max-width:640px){.c-cols.st-sm{grid-template-columns:1fr!important}}',
  render: (p, ctx) => {
    const n = Math.min(Math.max(Number(p.count) || 2, 1), 6);
    const gap = String(p.gap || 'token:space.lg').split('.')[1];
    const al: Record<string, string> = { stretch: 'stretch', start: 'start', center: 'center', end: 'end' };
    return ctx.root('div', { class: `c-cols st-${p.stackAt || 'sm'}`, style: `grid-template-columns:repeat(${n},minmax(0,1fr));gap:var(--space-${gap});align-items:${al[p.align] ?? 'stretch'}` }, slot('default'));
  },
});

export const icon = defineBlock({
  type: 'core:icon',
  version: 1,
  label: 'Icon',
  category: 'Basic',
  icon: 'star',
  description: 'An emoji or symbol, sized with the type scale.',
  fields: { glyph: f.text({ label: 'Icon (emoji or symbol)', default: '★', maxLength: 8 }), label: f.text({ label: 'Accessible label (empty = decorative)' }) },
  css: '.c-icon{display:inline-block;line-height:1;font-size:var(--fontSize-xl)}',
  render: (p, ctx) => ctx.root('span', { class: 'c-icon', role: p.label ? 'img' : undefined, 'aria-label': p.label || undefined, 'aria-hidden': p.label ? undefined : 'true' }, p.glyph),
});

export const list = defineBlock({
  type: 'core:list',
  version: 1,
  label: 'List',
  category: 'Text',
  icon: 'rows',
  fields: {
    items: f.list({ text: f.text({ label: 'Item', default: 'List item' }) }, { label: 'Items', itemLabel: 'text', default: [{ text: 'First point' }, { text: 'Second point' }, { text: 'Third point' }] }),
    style: f.select([{ value: 'check', label: '✓ Checks' }, { value: 'bullet', label: '• Bullets' }, { value: 'number', label: '1. Numbers' }, { value: 'none', label: 'Plain' }], { label: 'Marker' }),
  },
  css: '.c-list{padding-left:1.25em;margin:0}.c-list li{margin:.35em 0}.c-list.check,.c-list.none{list-style:none;padding-left:0}.c-list.check li::before{content:"✓ ";color:var(--color-primary);font-weight:700}',
  render: (p, ctx) => ctx.root(p.style === 'number' ? 'ol' : 'ul', { class: `c-list ${p.style || 'check'}` }, ...((p.items as any[]) ?? []).map((it) => h('li', null, it.text))),
});

const EMBED_HOSTS = ['www.google.com/maps/embed', 'maps.google.com', 'open.spotify.com/embed', 'codepen.io', 'www.youtube-nocookie.com/embed', 'player.vimeo.com/video', 'calendly.com', 'www.figma.com/embed', 'docs.google.com/forms'];

export const embed = defineBlock({
  type: 'core:embed',
  version: 1,
  label: 'Embed',
  category: 'Media',
  icon: 'video',
  description: 'Maps, Spotify, Calendly, CodePen, Figma, Google Forms (allow-listed, sandboxed).',
  fields: { url: f.link({ label: 'Embed URL (https)' }), title: f.text({ label: 'Title', default: 'Embedded content' }), height: f.number({ label: 'Height (px)', default: 400, min: 100, max: 2000 }) },
  css: '.c-embed{width:100%;border:0;border-radius:var(--radius-md)}.c-embed-ph{padding:var(--space-lg);border:1px dashed var(--color-border);color:var(--color-muted);text-align:center}',
  render: (p, ctx) => {
    const u = String(p.url ?? '');
    const ok = /^https:\/\//.test(u) && EMBED_HOSTS.some((h2) => u.slice(8).startsWith(h2));
    if (!ok) return ctx.root('div', { class: 'c-embed-ph' }, u ? 'This embed URL is not on the allow-list.' : 'Paste an embed URL.');
    return ctx.root('iframe', { class: 'c-embed', src: u, title: p.title, height: Math.min(Math.max(Number(p.height) || 400, 100), 2000), loading: 'lazy', sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms', referrerpolicy: 'strict-origin-when-cross-origin' });
  },
});

/* ───────── unpack composites into primitives (every part becomes editable) ───────── */

const H = (text: string, level = 'h2', style: Record<string, string> = {}): NodeTemplate => ({ type: 'core:heading', props: { text, level }, style });
const T = (html: string, style: Record<string, string> = {}): NodeTemplate => ({ type: 'core:text', props: { html }, style });
const B = (label: string, link: string, variant = 'primary'): NodeTemplate => ({ type: 'core:button', props: { label, href: link, variant } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export const PRIMITIVES: Record<string, (p: any) => NodeTemplate> = {
  'core:hero': (p) =>
    boxT(
      [
        boxT(
          [
            H(p.title, 'h1', { fontSize: 'token:fontSize.3xl', marginBottom: 'token:space.md' }),
            T(`<p>${esc(p.subtitle)}</p>`, { fontSize: 'token:fontSize.lg', color: 'token:color.muted' }),
            boxT([p.ctaLabel ? B(p.ctaLabel, p.ctaHref) : null, p.secondaryLabel ? B(p.secondaryLabel, p.secondaryHref, 'ghost') : null].filter(Boolean) as NodeTemplate[], { display: 'flex', gap: 'token:space.sm', wrap: 'wrap', marginTop: 'token:space.lg', ...(p.align === 'center' ? { justify: 'center' } : {}) }, 'Buttons'),
          ],
          p.align === 'center' ? { maxWidth: '760px', marginX: 'auto', align: 'center' } : {},
          'Copy',
        ),
        ...(p.image ? [{ type: 'core:image', props: { src: p.image, alt: '', rounded: true } } as NodeTemplate] : []),
      ],
      { display: 'grid', columns: p.image ? '2' : '1', gap: 'token:space.xl', items: 'center', paddingY: 'token:space.xxl', paddingX: 'token:space.md', maxWidth: '1120px', marginX: 'auto' },
      'Hero',
    ),
  'core:features': (p) =>
    boxT(
      [
        ...(p.title ? [H(p.title, 'h2', { align: 'center', marginBottom: 'token:space.lg' })] : []),
        boxT(
          ((p.items as any[]) ?? []).map((it) =>
            boxT([{ type: 'core:icon', props: { glyph: it.icon } }, H(it.title, 'h3', { fontSize: 'token:fontSize.lg' }), T(`<p>${esc(it.text)}</p>`, { color: 'token:color.muted' })], { padding: 'token:space.lg', radius: 'token:radius.md', background: 'token:color.surface' }, it.title),
          ),
          { display: 'grid', columns: String(Math.min(Math.max(Number(p.columns) || 3, 1), 4)), gap: 'token:space.lg' },
          'Grid',
        ),
      ],
      {},
      'Features',
    ),
  'core:testimonial': (p) =>
    boxT([T(`<p>“${esc(p.quote)}”</p>`, { fontSize: 'token:fontSize.xl', lineHeight: '1.4' }), T(`<p><strong>${esc(p.author)}</strong>${p.role ? ' — ' + esc(p.role) : ''}</p>`, { color: 'token:color.muted' })], { maxWidth: '760px', marginX: 'auto', align: 'center' }, 'Testimonial'),
  'core:pricing': (p) =>
    boxT(
      ((p.plans as any[]) ?? []).map((pl) =>
        boxT(
          [
            H(pl.name, 'h3'),
            T(`<p><strong>${esc(pl.price)}</strong> ${esc(pl.period)}</p>`, { fontSize: 'token:fontSize.xl' }),
            { type: 'core:list', props: { style: 'check', items: String(pl.features ?? '').split('\n').filter(Boolean).map((t) => ({ text: t })) }, style: { marginY: 'token:space.md' } },
            B(pl.ctaLabel, pl.ctaHref, pl.highlighted ? 'primary' : 'secondary'),
          ],
          { display: 'flex', direction: 'column', padding: 'token:space.lg', radius: 'token:radius.lg', border: pl.highlighted ? '2px solid var(--color-primary)' : '1px solid var(--color-border)' },
          pl.name,
        ),
      ),
      { display: 'grid', columns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 'token:space.lg' },
      'Pricing',
    ),
  'core:faq': (p) => boxT(((p.items as any[]) ?? []).flatMap((it) => [H(it.q, 'h3', { fontSize: 'token:fontSize.lg' }), T(`<p>${esc(it.a)}</p>`, { color: 'token:color.muted', marginBottom: 'token:space.md' })]), {}, 'FAQ'),
  'core:section': () => boxT([], { paddingY: 'token:space.xl', paddingX: 'token:space.md' }, 'Section'),
  'core:card': () => boxT([], { padding: 'token:space.lg', radius: 'token:radius.md', shadow: 'token:shadow.md' }, 'Card'),
};

/* ───────── layout presets (insert palette → "Layouts") ───────── */

const img = (alt = 'Image'): NodeTemplate => ({ type: 'core:image', props: { alt, ratio: '4/3', rounded: true } });

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'two-col', label: 'Two columns', category: 'Layouts', icon: 'grid', node: { type: 'core:columns', props: { count: 2 }, slots: { default: [boxT([H('Left column', 'h3'), T('<p>Write something here.</p>')]), boxT([H('Right column', 'h3'), T('<p>Write something here.</p>')])] } } },
  { id: 'three-col', label: 'Three columns', category: 'Layouts', icon: 'grid', node: { type: 'core:columns', props: { count: 3 }, slots: { default: [1, 2, 3].map((i) => boxT([H(`Column ${i}`, 'h3'), T('<p>Short description.</p>')])) } } },
  { id: 'sidebar', label: 'Sidebar + content', category: 'Layouts', icon: 'rows', node: boxT([boxT([H('Sidebar', 'h4'), { type: 'core:list', props: { style: 'none' } }], { padding: 'token:space.md', background: 'token:color.surface', radius: 'token:radius.md' }, 'Sidebar'), boxT([H('Main content', 'h2'), T('<p>Your main content goes here.</p>')], {}, 'Content')], { display: 'grid', columns: '1fr 3fr', gap: 'token:space.lg' }, 'Sidebar layout') },
  { id: 'split', label: 'Split: text + image', category: 'Layouts', icon: 'hero', node: boxT([boxT([H('A compelling headline', 'h2'), T('<p>Explain the benefit in a sentence or two.</p>'), B('Learn more', '#')], { display: 'flex', direction: 'column', gap: 'token:space.md', justify: 'center' }, 'Copy'), img()], { display: 'grid', columns: '2', gap: 'token:space.xl', items: 'center', paddingY: 'token:space.xl' }, 'Split') },
  { id: 'container', label: 'Centered container', category: 'Layouts', icon: 'square', node: boxT([H('Centered content', 'h2'), T('<p>A narrow, readable column.</p>')], { maxWidth: '720px', marginX: 'auto', paddingY: 'token:space.xl', paddingX: 'token:space.md' }, 'Container') },
  { id: 'card-grid', label: 'Card grid', category: 'Layouts', icon: 'card', node: boxT([1, 2, 3].map((i) => boxT([img(`Card ${i}`), H(`Card title ${i}`, 'h3', { fontSize: 'token:fontSize.lg', marginTop: 'token:space.md' }), T('<p>Card description.</p>', { color: 'token:color.muted' })], { padding: 'token:space.md', radius: 'token:radius.lg', shadow: 'token:shadow.md', background: 'token:color.bg' }, `Card ${i}`)), { display: 'grid', columns: '3', gap: 'token:space.lg' }, 'Card grid') },
  {
    id: 'banner', label: 'Image banner', category: 'Sections', icon: 'image', description: 'Full-width background image with overlay and centered text.',
    node: boxT([H('Big bold statement', 'h1', { color: '#ffffff' }), T('<p>Supporting line over the image.</p>', { color: '#ffffff' }), B('Call to action', '#')], { display: 'flex', direction: 'column', items: 'center', justify: 'center', gap: 'token:space.md', minHeight: '420px', paddingX: 'token:space.md', align: 'center', background: '#1b1b1f', backgroundImage: '', overlay: 'rgba(0,0,0,.35)' }, 'Banner'),
  },
  { id: 'stats', label: 'Stats row', category: 'Sections', icon: 'features', node: boxT([['120k', 'Visitors'], ['98%', 'Satisfaction'], ['24/7', 'Support'], ['50+', 'Countries']].map(([n, l]) => boxT([H(n!, 'h2', { fontSize: 'token:fontSize.2xl', marginBottom: '0' }), T(`<p>${l}</p>`, { color: 'token:color.muted' })], { align: 'center' }, l)), { display: 'grid', columns: '4', gap: 'token:space.lg', paddingY: 'token:space.xl' }, 'Stats') },
  { id: 'cta', label: 'Call-to-action band', category: 'Sections', icon: 'button', node: boxT([H('Ready to get started?', 'h2', { color: 'token:color.primary-contrast', marginBottom: '0' }), B('Start now', '#', 'secondary')], { display: 'flex', justify: 'between', items: 'center', wrap: 'wrap', gap: 'token:space.md', padding: 'token:space.xl', radius: 'token:radius.lg', background: 'token:color.primary' }, 'CTA') },
  { id: 'logos', label: 'Logo strip', category: 'Sections', icon: 'image', node: boxT([1, 2, 3, 4, 5].map((i) => ({ type: 'core:image', props: { alt: `Logo ${i}` }, style: { width: '120px', opacity: '0.7' } })), { display: 'flex', wrap: 'wrap', justify: 'center', items: 'center', gap: 'token:space.xl', paddingY: 'token:space.lg' }, 'Logos') },
  { id: 'sticky-bar', label: 'Sticky announcement bar', category: 'Sections', icon: 'rows', node: boxT([T('<p><strong>New:</strong> free shipping on all orders this week.</p>', { marginBottom: '0' })], { position: 'sticky', top: '0', zIndex: '30', paddingY: 'token:space.sm', align: 'center', background: 'token:color.accent', color: '#ffffff' }, 'Announcement') },
];
