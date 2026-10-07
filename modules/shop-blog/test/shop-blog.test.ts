import { afterEach, describe, expect, it } from 'vitest';
import { defineModel, loadData, mf, renderDocument, type PageNode } from '@modulo/core';
import { createPgliteDb, defineModule, Kernel } from '@modulo/kernel';
import payments from '../../payments/src/index.ts';
import shop from '../../shop/src/index.ts';
import shopBlog from '../src/index.ts';

/** Minimal stand-in for the real blog module (built concurrently elsewhere). */
const blog = defineModule({
  name: 'blog',
  version: '1.0.0',
  kernel: '^1.0.0',
  models: [
    defineModel({
      name: 'blog.post',
      titleField: 'title',
      fields: {
        title: mf.string({ required: true }),
        slug: mf.slug('title'),
        excerpt: mf.text(),
        body: mf.richtext(),
        cover: mf.media(),
        status: mf.enum(['draft', 'published'], { default: 'draft' }),
        published_at: mf.datetime(),
      },
      access: { read: 'public' },
    }),
  ],
});

let kernel: Kernel;
afterEach(async () => {
  await kernel?.close();
});

describe('shop-blog glue', () => {
  it('auto-installs only when both shop and blog are installed', async () => {
    kernel = await Kernel.create({ db: await createPgliteDb(), modules: [payments, shop, blog, shopBlog] });
    const onlyShop = await kernel.createSite({ slug: 'only-shop', name: 'A', modules: { shop: '*' } });
    expect((await kernel.installedModules(onlyShop.id)).map((m) => m.name)).not.toContain('shop-blog');
    const onlyBlog = await kernel.createSite({ slug: 'only-blog', name: 'B', modules: { blog: '*' } });
    expect((await kernel.installedModules(onlyBlog.id)).map((m) => m.name)).not.toContain('shop-blog');
    // blog.post has no featured_products where the glue is absent.
    const bctx = await kernel.context(onlyBlog.id, null, { sudo: true });
    await expect(bctx.repo('blog.post').create({ title: 'x', featured_products: [] })).rejects.toThrow();

    const both = await kernel.createSite({ slug: 'both', name: 'C', modules: { shop: '*', blog: '*' } });
    const mods = await kernel.installedModules(both.id);
    expect(mods.find((m) => m.name === 'shop-blog')).toMatchObject({ auto: true });

    // Adding blog later to a shop site pulls the glue in too.
    await kernel.applyChange(onlyShop.id, { install: { blog: '*' } });
    expect((await kernel.installedModules(onlyShop.id)).map((m) => m.name)).toContain('shop-blog');
    // ...and removing blog removes it again.
    await kernel.applyChange(onlyShop.id, { uninstall: ['blog'], cascade: true });
    expect((await kernel.installedModules(onlyShop.id)).map((m) => m.name)).not.toContain('shop-blog');
  });

  it('renders the featured products of the post in scope', async () => {
    kernel = await Kernel.create({ db: await createPgliteDb(), modules: [payments, shop, blog, shopBlog] });
    const site = await kernel.createSite({ slug: 'sb', name: 'SB', modules: { shop: '*', blog: '*' } });
    const admin = await kernel.context(site.id, null, { sudo: true });
    const mug = await admin.repo('shop.product').create({ title: 'Mug & Co', price: 9.5 });
    const hidden = await admin.repo('shop.product').create({ title: 'Retired', price: 1, active: false });
    const post = await admin.repo('blog.post').create({
      title: 'Coffee rituals',
      status: 'published',
      featured_products: [mug.id, hidden.id, mug.id, 'not-an-id'],
    });
    expect(post.featured_products).toEqual([mug.id, hidden.id]);

    const anon = await kernel.context(site.id, null);
    const record = await anon.repo('blog.post').get(post.id);
    const tree: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'fp', type: 'shop-blog:post-products', props: {} }] } };
    const scope = { path: '/blog/coffee-rituals', params: { slug: 'coffee-rituals' }, query: {}, record, base: '/s/sb' };
    const data = await loadData(tree, anon.runtime.blocks, { siteId: site.id, scope, services: { ctx: anon } });
    const { document } = renderDocument(tree, { registry: anon.runtime.blocks, theme: kernel.theme(site), title: 'Post', scope, data });
    expect(document).toContain('Featured in this post');
    expect(document).toContain('Mug &amp; Co');
    expect(document).toContain('$9.50');
    expect(document).toContain('href="/s/sb/shop/mug-co"');
    expect(document).not.toContain('Retired');

    // A post without featured products renders nothing visible.
    const empty = await admin.repo('blog.post').create({ title: 'Plain' });
    const d2 = await loadData(tree, anon.runtime.blocks, { siteId: site.id, scope: { ...scope, record: empty }, services: { ctx: anon } });
    const r2 = renderDocument(tree, { registry: anon.runtime.blocks, theme: kernel.theme(site), title: 'Post', scope, data: d2 });
    expect(r2.document).not.toContain('Featured in this post');
  });
});
