import { defineBlock, f, h, raw, sanitizeHtml, slot, type RenderContext } from '@modulo/core';

/** Prefix root-relative links with the site base ("" in production, "/s/<slug>" in dev). */
export function href(url: unknown, ctx: RenderContext): string {
  const u = String(url ?? '');
  if (u.startsWith('/') && !u.startsWith('//')) return `${(ctx.scope.base as string) ?? ''}${u}` || '/';
  return u || '#';
}

const space = (label = 'Gap', d = 'token:space.md') => f.token('space', { label, default: d });

/** Shared by every block that renders buttons (button, hero, pricing). Rules are de-duplicated per page. */
export const BUTTON_CSS =
    '.c-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5em;border-radius:var(--radius-md);font-weight:600;text-decoration:none;border:2px solid transparent;padding:.7em 1.3em;line-height:1.1;transition:filter .15s}.c-btn:hover{filter:brightness(1.08)}' +
    '.c-btn.primary{background:var(--color-primary);color:var(--color-primary-contrast)}.c-btn.secondary{border-color:var(--color-primary);color:var(--color-primary);background:transparent}.c-btn.ghost{color:var(--color-text);background:transparent}' +
    '.c-btn.sm{font-size:var(--fontSize-sm);padding:.5em 1em}.c-btn.lg{font-size:var(--fontSize-lg)}';

export const page = defineBlock({
  type: 'core:page',
  version: 1,
  label: 'Page',
  internal: true,
  fields: {},
  slots: [{ name: 'default' }],
  render: (_p, ctx) => ctx.root('div', { class: 'm-page' }, slot('default')),
});

export const section = defineBlock({
  type: 'core:section',
  version: 1,
  label: 'Section',
  category: 'Layout',
  icon: 'square',
  description: 'Full-width band with a centred content column.',
  fields: {
    tag: f.select(['section', 'div', 'header', 'footer', 'aside'], { label: 'HTML tag' }),
    width: f.select([{ value: 'normal', label: 'Normal' }, { value: 'narrow', label: 'Narrow' }, { value: 'wide', label: 'Wide' }, { value: 'full', label: 'Full' }], { label: 'Content width' }),
    background: f.token('color', { label: 'Background' }),
    padding: f.token('space', { label: 'Vertical padding', default: 'token:space.xl' }),
  },
  slots: [{ name: 'default', label: 'Content' }],
  css:
    '.c-section{padding-left:var(--space-md);padding-right:var(--space-md)}.c-section>.c-inner{margin:0 auto;max-width:1120px}' +
    '.c-section.w-narrow>.c-inner{max-width:720px}.c-section.w-wide>.c-inner{max-width:1360px}.c-section.w-full>.c-inner{max-width:none}',
  render: (p, ctx) => {
    const style = [p.background ? `background:var(--color-${String(p.background).split('.')[1]})` : '', p.padding ? `padding-top:var(--space-${String(p.padding).split('.')[1]});padding-bottom:var(--space-${String(p.padding).split('.')[1]})` : '']
      .filter(Boolean)
      .join(';');
    return ctx.root(p.tag || 'section', { class: `c-section w-${p.width || 'normal'}`, style: style || undefined }, h('div', { class: 'c-inner' }, slot('default')));
  },
});

export const stack = defineBlock({
  type: 'core:stack',
  version: 1,
  label: 'Stack',
  category: 'Layout',
  icon: 'rows',
  description: 'Lays children out in a row or column.',
  fields: {
    direction: f.select(['column', 'row'], { label: 'Direction' }),
    gap: space(),
    align: f.select(['stretch', 'start', 'center', 'end'], { label: 'Align' }),
    justify: f.select(['start', 'center', 'end', 'between'], { label: 'Justify' }),
    wrap: f.boolean({ label: 'Wrap', default: true }),
  },
  slots: [{ name: 'default' }],
  css: '.c-stack{display:flex}.c-stack.row{flex-direction:row}.c-stack.column{flex-direction:column}.c-stack.wrap{flex-wrap:wrap}@media (max-width:640px){.c-stack.row{flex-direction:column}}',
  render: (p, ctx) => {
    const j: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };
    const a: Record<string, string> = { stretch: 'stretch', start: 'flex-start', center: 'center', end: 'flex-end' };
    const gap = String(p.gap || 'token:space.md').split('.')[1];
    return ctx.root(
      'div',
      { class: `c-stack ${p.direction === 'row' ? 'row' : 'column'}${p.wrap ? ' wrap' : ''}`, style: `gap:var(--space-${gap});align-items:${a[p.align] ?? 'stretch'};justify-content:${j[p.justify] ?? 'flex-start'}` },
      slot('default'),
    );
  },
});

export const grid = defineBlock({
  type: 'core:grid',
  version: 1,
  label: 'Grid',
  category: 'Layout',
  icon: 'grid',
  description: 'Responsive equal-width columns.',
  fields: { columns: f.number({ label: 'Columns', default: 3, min: 1, max: 6 }), gap: space('Gap', 'token:space.lg') },
  slots: [{ name: 'default' }],
  css: '.c-grid{display:grid}@media (max-width:1024px){.c-grid.cols-4,.c-grid.cols-5,.c-grid.cols-6{grid-template-columns:repeat(2,minmax(0,1fr))!important}}@media (max-width:640px){.c-grid{grid-template-columns:1fr!important}}',
  render: (p, ctx) => {
    const cols = Math.min(Math.max(Number(p.columns) || 3, 1), 6);
    const gap = String(p.gap || 'token:space.lg').split('.')[1];
    return ctx.root('div', { class: `c-grid cols-${cols}`, style: `grid-template-columns:repeat(${cols},minmax(0,1fr));gap:var(--space-${gap})` }, slot('default'));
  },
});

export const card = defineBlock({
  type: 'core:card',
  version: 1,
  label: 'Card',
  category: 'Layout',
  icon: 'card',
  fields: { elevated: f.boolean({ label: 'Shadow', default: true }) },
  slots: [{ name: 'default' }],
  css: '.c-card{background:var(--color-bg);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-lg)}.c-card.elev{box-shadow:var(--shadow-md);border-color:transparent}',
  render: (p, ctx) => ctx.root('div', { class: `c-card${p.elevated ? ' elev' : ''}` }, slot('default')),
});

export const heading = defineBlock({
  type: 'core:heading',
  version: 1,
  label: 'Heading',
  category: 'Text',
  icon: 'heading',
  fields: {
    text: f.text({ label: 'Text', default: 'Heading' }),
    level: f.select(['h2', 'h1', 'h3', 'h4'], { label: 'Level' }),
    align: f.select(['left', 'center', 'right'], { label: 'Align' }),
  },
  css: '.c-h1{font-size:var(--fontSize-3xl)}.c-h2{font-size:var(--fontSize-2xl)}.c-h3{font-size:var(--fontSize-xl)}.c-h4{font-size:var(--fontSize-lg)}@media (max-width:640px){.c-h1{font-size:var(--fontSize-2xl)}.c-h2{font-size:var(--fontSize-xl)}}',
  render: (p, ctx) => {
    const lvl = ['h1', 'h2', 'h3', 'h4'].includes(p.level) ? p.level : 'h2';
    return ctx.root(lvl, { class: `c-${lvl}`, style: p.align && p.align !== 'left' ? `text-align:${p.align}` : undefined }, p.text);
  },
});

export const text = defineBlock({
  type: 'core:text',
  version: 1,
  label: 'Text',
  category: 'Text',
  icon: 'text',
  fields: { html: f.richtext({ label: 'Text', default: '<p>Write something great.</p>' }), align: f.select(['left', 'center', 'right'], { label: 'Align' }), muted: f.boolean({ label: 'Muted' }) },
  css: '.c-text>:last-child{margin-bottom:0}.c-text.muted{color:var(--color-muted)}',
  render: (p, ctx) =>
    ctx.root('div', { class: `c-text${p.muted ? ' muted' : ''}`, style: p.align && p.align !== 'left' ? `text-align:${p.align}` : undefined }, raw(sanitizeHtml(String(p.html ?? '')))),
});

export const image = defineBlock({
  type: 'core:image',
  version: 1,
  label: 'Image',
  category: 'Media',
  icon: 'image',
  fields: {
    src: f.image({ label: 'Image' }),
    alt: f.text({ label: 'Alt text' }),
    ratio: f.select(['auto', '16/9', '4/3', '1/1', '3/4'], { label: 'Aspect ratio' }),
    rounded: f.boolean({ label: 'Rounded' }),
    caption: f.text({ label: 'Caption' }),
  },
  css: '.c-image{margin:0}.c-image img{width:100%;object-fit:cover}.c-image.rounded img{border-radius:var(--radius-md)}.c-image figcaption{color:var(--color-muted);font-size:var(--fontSize-sm);margin-top:var(--space-sm)}.c-image .ph{background:var(--color-surface);aspect-ratio:16/9;display:grid;place-items:center;color:var(--color-muted)}',
  render: (p, ctx) =>
    ctx.root(
      'figure',
      { class: `c-image${p.rounded ? ' rounded' : ''}` },
      p.src
        ? h('img', { src: p.src, alt: p.alt ?? '', loading: 'lazy', decoding: 'async', style: p.ratio && p.ratio !== 'auto' ? `aspect-ratio:${p.ratio}` : undefined })
        : h('div', { class: 'ph', role: 'img', 'aria-label': p.alt || 'Image placeholder' }, 'Image'),
      p.caption ? h('figcaption', null, p.caption) : null,
    ),
});

export const button = defineBlock({
  type: 'core:button',
  version: 1,
  label: 'Button',
  category: 'Basic',
  icon: 'button',
  fields: {
    label: f.text({ label: 'Label', default: 'Get started' }),
    href: f.link({ label: 'Link', default: '#' }),
    variant: f.select(['primary', 'secondary', 'ghost'], { label: 'Style' }),
    size: f.select(['md', 'sm', 'lg'], { label: 'Size' }),
    newTab: f.boolean({ label: 'Open in new tab' }),
  },
  css: BUTTON_CSS,
  render: (p, ctx) =>
    ctx.root(
      'a',
      { class: `c-btn ${p.variant || 'primary'} ${p.size || 'md'}`, href: href(p.href, ctx), target: p.newTab ? '_blank' : undefined, rel: p.newTab ? 'noopener noreferrer' : undefined },
      p.label,
    ),
});

export const link = defineBlock({
  type: 'core:link',
  version: 1,
  label: 'Link',
  category: 'Basic',
  icon: 'link',
  fields: { label: f.text({ label: 'Label', default: 'Link' }), href: f.link({ label: 'URL', default: '/' }) },
  css: '.c-link{color:inherit;text-decoration:none;font-weight:500}.c-link:hover{color:var(--color-primary)}',
  render: (p, ctx) => ctx.root('a', { class: 'c-link', href: href(p.href, ctx) }, p.label),
});

export const spacer = defineBlock({
  type: 'core:spacer',
  version: 1,
  label: 'Spacer',
  category: 'Layout',
  icon: 'spacer',
  fields: { size: f.token('space', { label: 'Size', default: 'token:space.lg' }) },
  render: (p, ctx) => ctx.root('div', { 'aria-hidden': 'true', style: `height:var(--space-${String(p.size || 'token:space.lg').split('.')[1]})` }),
});

export const divider = defineBlock({
  type: 'core:divider',
  version: 1,
  label: 'Divider',
  category: 'Layout',
  icon: 'divider',
  fields: {},
  css: '.c-divider{border:0;border-top:1px solid var(--color-border);margin:var(--space-md) 0}',
  render: (_p, ctx) => ctx.root('hr', { class: 'c-divider' }),
});

function embedUrl(url: string): string | null {
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/.exec(url);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = /vimeo\.com\/(\d+)/.exec(url);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return null;
}

export const video = defineBlock({
  type: 'core:video',
  version: 1,
  label: 'Video',
  category: 'Media',
  icon: 'video',
  description: 'YouTube or Vimeo embed.',
  fields: { url: f.link({ label: 'YouTube / Vimeo URL' }), title: f.text({ label: 'Title', default: 'Video' }) },
  css: '.c-video{aspect-ratio:16/9;width:100%;border:0;border-radius:var(--radius-md);background:#000}',
  render: (p, ctx) => {
    const src = embedUrl(String(p.url ?? ''));
    return src
      ? ctx.root('iframe', { class: 'c-video', src, title: p.title, loading: 'lazy', allow: 'fullscreen; picture-in-picture', allowfullscreen: true })
      : ctx.root('div', { class: 'c-video' }, '');
  },
});

export const hero = defineBlock({
  type: 'core:hero',
  version: 1,
  label: 'Hero',
  category: 'Sections',
  icon: 'hero',
  description: 'Headline, supporting text, call to action and optional image.',
  fields: {
    title: f.text({ label: 'Title', default: 'Build something people love' }),
    subtitle: f.textarea({ label: 'Subtitle', default: 'A short sentence that explains the value of what you offer.' }),
    ctaLabel: f.text({ label: 'Button label', default: 'Get started' }),
    ctaHref: f.link({ label: 'Button link', default: '#' }),
    secondaryLabel: f.text({ label: 'Secondary label' }),
    secondaryHref: f.link({ label: 'Secondary link' }),
    image: f.image({ label: 'Image' }),
    align: f.select(['left', 'center'], { label: 'Align' }),
  },
  slots: [{ name: 'default', label: 'Extra content' }],
  css:
    BUTTON_CSS +
    '.c-hero{padding:var(--space-xxl) var(--space-md);}.c-hero .in{max-width:1120px;margin:0 auto;display:grid;gap:var(--space-xl);align-items:center}.c-hero.img .in{grid-template-columns:1.1fr 1fr}' +
    '.c-hero.center{text-align:center}.c-hero.center .copy{max-width:760px;margin:0 auto}.c-hero h1{font-size:var(--fontSize-3xl);margin-bottom:var(--space-md)}.c-hero p{font-size:var(--fontSize-lg);color:var(--color-muted)}' +
    '.c-hero .ctas{display:flex;gap:var(--space-sm);flex-wrap:wrap;margin-top:var(--space-lg)}.c-hero.center .ctas{justify-content:center}.c-hero img{border-radius:var(--radius-lg);width:100%}' +
    '@media (max-width:1024px){.c-hero.img .in{grid-template-columns:1fr}.c-hero h1{font-size:var(--fontSize-2xl)}}',
  render: (p, ctx) =>
    ctx.root(
      'section',
      { class: `c-hero ${p.align === 'center' ? 'center' : ''}${p.image ? ' img' : ''}` },
      h(
        'div',
        { class: 'in' },
        h(
          'div',
          { class: 'copy' },
          h('h1', null, p.title),
          p.subtitle ? h('p', null, p.subtitle) : null,
          h(
            'div',
            { class: 'ctas' },
            p.ctaLabel ? h('a', { class: 'c-btn primary lg', href: href(p.ctaHref, ctx) }, p.ctaLabel) : null,
            p.secondaryLabel ? h('a', { class: 'c-btn ghost lg', href: href(p.secondaryHref, ctx) }, p.secondaryLabel) : null,
          ),
          slot('default'),
        ),
        p.image ? h('img', { src: p.image, alt: '', loading: 'eager' }) : null,
      ),
    ),
});

export const features = defineBlock({
  type: 'core:features',
  version: 1,
  label: 'Features',
  category: 'Sections',
  icon: 'features',
  fields: {
    title: f.text({ label: 'Title', default: 'Why people choose us' }),
    columns: f.number({ label: 'Columns', default: 3, min: 1, max: 4 }),
    items: f.list(
      { icon: f.text({ label: 'Icon (emoji)', default: '✦' }), title: f.text({ label: 'Title', default: 'Feature' }), text: f.textarea({ label: 'Text', default: 'Describe the benefit.' }) },
      {
        label: 'Items',
        itemLabel: 'title',
        default: [
          { icon: '⚡', title: 'Fast', text: 'Pages ship almost no JavaScript.' },
          { icon: '🧩', title: 'Modular', text: 'Install only what you need.' },
          { icon: '🎨', title: 'On brand', text: 'Design tokens keep everything consistent.' },
        ],
      },
    ),
  },
  css: '.c-features{display:grid;gap:var(--space-lg)}.c-features .it{padding:var(--space-lg);border-radius:var(--radius-md);background:var(--color-surface)}.c-features .ic{font-size:1.75rem;margin-bottom:var(--space-sm)}.c-features h3{font-size:var(--fontSize-lg)}.c-features p{color:var(--color-muted);margin:0}@media (max-width:640px){.c-features{grid-template-columns:1fr!important}}',
  render: (p, ctx) => {
    const cols = Math.min(Math.max(Number(p.columns) || 3, 1), 4);
    return ctx.root(
      'div',
      null,
      p.title ? h('h2', { class: 'c-h2', style: 'text-align:center;margin-bottom:var(--space-lg)' }, p.title) : null,
      h(
        'div',
        { class: 'c-features', style: `grid-template-columns:repeat(${cols},minmax(0,1fr))` },
        ...((p.items as any[]) ?? []).map((it) => h('div', { class: 'it' }, h('div', { class: 'ic', 'aria-hidden': 'true' }, it.icon), h('h3', null, it.title), h('p', null, it.text))),
      ),
    );
  },
});

export const testimonial = defineBlock({
  type: 'core:testimonial',
  version: 1,
  label: 'Testimonial',
  category: 'Sections',
  icon: 'quote',
  fields: {
    quote: f.textarea({ label: 'Quote', default: 'This changed how our team works. We shipped our new site in a weekend.' }),
    author: f.text({ label: 'Author', default: 'Alex Rivera' }),
    role: f.text({ label: 'Role', default: 'Founder, Northwind' }),
    avatar: f.image({ label: 'Avatar' }),
  },
  css: '.c-quote{margin:0;text-align:center;max-width:760px;margin:0 auto}.c-quote blockquote{font-size:var(--fontSize-xl);line-height:1.4;margin:0 0 var(--space-md)}.c-quote figcaption{color:var(--color-muted)}.c-quote img{width:56px;height:56px;border-radius:999px;margin:0 auto var(--space-sm)}',
  render: (p, ctx) =>
    ctx.root(
      'figure',
      { class: 'c-quote' },
      h('blockquote', null, `“${p.quote}”`),
      h('figcaption', null, p.avatar ? h('img', { src: p.avatar, alt: '' }) : null, h('strong', null, p.author), p.role ? ` — ${p.role}` : ''),
    ),
});

export const pricing = defineBlock({
  type: 'core:pricing',
  version: 1,
  label: 'Pricing',
  category: 'Sections',
  icon: 'pricing',
  fields: {
    plans: f.list(
      {
        name: f.text({ label: 'Name', default: 'Plan' }),
        price: f.text({ label: 'Price', default: '$0' }),
        period: f.text({ label: 'Period', default: '/month' }),
        features: f.textarea({ label: 'Features (one per line)', default: 'Feature one\nFeature two' }),
        ctaLabel: f.text({ label: 'Button', default: 'Choose' }),
        ctaHref: f.link({ label: 'Link', default: '#' }),
        highlighted: f.boolean({ label: 'Highlight' }),
      },
      {
        label: 'Plans',
        itemLabel: 'name',
        default: [
          { name: 'Starter', price: '$0', period: '/month', features: '1 site\nCommunity support', ctaLabel: 'Start free', ctaHref: '#', highlighted: false },
          { name: 'Pro', price: '$19', period: '/month', features: 'Unlimited pages\nCustom domain\nShop', ctaLabel: 'Go Pro', ctaHref: '#', highlighted: true },
          { name: 'Team', price: '$49', period: '/month', features: 'Everything in Pro\nCollaboration\nPriority support', ctaLabel: 'Contact us', ctaHref: '#', highlighted: false },
        ],
      },
    ),
  },
  css:
    BUTTON_CSS +
    '.c-pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--space-lg)}.c-pricing .pl{border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-lg);display:flex;flex-direction:column}' +
    '.c-pricing .pl.hi{border:2px solid var(--color-primary);box-shadow:var(--shadow-md)}.c-pricing .pr{font-size:var(--fontSize-2xl);font-weight:700}.c-pricing .pr small{font-size:var(--fontSize-md);color:var(--color-muted);font-weight:400}' +
    '.c-pricing ul{list-style:none;padding:0;margin:var(--space-md) 0;flex:1}.c-pricing li{padding:.25em 0}.c-pricing li::before{content:"✓ ";color:var(--color-primary)}',
  render: (p, ctx) =>
    ctx.root(
      'div',
      { class: 'c-pricing' },
      ...((p.plans as any[]) ?? []).map((pl) =>
        h(
          'div',
          { class: `pl${pl.highlighted ? ' hi' : ''}` },
          h('h3', null, pl.name),
          h('div', { class: 'pr' }, pl.price, h('small', null, pl.period)),
          h('ul', null, ...String(pl.features ?? '').split('\n').filter(Boolean).map((x) => h('li', null, x))),
          h('a', { class: `c-btn ${pl.highlighted ? 'primary' : 'secondary'}`, href: href(pl.ctaHref, ctx) }, pl.ctaLabel),
        ),
      ),
    ),
});

export const faq = defineBlock({
  type: 'core:faq',
  version: 1,
  label: 'FAQ',
  category: 'Sections',
  icon: 'faq',
  fields: {
    items: f.list(
      { q: f.text({ label: 'Question', default: 'Question?' }), a: f.textarea({ label: 'Answer', default: 'Answer.' }) },
      {
        label: 'Questions',
        itemLabel: 'q',
        default: [
          { q: 'Can I use my own domain?', a: 'Yes — connect it from site settings.' },
          { q: 'Do I need to code?', a: 'No. Developers can extend everything with modules.' },
        ],
      },
    ),
  },
  css: '.c-faq details{border-bottom:1px solid var(--color-border);padding:var(--space-md) 0}.c-faq summary{cursor:pointer;font-weight:600;font-size:var(--fontSize-lg)}.c-faq p{margin:var(--space-sm) 0 0;color:var(--color-muted)}',
  render: (p, ctx) => ctx.root('div', { class: 'c-faq' }, ...((p.items as any[]) ?? []).map((it) => h('details', null, h('summary', null, it.q), h('p', null, it.a)))),
});

/* ───────── layout building blocks ───────── */

export const header = defineBlock({
  type: 'core:header',
  version: 1,
  label: 'Header',
  category: 'Site',
  internal: true,
  fields: { sticky: f.boolean({ label: 'Sticky', default: true }) },
  slots: [
    { name: 'brand', label: 'Brand' },
    { name: 'nav', label: 'Navigation' },
    { name: 'actions', label: 'Actions' },
  ],
  island: {
    name: 'core:nav-toggle',
    script: `(el)=>{const b=el.querySelector('.c-burger');if(!b)return;b.addEventListener('click',()=>{const o=el.classList.toggle('open');b.setAttribute('aria-expanded',String(o))})}`,
  },
  css:
    '.c-header{border-bottom:1px solid var(--color-border);background:var(--color-bg);z-index:20}.c-header.sticky{position:sticky;top:0}.c-header .in{max-width:1120px;margin:0 auto;padding:var(--space-sm) var(--space-md);display:flex;align-items:center;gap:var(--space-lg)}' +
    '.c-header nav{display:flex;gap:var(--space-md);flex:1}.c-header .act{display:flex;gap:var(--space-sm);align-items:center}.c-burger{display:none;background:none;border:0;font-size:1.5rem;cursor:pointer;color:inherit}' +
    '@media (max-width:640px){.c-burger{display:block;margin-left:auto}.c-header .in{flex-wrap:wrap}.c-header nav,.c-header .act{display:none;width:100%;flex-direction:column}.c-header.open nav,.c-header.open .act{display:flex}}',
  render: (p, ctx) =>
    ctx.root(
      'header',
      { class: `c-header${p.sticky ? ' sticky' : ''}` },
      h(
        'div',
        { class: 'in' },
        slot('brand'),
        h('button', { class: 'c-burger', 'aria-label': 'Menu', 'aria-expanded': 'false', type: 'button' }, '☰'),
        h('nav', { 'aria-label': 'Main' }, slot('nav')),
        h('div', { class: 'act' }, slot('actions')),
      ),
    ),
});

export const logo = defineBlock({
  type: 'core:logo',
  version: 1,
  label: 'Logo',
  category: 'Site',
  fields: { text: f.text({ label: 'Text', default: 'My Site' }), image: f.image({ label: 'Logo image' }), href: f.link({ label: 'Link', default: '/' }) },
  css: '.c-logo{font-weight:800;font-size:var(--fontSize-lg);color:var(--color-text);text-decoration:none;display:flex;align-items:center;gap:.5em}.c-logo img{height:32px;width:auto}',
  render: (p, ctx) => ctx.root('a', { class: 'c-logo', href: href(p.href, ctx) }, p.image ? h('img', { src: p.image, alt: '' }) : null, p.text),
});

export const footer = defineBlock({
  type: 'core:footer',
  version: 1,
  label: 'Footer',
  category: 'Site',
  internal: true,
  fields: { text: f.text({ label: 'Text', default: '© My Site' }) },
  slots: [{ name: 'default' }],
  css: '.c-footer{border-top:1px solid var(--color-border);color:var(--color-muted);font-size:var(--fontSize-sm)}.c-footer .in{max-width:1120px;margin:0 auto;padding:var(--space-lg) var(--space-md);display:flex;gap:var(--space-md);flex-wrap:wrap;justify-content:space-between}',
  render: (p, ctx) => ctx.root('footer', { class: 'c-footer' }, h('div', { class: 'in' }, h('span', null, p.text), h('div', null, slot('default')))),
});

/** Where the page content goes inside the layout. */
export const outlet = defineBlock({
  type: 'core:outlet',
  version: 1,
  label: 'Page content',
  category: 'Site',
  internal: true,
  fields: {},
  slots: [{ name: 'default' }],
  render: (_p, ctx) => ctx.root('main', { id: 'main' }, slot('default')),
});

export const allBlocks = [page, section, stack, grid, card, heading, text, image, button, link, spacer, divider, video, hero, features, testimonial, pricing, faq, header, logo, footer, outlet];
