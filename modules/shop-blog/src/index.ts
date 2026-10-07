import { defineBlock, extendModel, f, h, mf } from '@modulo/core';
import { defineModule, type SiteContext } from '@modulo/kernel';

/**
 * Glue between shop and blog: posts can feature products. Auto-installs when
 * both shop and blog are on a site.
 */
interface ProductView {
  id: string;
  title: string;
  slug: string;
  image: string | null;
  price: number;
  unit: number;
  inStock: boolean;
}

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(n));
  } catch {
    return `${Number(n).toFixed(2)} ${currency}`;
  }
}

const baseOf = (scope: Record<string, unknown>) => {
  const b = String(scope?.base ?? '');
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(b) ? b : '';
};

export const postProducts = defineBlock<{ heading: string }, { products: ProductView[]; currency: string; base: string }>({
  type: 'shop-blog:post-products',
  version: 1,
  label: 'Featured products',
  category: 'Shop',
  description: "Products featured on the current blog post (its 'featured_products').",
  fields: { heading: f.text({ label: 'Heading', default: 'Featured in this post' }) },
  css:
    '.sb-products{margin:var(--space-xl,2rem) 0}.sb-products ul{list-style:none;padding:0;margin:0;display:grid;gap:var(--space-md,1rem);grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}' +
    '.sb-products a{display:block;text-decoration:none;color:inherit;border:1px solid var(--color-border,#e5e5e5);border-radius:var(--radius-md,8px);overflow:hidden}' +
    '.sb-products img{aspect-ratio:1/1;object-fit:cover;width:100%}.sb-products span{display:block;padding:0 var(--space-sm,.5rem) var(--space-sm,.5rem)}.sb-products strong{display:block;padding:var(--space-sm,.5rem)}',
  load: async (_props, { services, scope }) => {
    const ctx = services.ctx as SiteContext;
    const shop = ctx.service<any>('shop');
    const rec = scope.record as Record<string, any> | undefined;
    const ids = Array.isArray(rec?.featured_products) ? rec!.featured_products : [];
    return { products: ids.length ? await shop.productsByIds(ids) : [], currency: shop.currency(), base: baseOf(scope) };
  },
  render: (props, ctx) => {
    const d = ctx.data;
    if (!d?.products?.length) return ctx.mode === 'edit' ? ctx.root('div', { class: 'sb-products' }, 'Featured products of the post appear here.') : ctx.root('div', { class: 'sb-products', hidden: true });
    return ctx.root(
      'section',
      { class: 'sb-products' },
      props.heading ? h('h2', null, props.heading) : null,
      h(
        'ul',
        null,
        ...d.products.map((p) =>
          h(
            'li',
            null,
            h(
              'a',
              { href: `${d.base}/shop/${encodeURIComponent(p.slug)}` },
              p.image ? h('img', { src: p.image, alt: p.title, loading: 'lazy' }) : null,
              h('strong', null, p.title),
              h('span', null, money(p.unit, d.currency)),
            ),
          ),
        ),
      ),
    );
  },
});

export default defineModule({
  name: 'shop-blog',
  version: '1.0.0',
  label: 'Shop × Blog',
  description: 'Feature products in blog posts.',
  kernel: '^1.0.0',
  category: 'commerce',
  depends: { shop: '^1.0.0', blog: '^1.0.0' },
  activatesWhen: ['shop', 'blog'],
  extendModels: [extendModel({ model: 'blog.post', fields: { featured_products: mf.json({ label: 'Featured products', help: 'Product ids', default: [] }) } })],
  blocks: [postProducts],
  hooks: [
    { hook: 'model.blog.post.beforeCreate', kind: 'filter', id: 'featured-create', fn: (v: Record<string, unknown>) => normalise(v) },
    { hook: 'model.blog.post.beforeUpdate', kind: 'filter', id: 'featured-update', fn: (v: Record<string, unknown>) => normalise(v) },
  ],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keep featured_products a de-duplicated array of product ids (max 24). */
function normalise(v: Record<string, unknown>) {
  if (!('featured_products' in v) || v.featured_products === undefined) return v;
  const raw = v.featured_products;
  const list = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
  return { ...v, featured_products: [...new Set(list.filter((x): x is string => typeof x === 'string' && UUID.test(x)))].slice(0, 24) };
}
