import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { CollabProvider, readTree, yInsert, ySetProps } from '@modulo/collab';
import { createPgliteDb, Kernel } from '@modulo/kernel';
import core from '../../../modules/core/src/index.ts';
import pages from '../../../modules/pages/src/index.ts';
import media from '../../../modules/media/src/index.ts';
import { createApp, attachCollab, LocalStorage } from '../src/index.ts';

let kernel: Kernel;
let app: ReturnType<typeof createApp>['app'];
let cache: ReturnType<typeof createApp>['cache'];
let mediaDir: string;
let cookie = '';
let siteId = '';

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(cookie ? { cookie } : {}), ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as any)['content-type'] = 'application/json';
  }
  const res = await app.request(path, init);
  const sc = res.headers.get('set-cookie');
  if (sc?.startsWith('modulo_session=')) cookie = sc.split(';')[0]!;
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

beforeAll(async () => {
  mediaDir = mkdtempSync(join(tmpdir(), 'modulo-media-'));
  kernel = await Kernel.create({ db: await createPgliteDb(), modules: [core, pages, media] });
  ({ app, cache } = createApp({ kernel, storage: new LocalStorage(mediaDir), openSignup: true }));
});
afterAll(async () => {
  await kernel.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

describe('server', () => {
  it('signs up the first user as superadmin and creates a site with a published home page', async () => {
    const s = await req('POST', '/api/auth/signup', { email: 'owner@acme.io', password: 'correct horse', name: 'Owner' });
    expect(s.status).toBe(201);
    expect(s.data.user.is_superadmin).toBe(true);
    const site = await req('POST', '/api/sites', { slug: 'acme', name: 'Acme Studio' });
    expect(site.status).toBe(201);
    siteId = site.data.id;
    const rt = await req('GET', '/api/sites/acme/runtime');
    expect(rt.data.blocks.some((b: any) => b.type === 'core:hero')).toBe(true);
    expect(rt.data.blocks[0].render).toBeUndefined();
    expect(rt.data.user.permissions).toContain('*');
    const list = await req('GET', '/api/sites/acme/m/pages/pages');
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ path: '/', status: 'published', hasUnpublishedChanges: false });
  });

  it('serves the published site with layout, tokens, tiny JS and caching', async () => {
    cookie = '';
    const r = await req('GET', '/s/acme');
    expect(r.status).toBe(200);
    expect(r.data).toContain('Welcome to your new site');
    expect(r.data).toContain('class="c-logo"');
    expect(r.data).toContain('Acme Studio'); // logo bound to site.name
    expect(r.data).toContain('--color-primary');
    expect(r.headers.get('x-modulo-cache')).toBe('miss');
    const scripts = [...String(r.data).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('');
    expect(scripts.length).toBeLessThan(30 * 1024); // performance budget: < 30KB JS on the default page
    const again = await req('GET', '/s/acme/');
    expect(again.headers.get('x-modulo-cache')).toBe('hit');
    const notModified = await req('GET', '/s/acme', undefined, { 'if-none-match': again.headers.get('etag')! });
    expect(notModified.status).toBe(304);
    const nf = await req('GET', '/s/acme/nope');
    expect(nf.status).toBe(404);
    expect(nf.data).toContain('Page not found');
  });

  it('edits a draft, previews it, publishes, and invalidates the cache', async () => {
    await req('POST', '/api/auth/login', { email: 'owner@acme.io', password: 'correct horse' });
    const created = await req('POST', '/api/sites/acme/m/pages/pages', { title: 'About us', path: '/about', template: 'about' });
    expect(created.status).toBe(201);
    const id = created.data.id;
    const page = await req('GET', `/api/sites/acme/m/pages/pages/${id}`);
    const tree = page.data.draft;
    tree.slots.default[0].slots.default[0].props.text = 'About Acme <script>';
    const saved = await req('PUT', `/api/sites/acme/m/pages/pages/${id}/draft`, { tree });
    expect(saved.status).toBe(200);
    const bad = await req('PUT', `/api/sites/acme/m/pages/pages/${id}/draft`, { tree: { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'x', type: 'nope:block', props: {} }] } } });
    expect(bad.status).toBe(400);

    const anonPreview = await app.request('/s/acme/about?preview=draft');
    expect(anonPreview.status).toBe(403);
    const preview = await req('GET', '/s/acme/about?preview=draft');
    expect(preview.data).toContain('About Acme &lt;script&gt;');
    cookie = '';
    expect((await req('GET', '/s/acme/about')).status).toBe(404);
    await req('POST', '/api/auth/login', { email: 'owner@acme.io', password: 'correct horse' });
    await req('POST', `/api/sites/acme/m/pages/pages/${id}/publish`, {});
    await kernel.drain();
    cookie = '';
    const live = await req('GET', '/s/acme/about');
    expect(live.status).toBe(200);
    expect(live.data).toContain('About Acme');
    const revs = await (async () => {
      await req('POST', '/api/auth/login', { email: 'owner@acme.io', password: 'correct horse' });
      return req('GET', `/api/sites/acme/m/pages/pages/${id}/revisions`);
    })();
    expect(revs.data.map((r: any) => r.kind)).toContain('publish');
  });

  it('renders edit-mode HTML for the canvas with node ids, slot markers and read-only layout ids', async () => {
    const page = (await req('GET', '/api/sites/acme/m/pages/pages')).data.find((p: any) => p.path === '/');
    const full = await req('GET', `/api/sites/acme/m/pages/pages/${page.id}`);
    const r = await req('POST', '/api/sites/acme/render', { tree: full.data.draft });
    expect(r.data.html).toContain('data-node-id=');
    expect(r.data.html).toContain('<m-slot data-parent="main" data-slot="default">');
    expect(r.data.layoutNodeIds).toContain('header');
    expect(r.data.pageRootId).toBe('main');
    expect(r.data.editCss).toContain('m-slot');
  });

  it('exposes headless REST + GraphQL with access rules (drafts hidden from anonymous)', async () => {
    const draftOnly = await req('POST', '/api/sites/acme/m/pages/pages', { title: 'Secret', path: '/secret' });
    expect(draftOnly.status).toBe(201);
    const authed = await req('GET', '/api/sites/acme/data/pages.page');
    expect(authed.data.total).toBe(3);
    expect(authed.data.items[0].draft).toBeDefined();
    const gql = await req('POST', '/api/sites/acme/graphql', { query: '{ pages_page_list(order: "path asc") { title path status } pages_page_count }' });
    expect(gql.data.data.pages_page_count).toBe(3);
    cookie = '';
    const anon = await req('GET', '/api/sites/acme/data/pages.page');
    expect(anon.data.items.map((p: any) => p.path).sort()).toEqual(['/', '/about']);
    expect(anon.data.items[0].draft).toBeUndefined();
    const anonWrite = await req('POST', '/api/sites/acme/data/pages.page', { title: 'x', path: '/x' });
    expect(anonWrite.status).toBe(401);
    await req('POST', '/api/auth/login', { email: 'owner@acme.io', password: 'correct horse' });
  });

  it('blocks cross-site cookie requests without JSON and enforces membership', async () => {
    const form = await app.request('/api/sites/acme/m/pages/pages', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x&path=/x' });
    expect(form.status).toBe(403);
    const other = await app.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'stranger@x.io', password: 'password123' }) });
    const strangerCookie = other.headers.get('set-cookie')!.split(';')[0]!;
    const denied = await app.request('/api/sites/acme/runtime', { headers: { cookie: strangerCookie } });
    expect(denied.status).toBe(403);
  });

  it('uploads media (sniffing the real type) and serves it', async () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR42mP8z8DwnwEJMCJzACqQAv/1W9kGAAAAAElFTkSuQmCC', 'base64'));
    const fd = new FormData();
    fd.append('file', new File([png], 'Logo Final.PNG', { type: 'image/png' }));
    const up = await app.request('/api/sites/acme/media', { method: 'POST', headers: { cookie, 'x-modulo-client': '1' }, body: fd });
    const asset = await up.json();
    expect(up.status).toBe(201);
    expect(asset).toMatchObject({ mime: 'image/png', width: 2, height: 3 });
    expect(asset.storage_key).toMatch(/logo-final\.png$/);
    const got = await app.request(asset.url);
    expect(got.headers.get('content-type')).toBe('image/png');
    const fake = new FormData();
    fake.append('file', new File(['<script>alert(1)</script>'], 'x.png', { type: 'image/png' }));
    expect((await app.request('/api/sites/acme/media', { method: 'POST', headers: { cookie, 'x-modulo-client': '1' }, body: fake })).status).toBe(400);
  });

  it('applies site-level layout patches over module templates', async () => {
    const r = await req('PUT', '/api/sites/acme/layout', {
      ops: [
        { op: 'append', target: 'header#nav', node: { id: 'about-link', type: 'core:link', props: { label: 'About', href: '/about' } } },
        { op: 'setProp', target: 'footer', prop: 'text', value: 'Made with Modulo' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.failures).toEqual([]);
    await kernel.drain();
    cookie = '';
    const html = (await req('GET', '/s/acme/about')).data;
    expect(html).toContain('href="/s/acme/about">About</a>');
    await req('POST', '/api/auth/login', { email: 'owner@acme.io', password: 'correct horse' });
  });

  it('module management: plan + apply + audit', async () => {
    const mods = await req('GET', '/api/sites/acme/modules');
    expect(mods.data.installed.map((m: any) => m.name).sort()).toEqual(['core', 'media', 'pages']);
    const plan = await req('POST', '/api/sites/acme/modules/plan', { uninstall: ['pages'] });
    expect(plan.status).toBe(400);
    const audit = await req('GET', '/api/sites/acme/audit');
    expect(audit.data.some((a: any) => a.action === 'modules.change')).toBe(true);
  });
});

describe('collaboration over websockets', () => {
  it('syncs two editors in real time and persists the draft', async () => {
    const server = serve({ fetch: app.fetch, port: 0 }) as unknown as Server;
    await new Promise((r) => server.once('listening', r));
    const collab = attachCollab(server as any, kernel, { saveDelayMs: 50 });
    const port = (server.address() as AddressInfo).port;
    const page = (await req('GET', '/api/sites/acme/m/pages/pages')).data.find((p: any) => p.path === '/about');
    const token = (await req('POST', '/api/auth/login', { email: 'owner@acme.io', password: 'correct horse' })).data.token;
    const url = `ws://127.0.0.1:${port}/api/sites/acme/collab/${page.id}?token=${token}`;
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    const synced = (d: Y.Doc) => new Promise<CollabProvider>((res) => {
      const p: CollabProvider = new CollabProvider(url, d, { WebSocketImpl: WebSocket, onSynced: () => res(p) });
    });
    const [p1, p2] = await Promise.all([synced(d1), synced(d2)]);
    const t = readTree(d1)!;
    const first = t.slots!.default![0]!.slots!.default![0]!;
    ySetProps(d1, first.id, { text: 'Co-edited title' });
    yInsert(d2, { id: 'n_live', type: 'core:divider', props: {} }, 'root', 'default', 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(readTree(d2)!.slots!.default![0]!.slots!.default![0]!.props.text).toBe('Co-edited title');
    expect(readTree(d1)!.slots!.default!.map((n) => n.id)).toContain('n_live');
    await collab.flush();
    const saved = await req('GET', `/api/sites/acme/m/pages/pages/${page.id}`);
    expect(JSON.stringify(saved.data.draft)).toContain('Co-edited title');
    expect(JSON.stringify(saved.data.draft)).toContain('n_live');
    const bad = await new Promise<number>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sites/acme/collab/${page.id}`);
      ws.on('unexpected-response', (_r, resp) => res(resp.statusCode!));
      ws.on('open', () => res(101));
    });
    expect(bad).toBe(401);
    p1.destroy();
    p2.destroy();
    collab.close();
    await new Promise((r) => server.close(r));
  });
});
