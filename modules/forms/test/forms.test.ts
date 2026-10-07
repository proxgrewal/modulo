import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, defineModule, invokeRoute, Kernel, type SiteContext } from '@modulo/kernel';
import { loadData, renderDocument, type PageNode } from '@modulo/core';
import forms, { csvCell, ISLAND_SCRIPT, normaliseFields, RateLimiter, submissionLimiter, toCsv, validateSubmission } from '../src/index.ts';
import { coreStub } from './stubs.ts';

const sent: any[] = [];
const mailer = defineModule({
  name: 'mailer',
  version: '1.0.0',
  kernel: '^1.0.0',
  hooks: [
    {
      hook: 'mail.send',
      kind: 'filter',
      fn: (res: any, msg: any) => {
        sent.push(msg);
        return { ...res, sent: true, transport: 'test' };
      },
    },
  ],
});

const FIELDS = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'topic', label: 'Topic', type: 'select', options: ['Sales', 'Support'], required: true },
  { name: 'message', label: 'Message', type: 'textarea' },
  { name: 'agree', label: 'I agree', type: 'checkbox', required: true },
  { name: 'qty', label: 'Quantity', type: 'number' },
];

describe('validation helpers', () => {
  const fields = normaliseFields(FIELDS);

  it('normalises field definitions defensively', () => {
    expect(normaliseFields([{ name: 'ok', type: 'weird' }, { name: '1bad' }, { name: '_hp' }, null, { name: 'ok' }, 'x'])).toEqual([
      { name: 'ok', label: 'ok', type: 'text', required: false, options: [] },
    ]);
    expect(normaliseFields('nope')).toEqual([]);
  });

  it('enforces required, email format, select options, checkbox and max length', () => {
    const r = validateSubmission(fields, { email: 'not-an-email', topic: 'Hacking', message: 'x'.repeat(5001), qty: '12abc' });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['agree', 'email', 'message', 'name', 'qty', 'topic']);
    expect(r.errors.name).toMatch(/required/);
    expect(r.errors.email).toMatch(/valid email/);
    expect(r.errors.topic).toMatch(/options/);
    expect(r.errors.message).toMatch(/5000/);

    const ok = validateSubmission(fields, { name: ' Ada\nL ', email: 'ada@example.com', topic: 'Sales', agree: 'on', qty: '3', extra: 'dropped', message: 'x'.repeat(5000) });
    expect(ok.ok).toBe(true);
    expect(ok.data).toMatchObject({ name: 'Ada L', email: 'ada@example.com', topic: 'Sales', agree: true, qty: 3 });
    expect('extra' in ok.data).toBe(false);
    expect(validateSubmission(fields, { name: { $gt: '' }, email: 'a@b.co', topic: 'Sales', agree: true }).errors.name).toMatch(/invalid/);
    for (const bad of ['a@b', 'a b@c.de', '<a@b.cd>', '@b.cd', 'a@b.c']) expect(validateSubmission(fields, { name: 'x', email: bad, topic: 'Sales', agree: true }).errors.email, bad).toBeTruthy();
  });

  it('escapes CSV cells and guards against formula injection', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1+2')).toBe("'+1+2");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell(' =1')).toBe("' =1");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(toCsv([['a', 'b'], [1, '=x']])).toBe("a,b\r\n1,'=x\r\n");
  });

  it('rate limiter allows N per window', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit('k', 0)).toBe(true);
    expect(rl.hit('k', 10)).toBe(true);
    expect(rl.hit('k', 20)).toBe(false);
    expect(rl.hit('other', 20)).toBe(true);
    expect(rl.hit('k', 1011)).toBe(true);
  });

  it('island script stays within its 2KB budget', () => {
    expect(ISLAND_SCRIPT.length).toBeLessThan(2048);
    expect(() => new Function(`return (${ISLAND_SCRIPT})`)).not.toThrow();
  });
});

describe('forms module', () => {
  let kernel: Kernel;
  let siteId: string;
  let noMailSiteId: string;
  let sudo: SiteContext;
  let editorId: string;
  let formId: string;

  beforeAll(async () => {
    kernel = await Kernel.create({ db: await createPgliteDb(), modules: [coreStub, forms, mailer] });
    const site = await kernel.createSite({ slug: 't', name: 'T', modules: { forms: '*', mailer: '*' } });
    siteId = site.id;
    noMailSiteId = (await kernel.createSite({ slug: 'n', name: 'N', modules: { forms: '*' } })).id;
    sudo = await kernel.context(siteId, null, { sudo: true });
    const form = await sudo.repo('forms.form').create({ name: 'Lead Form', fields: FIELDS, notify_email: 'owner@example.com', success_message: 'Got it!' });
    formId = form.id;
    const u = await kernel.createUser({ email: 'ed@x.io', password: 'password1' });
    await kernel.addMember(siteId, u.id, 'editor');
    editorId = u.id;
  });
  afterAll(async () => kernel?.close());
  beforeEach(() => submissionLimiter.reset());

  const submit = async (body: unknown, ip = '1.2.3.4', id = formId) =>
    invokeRoute(await kernel.context(siteId, null), { module: 'forms', method: 'POST', path: `/forms/${id}/submit`, body, headers: { 'x-forwarded-for': ip, 'user-agent': 'vitest' } });

  const valid = { name: 'Ada', email: 'ada@example.com', topic: 'Support', agree: true, message: 'Hello' };

  it('ships a sample contact form', async () => {
    expect(await sudo.repo('forms.form').findOne({ name: 'Contact' })).toBeTruthy();
  });

  it('rejects invalid submissions server-side with per-field errors', async () => {
    const r = await submit({ email: 'nope', topic: 'Other' });
    expect(r.status).toBe(422);
    expect((r.body as any).ok).toBe(false);
    expect(Object.keys((r.body as any).errors).sort()).toEqual(['agree', 'email', 'name', 'topic']);
    expect(await sudo.repo('forms.submission').count({ form: formId })).toBe(0);
    expect((await submit(valid, '1.1.1.1', '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await submit(valid, '1.1.1.1', 'not-a-uuid')).status).toBe(404);
  });

  it('stores valid submissions with a hashed ip and notifies via mail.send', async () => {
    sent.length = 0;
    const r = await submit(valid, '9.9.9.9');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Got it!', redirect: null });
    const [sub] = await sudo.repo('forms.submission').find({ where: { form: formId, status: 'new' } });
    expect(sub!.data).toMatchObject({ name: 'Ada', email: 'ada@example.com', agree: true });
    expect(sub!.meta.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(sub!.meta)).not.toContain('9.9.9.9');
    expect(sub!.meta.user_agent).toBe('vitest');

    await kernel.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'owner@example.com', subject: 'New submission: Lead Form (T)', replyTo: 'ada@example.com' });
    expect(sent[0].text).toContain('Name: Ada');
    const after = await sudo.repo('forms.submission').get(sub!.id);
    expect(after.meta.notification).toMatchObject({ sent: true, transport: 'test', to: 'owner@example.com' });
    expect(after.meta.ip_hash).toBe(sub!.meta.ip_hash);
  });

  it('falls back to console logging when no mailer is installed', async () => {
    const ctx = await kernel.context(noMailSiteId, null, { sudo: true });
    const form = await ctx.repo('forms.form').create({ name: 'F', fields: [{ name: 'q', label: 'Q', type: 'text' }] });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await invokeRoute(await kernel.context(noMailSiteId, null), { module: 'forms', method: 'POST', path: `/forms/${form.id}/submit`, body: { q: 'hi' } });
    expect(r.status).toBe(200);
    await kernel.drain();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[forms] mail.send'))).toBe(true);
    spy.mockRestore();
    const [sub] = await ctx.repo('forms.submission').find({ where: { form: form.id } });
    expect(sub!.meta.notification).toMatchObject({ sent: false, transport: 'console' });
  });

  it('silently stores honeypot submissions as spam without notifying', async () => {
    sent.length = 0;
    const r = await submit({ ...valid, _hp: 'http://spam.example' }, '5.5.5.5');
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
    const spam = await sudo.repo('forms.submission').find({ where: { form: formId, status: 'spam' } });
    expect(spam).toHaveLength(1);
    await kernel.drain();
    expect(sent).toHaveLength(0);
  });

  it('rate limits per ip hash per form', async () => {
    for (let i = 0; i < 5; i++) expect((await submit({ email: 'x' }, '7.7.7.7')).status).toBe(422);
    const blocked = await submit(valid, '7.7.7.7');
    expect(blocked.status).toBe(429);
    expect((blocked.body as any).error).toMatch(/Too many/);
    expect((await submit(valid, '8.8.8.8')).status).toBe(200);
  });

  it('protects submissions and exports escaped CSV', async () => {
    const anon = await kernel.context(siteId, null);
    await expect(invokeRoute(anon, { module: 'forms', method: 'GET', path: `/forms/${formId}/submissions` })).rejects.toThrow();
    await expect(anon.repo('forms.submission').find()).rejects.toThrow();
    const nonEditor = await kernel.createUser({ email: 'v@x.io', password: 'password1' });
    await kernel.addMember(siteId, nonEditor.id, 'viewer');
    await expect(invokeRoute(await kernel.context(siteId, nonEditor.id), { module: 'forms', method: 'GET', path: `/forms/${formId}/export.csv` })).rejects.toThrow(/forms.manage/);

    await submit({ ...valid, name: '=HYPERLINK("http://evil","click")', message: 'line1\nline2, "quoted"', topic: 'Sales' }, '6.6.6.6');
    await submit({ ...valid, name: '@SUM(1+1)', message: '+cmd|calc' }, '6.6.6.7');
    const ed = await kernel.context(siteId, editorId);
    const list = await invokeRoute(ed, { module: 'forms', method: 'GET', path: `/forms/${formId}/submissions`, query: { status: 'new' } });
    expect((list.body as any).total).toBeGreaterThanOrEqual(3);

    const csv = await invokeRoute(ed, { module: 'forms', method: 'GET', path: `/forms/${formId}/export.csv` });
    expect(csv.headers!['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers!['content-disposition']).toBe('attachment; filename="lead-form-submissions.csv"');
    const text = String(csv.body).replace(/^﻿/, '');
    expect(text.split('\r\n')[0]).toBe('submitted_at,status,Name,Email,Topic,Message,I agree,Quantity');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(text).toContain(`"line1\nline2, ""quoted"""`);
    expect(text).toContain(`'@SUM(1+1)`);
    expect(text).toContain(`'+cmd|calc`);
    expect(text).not.toMatch(/(^|,)[=+@]/m);
  });

  it('renders accessible markup with a base-prefixed island endpoint and honeypot', async () => {
    const anon = await kernel.context(siteId, null);
    const tree: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'contact', type: 'forms:form', props: { form: formId } }] } };
    const scope = { path: '/contact', params: {}, query: {}, base: '/s/t' };
    const registry = anon.runtime.blocks;
    const data = await loadData(tree, registry, { siteId, scope, services: { ctx: anon } });
    const out = renderDocument(tree, { registry, theme: kernel.theme(anon.site), title: 'Contact', scope, data });
    const html = out.document;
    expect(html).toContain(`data-island="forms:form"`);
    expect(html).toContain(`data-props="{&quot;endpoint&quot;:&quot;/s/t/_api/m/forms/forms/${formId}/submit&quot;}"`);
    expect(html).toContain(`action="/s/t/forms/${formId}/submit"`);
    expect(html).toContain('method="post"');
    expect(html).toMatch(/<label for="f-contact-email">Email<span class="forms-req" aria-hidden="true"> \*<\/span><\/label>/);
    expect(html).toMatch(/<input id="f-contact-email" name="email" required aria-required="true" aria-describedby="f-contact-email-err" type="email"/);
    expect(html).toContain('<option value="Support">Support</option>');
    expect(html).toContain('<textarea id="f-contact-message" name="message" aria-describedby="f-contact-message-err" rows="5" maxlength="5000">');
    expect(html).toMatch(/<div class="forms-hp" aria-hidden="true"><label for="f-contact-hp">[^<]+<\/label><input id="f-contact-hp" type="text" name="_hp" tabindex="-1" autocomplete="off"/);
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain('owner@example.com');
    expect(out.islands.has('forms:form')).toBe(true);
  });

  it('works without JavaScript via the site route', async () => {
    const anon = await kernel.context(siteId, null);
    const body = new URLSearchParams({ name: 'No JS <b>', email: 'nojs@example.com', topic: 'Sales', agree: 'on' }).toString();
    const r = await invokeRoute(anon, { surface: 'site', method: 'POST', path: `/forms/${formId}/submit`, body, headers: { 'x-forwarded-for': '4.4.4.4', referer: '/contact' } });
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain('Got it!');
    expect(String(r.body)).toContain('href="/contact"');
    const bad = await invokeRoute(anon, { surface: 'site', method: 'POST', path: `/forms/${formId}/submit`, body: 'email=%3Cscript%3E', headers: { 'x-forwarded-for': '4.4.4.5' } });
    expect(bad.status).toBe(422);
    expect(String(bad.body)).not.toContain('<script>');
    await sudo.repo('forms.form').update(formId, { redirect: '/thanks' });
    const redir = await invokeRoute(anon, { surface: 'site', method: 'POST', path: `/forms/${formId}/submit`, body, headers: { 'x-forwarded-for': '4.4.4.6', 'x-modulo-base': '/s/t' } });
    expect(redir.status).toBe(303);
    expect(redir.headers!.location).toBe('/s/t/thanks');
    await sudo.repo('forms.form').update(formId, { redirect: null });
  });

  it('cascades submissions when a form is deleted', async () => {
    const f = await sudo.repo('forms.form').create({ name: 'Temp', fields: [{ name: 'a', label: 'A', type: 'text' }] });
    await invokeRoute(await kernel.context(siteId, null), { module: 'forms', method: 'POST', path: `/forms/${f.id}/submit`, body: { a: '1' } });
    expect(await sudo.repo('forms.submission').count({ form: f.id })).toBe(1);
    await sudo.repo('forms.form').delete(f.id);
    expect(await sudo.repo('forms.submission').count({ form: f.id })).toBe(0);
  });
});
