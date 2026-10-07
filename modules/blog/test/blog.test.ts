import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb, invokeRoute, Kernel, type SiteContext } from '@modulo/kernel';
import { findNode, loadData, renderDocument, type PageNode } from '@modulo/core';
import blog, { sanitizeHtml } from '../src/index.ts';
import { assertWellFormedXml, coreStub, pagesStub } from './stubs.ts';

describe('sanitizeHtml', () => {
  const cases: [string, string][] = [
    ['<script>alert(1)</script><p>ok</p>', '<p>ok</p>'],
    ['<p onclick="alert(1)">x</p>', '<p>x</p>'],
    ['<img src=x onerror=alert(1)>', '<img src="x">'],
    ['<img src="javascript:alert(1)" alt="a">', ''],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
    ['<a href=" &#106;avascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java&#x09;script:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java\tscript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="javascript&colon;alert(1)">x</a>', '<a>x</a>'],
    ['<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>', '<a>x</a>'],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a>x</a>'],
    ['<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
    ['<svg onload=alert(1)><circle/></svg>after', 'after'],
    ['<iframe src="https://evil"></iframe>', ''],
    ['<style>body{display:none}</style>t', 't'],
    ['<!--<script>alert(1)</script>-->c', 'c'],
    ['<scr<script>ipt>alert(1)</script>', '&lt;scr'],
    ['<script/xss src="//evil/x.js"></script>', '&lt;script/xss src="//evil/x.js"&gt;'],
    ['<img/src/onerror=alert(1)>', '&lt;img/src/onerror=alert(1)&gt;'],
    ['<div><p>nested</p></div>', '<p>nested</p>'],
    ['<p>unclosed <strong>bold', '<p>unclosed <strong>bold</strong></p>'],
    ['</p></em>stray', 'stray'],
    ['<a href="https://ex.com/?a=1&b=2" target="_blank" style="x">l</a>', '<a href="https://ex.com/?a=1&amp;b=2" rel="noopener noreferrer nofollow">l</a>'],
    ['<img src="/a.png" alt="&quot; onerror=&quot;alert(1)">', '<img src="/a.png" alt="&quot; onerror=&quot;alert(1)">'],
    ['5 < 6 & 7 > 3 &amp; ok', '5 &lt; 6 &amp; 7 &gt; 3 &amp; ok'],
    ['<p title="x" class="y">t</p>', '<p>t</p>'],
    ['<math><mi xlink:href="javascript:alert(1)">x</mi></math>', ''],
    ['<a href="mailto:a@b.c">m</a>', '<a href="mailto:a@b.c" rel="noopener noreferrer nofollow">m</a>'],
    ['<IMG SRC="https://x/y.png" ALT="A">', '<img src="https://x/y.png" alt="A">'],
    ['<p>a<br/>b<br>c</p>', '<p>a<br>b<br>c</p>'],
    ['<a href="#frag">f</a>', '<a href="#frag" rel="noopener noreferrer nofollow">f</a>'],
    ['<a href="foo:bar">x</a>', '<a>x</a>'],
    ['<p>"quotes" and \'apos\'</p>', '<p>"quotes" and \'apos\'</p>'],
  ];
  for (const [input, expected] of cases) {
    it(`sanitises ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(sanitizeHtml(input)).toBe(expected);
    });
  }

  it('never emits dangerous constructs for a corpus of payloads', () => {
    const payloads = [
      '<img src=x onerror=alert(1)//',
      '<body onload=alert(1)>',
      '<<script>script>alert(1)<</script>/script>',
      '<a href="  javascript:alert(1)">',
      '<a href="\u0001javascript:alert(1)">',
      '<input autofocus onfocus=alert(1)>',
      '<details open ontoggle=alert(1)>',
      '<object data="javascript:alert(1)">',
      '<embed src="javascript:alert(1)">',
      '<form action="javascript:alert(1)"><button>x</button></form>',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<a href="java\nscript:alert(1)">x</a>',
      '<p style="background:url(javascript:alert(1))">x</p>',
      '"><script>alert(1)</script>',
      '<img src="x" alt="x" onerror="alert(1)" />',
      '<a href=javascript&#58;alert(1)>x</a>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<template><script>alert(1)</script></template>',
      '<base href="javascript:/a/">',
    ];
    for (const p of payloads) {
      const out = sanitizeHtml(p);
      expect(out, p).not.toMatch(/<script|<iframe|<svg|<object|<embed|<input|<body|<meta|<form|<base|<style/i);
      expect(out, p).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
      expect(out, p).not.toMatch(/(href|src)="\s*(javascript|vbscript|data):/i);
      // Every '<' in the output starts an allowed tag.
      for (const m of out.matchAll(/<\/?([a-z0-9]+)/gi)) expect(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'blockquote', 'code', 'pre', 'img', 'br']).toContain(m[1]);
    }
  });

  it('handles non-string input', () => {
    expect(sanitizeHtml(null)).toBe('');
    expect(sanitizeHtml(42 as any)).toBe('');
  });
});

describe('blog module', () => {
  let kernel: Kernel;
  let siteId: string;
  let sudo: SiteContext;
  let editorId: string;

  beforeAll(async () => {
    kernel = await Kernel.create({ db: await createPgliteDb(), modules: [coreStub, pagesStub, blog] });
    const site = await kernel.createSite({ slug: 'b', name: 'B & Co <Blog>', modules: { blog: '*' } });
    siteId = site.id;
    sudo = await kernel.context(siteId, null, { sudo: true });
    const u = await kernel.createUser({ email: 'ed@x.io', password: 'password1' });
    await kernel.addMember(siteId, u.id, 'editor');
    editorId = u.id;
  });
  afterAll(async () => kernel?.close());

  it('ships a published "Hello world" post with a slug and published_at', async () => {
    const hello = await sudo.repo('blog.post').findOne({ slug: 'hello-world' });
    expect(hello).toBeTruthy();
    expect(hello!.status).toBe('published');
    expect(hello!.published_at).toBeTruthy();
    expect(hello!.tags).toEqual(['news']);
  });

  it('hides drafts from anonymous readers but not from editors', async () => {
    const ed = await kernel.context(siteId, editorId);
    const draft = await ed.repo('blog.post').create({ title: 'Secret Draft' });
    expect(draft.status).toBe('draft');
    expect(draft.published_at).toBeNull();

    const anon = await kernel.context(siteId, null);
    const visible = await anon.repo('blog.post').find();
    expect(visible.map((p) => p.title)).not.toContain('Secret Draft');
    expect(visible.map((p) => p.title)).toContain('Hello world');
    expect(await anon.repo('blog.post').find({ where: { status: 'draft' } })).toEqual([]);
    expect(await anon.repo('blog.post').findOne({ id: draft.id })).toBeNull();
    expect(await anon.repo('blog.post').count({ $or: [{ status: 'draft' }, { title: 'Secret Draft' }] })).toBe(0);

    const edPosts = await (await kernel.context(siteId, editorId)).repo('blog.post').find();
    expect(edPosts.map((p) => p.title)).toContain('Secret Draft');

    // The single-post route 404s for drafts.
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: `/blog/${draft.slug}` });
    expect(r.status).toBe(404);
    expect(r.body).toBe('Not found');
    await ed.repo('blog.post').delete(draft.id);
  });

  it('fills slug and published_at when a post is published', async () => {
    const ed = await kernel.context(siteId, editorId);
    const p = await ed.repo('blog.post').create({ title: 'Launch Day!', tags: 'launch, news ,launch' });
    expect(p.slug).toBe('launch-day');
    expect(p.tags).toEqual(['launch', 'news']);
    expect(p.published_at).toBeNull();
    const pub = await ed.repo('blog.post').update(p.id, { status: 'published' });
    expect(pub.published_at).toBeTruthy();
    const first = pub.published_at;
    await ed.repo('blog.post').update(p.id, { status: 'draft' });
    const again = await ed.repo('blog.post').update(p.id, { status: 'published' });
    expect(again.published_at).toBe(first);
    const dup = await ed.repo('blog.post').create({ title: 'Launch Day!' });
    expect(dup.slug).toBe('launch-day-2');
    await ed.repo('blog.post').delete(dup.id);
  });

  it('serves a post page and renders sanitised content', async () => {
    const anon = await kernel.context(siteId, null);
    await sudo.repo('blog.post').create({
      title: 'XSS <b>Title</b>',
      status: 'published',
      body: '<p>Hi</p><script>alert(1)</script><img src=x onerror=alert(1)>',
      excerpt: 'An excerpt',
      tags: ['sec'],
    });
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/blog/xss-b-title-b' });
    expect(r.page).toBeTruthy();
    expect(r.page!.title).toBe('XSS <b>Title</b>');
    const scope = { ...r.page!.scope, path: '/blog/xss-b-title-b', params: {}, query: {}, base: '/s/b' };
    const registry = anon.runtime.blocks;
    const data = await loadData(r.page!.tree, registry, { siteId, scope, services: { ctx: anon } });
    const doc = renderDocument(r.page!.tree, { registry, theme: kernel.theme(anon.site), title: r.page!.title, scope, data }).document;
    expect(doc).toContain('<h1>XSS &lt;b&gt;Title&lt;/b&gt;</h1>');
    expect(doc).toContain('<p>Hi</p><img src="x">');
    expect(doc).not.toContain('<script>alert');
    expect(doc).toContain('href="/s/b/blog/tag/sec"');
  });

  it('lists posts (with tag filter and base-prefixed links)', async () => {
    const anon = await kernel.context(siteId, null);
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/blog' });
    const tree = r.page!.tree;
    expect(findNode(tree, 'blog-list')).toBeTruthy();
    const scope = { path: '/blog', params: {}, query: {}, base: '/s/b' };
    const registry = anon.runtime.blocks;
    const data = await loadData(tree, registry, { siteId, scope, services: { ctx: anon } });
    const html = renderDocument(tree, { registry, theme: kernel.theme(anon.site), title: 'Blog', scope, data }).document;
    expect(html).toContain('href="/s/b/blog/hello-world"');
    expect(html).toContain('<h1>Blog</h1>');

    const t = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/blog/tag/sec' });
    const tdata = await loadData(t.page!.tree, registry, { siteId, scope, services: { ctx: anon } });
    const posts = (tdata.get('blog-list') as any).posts;
    expect(posts.map((p: any) => p.title)).toEqual(['XSS <b>Title</b>']);
  });

  it('produces a well-formed, escaped RSS feed', async () => {
    const anon = await kernel.context(siteId, null);
    await sudo.repo('blog.post').create({ title: 'Tom & Jerry <"quoted">', status: 'published', excerpt: 'a < b && c > d', author: "O'Brien & co", tags: ['a&b'] });
    await sudo.repo('blog.post').create({ title: 'Hidden draft' });
    const r = await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/blog/rss.xml', headers: { host: 'example.test:3000' } });
    expect(r.headers?.['content-type']).toMatch(/^application\/rss\+xml/);
    const xml = String(r.body);
    assertWellFormedXml(xml);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<title>Tom &amp; Jerry &lt;&quot;quoted&quot;&gt;</title>');
    expect(xml).toContain('<description>a &lt; b &amp;&amp; c &gt; d</description>');
    expect(xml).toContain('<link>http://example.test:3000/blog/hello-world</link>');
    expect(xml).toContain('<category>a&amp;b</category>');
    expect(xml).toContain('B &amp; Co &lt;Blog&gt;');
    expect(xml).not.toContain('Hidden draft');
  });

  it('patches the layout nav and contributes sitemap entries via hook', async () => {
    const layout = sudo.runtime.template('core:layout')!;
    expect(layout.failures).toEqual([]);
    const header = findNode(layout.tree, 'header') as PageNode;
    expect(header.slots!.nav!.map((n) => [n.type, n.props])).toEqual([['core:link', { label: 'Blog', href: '/blog' }]]);
    const entries = await sudo.hooks.filter('seo.sitemap', [] as any[], sudo);
    expect(entries.map((e: any) => e.loc)).toContain('/blog/hello-world');
    expect(entries.map((e: any) => e.loc)).not.toContain('/blog/hidden-draft');
  });

  it('returns 404 for unknown posts', async () => {
    const anon = await kernel.context(siteId, null);
    expect((await invokeRoute(anon, { surface: 'site', method: 'GET', path: '/blog/nope' })).status).toBe(404);
  });
});
