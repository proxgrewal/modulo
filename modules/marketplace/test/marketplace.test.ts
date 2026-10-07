import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteDb, invokeRoute, Kernel, type SiteContext } from '@modulo/kernel';
import type { AppPackage } from '@modulo/sandbox';
import marketplace, { canonicalJson, generatePublisherKeys, onKernelBoot, signPackage, trustPublisher, verifyPackage, type SignedPackage } from '../src/index.ts';

const app = (version = '1.0.0', code?: string, caps = ['emit:app-hello.*']): AppPackage => ({
  manifest: {
    name: 'app-hello',
    version,
    kernel: '^1.0.0',
    label: 'Hello',
    description: 'Says hello',
    capabilities: caps,
    routes: [
      { method: 'GET', path: '/hello', surface: 'api', permission: 'public' },
      { method: 'POST', path: '/notes', surface: 'api' },
      { method: 'GET', path: '/notes', surface: 'api' },
    ],
    settings: { greeting: { kind: 'text', default: 'Hello' } },
    models: [{ name: 'app_hello.note', fields: { text: { kind: 'text' } } }],
  },
  code:
    code ??
    `app.route('GET', '/hello', async (req) => ({ body: { msg: (await host.settings()).greeting + ', ' + (req.query.name || 'world'), v: '${version}' } }));
     app.route('POST', '/notes', async (req) => host.repo('app_hello.note').create({ text: req.body.text }));
     app.route('GET', '/notes', async () => (await host.repo('app_hello.note').find()).map((n) => n.text));`,
});

describe('signing', () => {
  const keys = generatePublisherKeys();
  const signed = signPackage(app(), keys.privateKey);

  it('signs and verifies; trust tier depends on the trusted list', () => {
    expect(verifyPackage(signed)).toMatchObject({ ok: true, trust: 'community' });
    expect(verifyPackage(signed, [keys.publicKey])).toMatchObject({ ok: true, trust: 'verified' });
    // raw 32-byte public key form is accepted for both the package and the trusted list
    const raw = Buffer.from(keys.publicKey, 'base64').subarray(-32).toString('base64');
    expect(verifyPackage({ ...signed, publisherKey: raw }, [raw])).toMatchObject({ ok: true, trust: 'verified' });
    expect(verifyPackage(signed, [generatePublisherKeys().publicKey])).toMatchObject({ ok: true, trust: 'community' });
  });

  it('detects tampering of code, manifest, signature or key', () => {
    expect(verifyPackage({ ...signed, code: signed.code + ';host.fetch("https://evil")' })).toEqual({ ok: false, error: expect.stringMatching(/signature/) });
    const m = structuredClone(signed);
    m.manifest.capabilities.push('read:shop.customer');
    expect(verifyPackage(m).ok).toBe(false);
    expect(verifyPackage({ ...signed, publisherKey: generatePublisherKeys().publicKey }).ok).toBe(false);
    expect(verifyPackage({ ...signed, signature: Buffer.alloc(64).toString('base64') }).ok).toBe(false);
    expect(verifyPackage({ ...signed, publisherKey: 'bm90IGEga2V5' })).toEqual({ ok: false, error: expect.stringMatching(/invalid publisher key/) });
    expect(verifyPackage({ manifest: signed.manifest, code: signed.code } as SignedPackage)).toEqual({ ok: false, error: 'package is not signed' });
  });

  it('uses canonical JSON so key order does not matter', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined, e: 'x' }] })).toBe('{"a":[{"d":1,"e":"x"}],"b":1}');
    const reordered: SignedPackage = { ...signed, manifest: Object.fromEntries(Object.entries(signed.manifest).reverse()) as any };
    expect(verifyPackage(reordered).ok).toBe(true);
  });
});

describe('marketplace module', () => {
  let kernel: Kernel;
  let dir: string | null = null;
  afterEach(async () => {
    await kernel?.close().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function setup(dataDir?: string) {
    kernel = await Kernel.create({ db: await createPgliteDb(dataDir), modules: [marketplace] });
    await onKernelBoot(kernel);
  }
  async function people() {
    const root = await kernel.createUser({ email: `root${Math.random()}@x.io`, password: 'password1', superadmin: true });
    const owner = await kernel.createUser({ email: `owner${Math.random()}@x.io`, password: 'password1' });
    const editor = await kernel.createUser({ email: `ed${Math.random()}@x.io`, password: 'password1' });
    const site = await kernel.createSite({ slug: `s${Date.now() % 100000}`, name: 'S', ownerId: owner.id, modules: { marketplace: '*' } });
    await kernel.addMember(site.id, editor.id, 'editor');
    const as = (u: { id: string }) => kernel.context(site.id, u.id);
    return { site, root, owner, editor, as };
  }
  const mp = (ctx: SiteContext, method: string, path: string, body?: unknown) => invokeRoute(ctx, { module: 'marketplace', method, path, body });
  const hello = (ctx: SiteContext, method = 'GET', path = '/hello', body?: unknown) => invokeRoute(ctx, { module: 'app-hello', method, path, body, query: { name: 'Ada' } });

  it('upload → consent → install → app route works → uninstall', async () => {
    await setup();
    const { root, owner, editor, as, site } = await people();
    const keys = generatePublisherKeys();
    const signed = signPackage(app(), keys.privateKey);

    // Publishing is superadmin-only, even for the site owner (who holds "*").
    await expect(mp(await as(owner), 'POST', '/packages', signed)).rejects.toMatchObject({ status: 403 });
    await expect(mp(await as(editor), 'POST', '/packages', signed)).rejects.toMatchObject({ status: 403 });
    const pub = await mp(await as(root), 'POST', '/packages', signed);
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ name: 'app-hello', version: '1.0.0', trust: 'community', capabilities: ['emit:app-hello.*'] });

    const list = (await mp(await as(editor), 'GET', '/packages')).body as any[];
    expect(list).toEqual([
      expect.objectContaining({ name: 'app-hello', latest: '1.0.0', trust: 'community', installed: false, capabilities: ['emit:app-hello.*'] }),
    ]);

    // Install needs marketplace.install (owner/admin), and explicit capability consent.
    await expect(mp(await as(editor), 'POST', '/packages/app-hello/install', { acceptCapabilities: ['emit:app-hello.*'] })).rejects.toMatchObject({ status: 403 });
    const noConsent = await mp(await as(owner), 'POST', '/packages/app-hello/install', {}).catch((e) => e);
    expect(noConsent).toMatchObject({ status: 400, details: { capabilities: ['emit:app-hello.*'] } });
    expect(noConsent.message).toMatch(/requires consent to its capabilities: emit:app-hello\.\*/);
    await expect(mp(await as(owner), 'POST', '/packages/app-hello/install', { acceptCapabilities: [] })).rejects.toMatchObject({ status: 400 });
    await expect(mp(await as(owner), 'POST', '/packages/app-hello/install', { acceptCapabilities: ['emit:app-hello.*', 'read:shop.product'] })).rejects.toMatchObject({ status: 400 });
    const inst = await mp(await as(owner), 'POST', '/packages/app-hello/install', { acceptCapabilities: ['emit:app-hello.*'] });
    expect(inst.body).toMatchObject({ installed: { name: 'app-hello', version: '1.0.0' }, trust: 'community' });

    const anon = await kernel.context(site.id, null);
    expect((await hello(anon)).body).toEqual({ msg: 'Hello, Ada', v: '1.0.0' });
    await hello(await as(owner), 'POST', '/notes', { text: 'first' });
    expect((await hello(await as(owner), 'GET', '/notes')).body).toEqual(['first']);
    expect(((await mp(await as(owner), 'GET', '/packages')).body as any[])[0]).toMatchObject({ installed: true, installedVersion: '1.0.0' });
    const consents = (await kernel.db.query(`SELECT name, version, capabilities, user_id FROM marketplace_consents`)).rows;
    expect(consents).toEqual([{ name: 'app-hello', version: '1.0.0', capabilities: ['emit:app-hello.*'], user_id: owner.id }]);

    // Upgrade: publish 1.1.0 and install it (consent again).
    await mp(await as(root), 'POST', '/packages', signPackage(app('1.1.0'), keys.privateKey));
    await mp(await as(owner), 'POST', '/packages/app-hello/install', { acceptCapabilities: ['emit:app-hello.*'] });
    expect((await hello(await kernel.context(site.id, null))).body).toMatchObject({ v: '1.1.0' });

    const un = await mp(await as(owner), 'POST', '/packages/app-hello/uninstall');
    expect(un.body).toEqual({ removed: [{ name: 'app-hello', version: '1.1.0' }] });
    await expect(hello(await kernel.context(site.id, null))).rejects.toThrow(/No api route/);
  });

  it('assigns trust tiers and rejects bad, hijacked or conflicting uploads', async () => {
    await setup();
    const { root, owner, as, site } = await people();
    const keys = generatePublisherKeys();
    const signed = signPackage(app(), keys.privateKey);
    const rootCtx = await as(root);

    // invalid signature -> rejected
    const bad = await mp(rootCtx, 'POST', '/packages', { ...signed, code: signed.code + '//x' }).catch((e) => e);
    expect(bad).toMatchObject({ status: 400 });
    expect(bad.message).toMatch(/Rejected package: signature does not match/);
    // structurally invalid but correctly signed -> 400 with problems
    const invalid = signPackage({ ...app(), manifest: { ...app().manifest, capabilities: ['sudo:all'] } }, keys.privateKey);
    await expect(mp(rootCtx, 'POST', '/packages', invalid)).rejects.toThrow(/malformed capability "sudo:all"/);

    await mp(rootCtx, 'POST', '/packages', signed);
    // idempotent re-upload; same version with different content conflicts
    expect((await mp(rootCtx, 'POST', '/packages', signed)).body).toMatchObject({ duplicate: true });
    await expect(mp(rootCtx, 'POST', '/packages', signPackage(app('1.0.0', `app.route('GET','/hello',()=>1)`), keys.privateKey))).rejects.toMatchObject({ status: 409 });
    // another publisher cannot take over the name
    await expect(mp(rootCtx, 'POST', '/packages', signPackage(app('2.0.0'), generatePublisherKeys().privateKey))).rejects.toThrow(/different publisher/);

    const tier = async () => ((await mp(await as(owner), 'GET', '/packages')).body as any[])[0].trust;
    expect(await tier()).toBe('community');
    // per-site trusted list (module setting)
    await kernel.updateModuleSettings(site.id, 'marketplace', { trustedPublishers: keys.publicKey });
    expect(await tier()).toBe('verified');
    await kernel.updateModuleSettings(site.id, 'marketplace', { trustedPublishers: '' });
    expect(await tier()).toBe('community');
    // global trusted table
    await trustPublisher(kernel.db, keys.publicKey, 'Acme Apps');
    expect(await tier()).toBe('verified');

    // Sites can refuse community packages.
    const other = generatePublisherKeys();
    await mp(rootCtx, 'POST', '/packages', signPackage({ ...app(), manifest: { ...app().manifest, name: 'app-other', routes: [], models: [] } }, other.privateKey));
    await kernel.updateModuleSettings(site.id, 'marketplace', { allowCommunity: false });
    await expect(mp(await as(owner), 'POST', '/packages/app-other/install', { acceptCapabilities: ['emit:app-hello.*'] })).rejects.toThrow(/only allows verified/);

    // A row tampered with in the database is never installed.
    await kernel.db.query(`UPDATE marketplace_packages SET code = code || '/*evil*/' WHERE name='app-hello'`);
    await expect(mp(await as(owner), 'POST', '/packages/app-hello/install', { acceptCapabilities: ['emit:app-hello.*'] })).rejects.toThrow(/Refusing to install.*signature/);
  });

  it('survives a restart: packages are re-registered from the database at boot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'modulo-mp-'));
    await setup(join(dir, 'pg'));
    const { root, owner, site } = await people();
    const keys = generatePublisherKeys();
    await mp(await kernel.context(site.id, root.id), 'POST', '/packages', signPackage(app(), keys.privateKey));
    await mp(await kernel.context(site.id, owner.id), 'POST', '/packages/app-hello/install', { acceptCapabilities: ['emit:app-hello.*'] });
    await hello(await kernel.context(site.id, owner.id), 'POST', '/notes', { text: 'persisted' });
    await kernel.close();

    // Kernel B: fresh process state, same database.
    kernel = await Kernel.create({ db: await createPgliteDb(join(dir, 'pg')), modules: [marketplace] });
    await expect(kernel.context(site.id, null)).rejects.toThrow(/not in the catalog/); // before boot hook
    await onKernelBoot(kernel);
    const ctx = await kernel.context(site.id, owner.id);
    expect((await hello(ctx)).body).toEqual({ msg: 'Hello, Ada', v: '1.0.0' });
    expect((await hello(ctx, 'GET', '/notes')).body).toEqual(['persisted']);
  });
});
