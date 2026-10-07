import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb, invokeRoute, Kernel, type SiteContext } from '@modulo/kernel';
import seo, { buildHead, jsonForScript } from '../src/index.ts';
import blog from '../../blog/src/index.ts';
import { assertWellFormedXml, coreStub, pagesStub } from './stubs.ts';

describe('seo module', () => {
  let kernel: Kernel;
  let plain: SiteContext; // seo only
  let withBlog: SiteContext; // seo + blog

  beforeAll(async () => {
    kernel = await Kernel.create({ db: await createPgliteDb(), modules: [coreStub, pagesStub, seo, blog] });
    const a = await kernel.createSite({ slug: 'plain', name: 'Plain', modules: { seo: '*' } });
    const b = await kernel.createSite({ slug: 'blogged', name: 'Blogged', modules: { seo: '*', blog: '*' } });
    await kernel.updateSite(b.id, { domain: 'www.example.com' });
    plain = await kernel.context(a.id, null, { sudo: true });
    withBlog = await kernel.context(b.id, null, { sudo: true });
    for (const ctx of [plain, withBlog]) {
      const pages = ctx.repo('pages.page');
      await pages.create({ title: 'Home', path: '/', status: 'published', published_at: '2026-01-02T03:04:05Z' });
      await pages.create({ title: 'About', path: '/about', status: 'published' });
      await pages.create({ title: 'Q&A', path: '/q&a/<x>', status: 'published' });
      await pages.create({ title: 'Draft', path: '/draft', status: 'draft' });
      await pages.create({ title: 'Secret', path: '/secret', status: 'published', noindex: true });
    }
  });
  afterAll(async () => kernel?.close());

  it('installs pages as a dependency and extends pages.page', async () => {
    expect(plain.hasModule('pages')).toBe(true);
    expect(plain.hasModule('blog')).toBe(false);
    const home = await plain.repo('pages.page').findOne({ path: '/' });
    expect(home!.noindex).toBe(false);
    expect('seo_title' in home!).toBe(true);
  });

  it('escapes attacker-controlled titles and descriptions in head output', async () => {
    const evil = '"><script>alert(1)</script><meta x="';
    const page = await plain.repo('pages.page').create({
      title: evil,
      path: '/evil',
      status: 'published',
      seo_description: `desc ${evil}`,
      og_image: '/img/og.png',
    });
    const info = { ctx: plain, site: plain.site, path: '/evil', title: evil, url: 'https://plain.test/evil', page, record: null };
    const head = await plain.hooks.filter('page.head', '', info);
    expect(head).not.toContain('<script>alert');
    expect(head).not.toContain('<meta x=');
    expect(head).toContain('<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;meta x=&quot;">');
    expect(head).toContain('<meta name="description" content="desc &quot;&gt;&lt;script&gt;');
    expect(head).toContain('<link rel="canonical" href="https://plain.test/evil">');
    expect(head).toContain('<meta property="og:url" content="https://plain.test/evil">');
    expect(head).toContain('<meta property="og:image" content="https://plain.test/img/og.png">');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(head).not.toContain('noindex');
    expect(head).not.toContain('application/ld+json'); // only on "/"

    const bad = buildHead({ ...info, url: 'javascript:alert(1)', page: { og_image: 'javascript:alert(1)' } });
    expect(bad).not.toContain('javascript:');
    expect(bad).not.toContain('canonical');
  });

  it('prefers seo fields, falls back to info and site settings, emits robots and JSON-LD', async () => {
    await kernel.updateModuleSettings(plain.site.id, 'seo', { default_description: 'Site default', twitter_handle: 'modulo', og_default_image: 'https://cdn.test/og.png' });
    const ctx = await kernel.context(plain.site.id, null);
    const secret = await plain.repo('pages.page').findOne({ path: '/secret' });
    const h1 = buildHead({ ctx, site: ctx.site, path: '/secret', title: 'Secret', url: 'https://plain.test/secret', page: secret, record: null });
    expect(h1).toContain('<meta name="robots" content="noindex">');
    expect(h1).toContain('<meta name="description" content="Site default">');
    expect(h1).toContain('<meta name="twitter:site" content="@modulo">');
    expect(h1).toContain('<meta property="og:image" content="https://cdn.test/og.png">');

    const h2 = buildHead({ ctx, site: { ...ctx.site, name: 'Evil </script><script>x()</script>' }, path: '/', title: 'Home', url: 'https://plain.test/', page: { seo_title: 'Better Title' }, record: null, description: 'From info' });
    expect(h2).toContain('<meta property="og:title" content="Better Title">');
    expect(h2).toContain('<meta name="description" content="From info">');
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(h2)!;
    expect(ld).toBeTruthy();
    expect(ld[1]).not.toContain('<');
    expect(JSON.parse(ld[1]!)).toEqual({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Evil </script><script>x()</script>', url: 'https://plain.test/', description: 'From info' });
    expect(jsonForScript({ a: 'x' + String.fromCharCode(0x2028) + '&' })).toBe('{"a":"x\\u2028\\u0026"}');
  });

  it('serves a well-formed, escaped sitemap of published, indexable pages (no blog posts without blog)', async () => {
    const anon = await kernel.context(plain.site.id, null);
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/sitemap.xml', headers: { host: 'localhost:8080', 'x-modulo-base': '/s/plain' } });
    expect(r.headers!['content-type']).toMatch(/^application\/xml/);
    const xml = String(r.body);
    assertWellFormedXml(xml);
    expect(xml).toContain('<loc>http://localhost:8080/s/plain/</loc><lastmod>2026-01-02T03:04:05.000Z</lastmod>');
    expect(xml).toContain('<loc>http://localhost:8080/s/plain/about</loc>');
    expect(xml).toContain('<loc>http://localhost:8080/s/plain/q&amp;a/%3Cx%3E</loc>');
    expect(xml).not.toContain('/draft');
    expect(xml).not.toContain('/secret');
    expect(xml).not.toContain('/blog');
  });

  it('includes blog posts via the seo.sitemap hook when blog is installed', async () => {
    await withBlog.repo('blog.post').create({ title: 'Fish & Chips', status: 'published' });
    await withBlog.repo('blog.post').create({ title: 'Unpublished', status: 'draft' });
    const anon = await kernel.context(withBlog.site.id, null);
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/sitemap.xml', headers: { host: 'ignored.test' } });
    const xml = String(r.body);
    assertWellFormedXml(xml);
    expect(xml).toContain('<loc>https://www.example.com/about</loc>');
    expect(xml).toContain('<loc>https://www.example.com/blog</loc>');
    expect(xml).toContain('<loc>https://www.example.com/blog/hello-world</loc>');
    expect(xml).toContain('<loc>https://www.example.com/blog/fish-chips</loc>');
    expect(xml).not.toContain('unpublished');
    expect(xml).not.toContain('ignored.test');
  });

  it('serves robots.txt with Disallow for noindex pages and a Sitemap line', async () => {
    const anon = await kernel.context(withBlog.site.id, null);
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/robots.txt' });
    expect(r.headers!['content-type']).toMatch(/^text\/plain/);
    expect(String(r.body)).toBe('User-agent: *\nDisallow: /secret\n\nSitemap: https://www.example.com/sitemap.xml\n');
  });
});
