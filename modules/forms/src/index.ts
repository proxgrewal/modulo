import { defineModule, type RouteRequest, type RouteResponse, type SiteContext } from '@modulo/kernel';
import { defineBlock, defineModel, escapeHtml, f, h, mf, safeUrl, type VNode } from '@modulo/core';
import { toCsv } from './csv.ts';
import { hashIp, submissionLimiter } from './ratelimit.ts';
import { HONEYPOT, MAX_LENGTH, normaliseFields, parseBody, validateSubmission, type FormFieldDef } from './validate.ts';

export { csvCell, toCsv } from './csv.ts';
export { RateLimiter, submissionLimiter, hashIp } from './ratelimit.ts';
export { normaliseFields, validateSubmission, parseBody, HONEYPOT, MAX_LENGTH, type FormFieldDef } from './validate.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SUCCESS = 'Thank you! Your submission has been received.';

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

function clientIp(ctx: SiteContext, headers: Record<string, string>): string {
  const fwd = header(headers, 'x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || header(headers, 'x-real-ip')?.trim() || String(ctx.meta?.ip ?? '') || 'unknown';
}

function requestBase(ctx: SiteContext, headers: Record<string, string>): string {
  const b = (ctx.meta?.base as string | undefined) ?? header(headers, 'x-modulo-base') ?? '';
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(b) ? b : '';
}

export interface SubmitResult {
  status: number;
  ok: boolean;
  message?: string;
  redirect?: string | null;
  errors?: Record<string, string>;
  error?: string;
}

/**
 * Validate and store a submission. Anonymous-safe: runs data access as sudo
 * and never reveals form internals (notify email) to the caller.
 */
export async function submitForm(ctx: SiteContext, formId: string, body: unknown, headers: Record<string, string> = {}): Promise<SubmitResult> {
  const sudo = ctx.asSudo();
  if (!UUID_RE.test(formId)) return { status: 404, ok: false, error: 'Form not found' };
  const form = await sudo.repo('forms.form').findOne({ id: formId });
  if (!form) return { status: 404, ok: false, error: 'Form not found' };

  const ipHash = await hashIp(clientIp(ctx, headers), ctx.site.id);
  if (!submissionLimiter.hit(`${ctx.site.id}:${form.id}:${ipHash}`)) {
    return { status: 429, ok: false, error: 'Too many submissions. Please wait a minute and try again.' };
  }

  const input = parseBody(body);
  const fields = normaliseFields(form.fields);
  const result = validateSubmission(fields, input);
  const meta = { ip_hash: ipHash, user_agent: String(header(headers, 'user-agent') ?? '').slice(0, 500) };
  const success: SubmitResult = { status: 200, ok: true, message: String(form.success_message || DEFAULT_SUCCESS), redirect: form.redirect || null };

  const hp = input[HONEYPOT];
  if (hp !== undefined && hp !== null && String(hp).trim() !== '') {
    // Bots fill hidden fields: store quietly as spam and pretend it worked.
    await sudo.repo('forms.submission').create({ form: form.id, data: result.data, meta: { ...meta, honeypot: true }, status: 'spam' });
    return success;
  }
  if (!result.ok) return { status: 422, ok: false, error: 'Please correct the highlighted fields.', errors: result.errors };

  await sudo.repo('forms.submission').create({ form: form.id, data: result.data, meta, status: 'new' });
  return success;
}

/* ───────────────────────── block ───────────────────────── */

const FORM_CSS =
  '.forms-form form{display:grid;gap:var(--space-md,16px);max-width:var(--form-width,560px);position:relative}' +
  '.forms-field{display:grid;gap:var(--space-xs,6px)}.forms-field--check{display:flex;align-items:center;gap:var(--space-sm,8px)}' +
  '.forms-field label{font-weight:600}.forms-req{color:var(--color-danger,#c0392b)}' +
  '.forms-field input:not([type=checkbox]),.forms-field textarea,.forms-field select{font:inherit;padding:var(--space-sm,8px) var(--space-md,12px);border:1px solid var(--color-border,#ccd);border-radius:var(--radius-sm,4px);background:var(--color-bg,#fff);color:inherit}' +
  '.forms-field [aria-invalid=true]{border-color:var(--color-danger,#c0392b)}.forms-error{color:var(--color-danger,#c0392b);font-size:.9em;margin:0;min-height:0}' +
  '.forms-hp{position:absolute!important;left:-10000px!important;width:1px;height:1px;overflow:hidden}' +
  '.forms-submit{justify-self:start;font:inherit;padding:var(--space-sm,10px) var(--space-lg,20px);border:0;border-radius:var(--radius-md,6px);background:var(--color-primary);color:var(--color-on-primary,#fff);cursor:pointer}' +
  '.forms-submit[disabled]{opacity:.6}.forms-status:empty{display:none}';

/** Hydration script: JSON submit with inline errors; the form still works as a plain POST without JS. */
export const ISLAND_SCRIPT =
  "(el,p)=>{const f=el.querySelector('form');if(!f||!p.endpoint)return;const st=el.querySelector('[data-status]');" +
  "f.addEventListener('submit',async e=>{e.preventDefault();const d={};new FormData(f).forEach((v,k)=>{d[k]=v});" +
  "f.querySelectorAll('input[type=checkbox]').forEach(c=>{d[c.name]=c.checked});" +
  "el.querySelectorAll('[data-err]').forEach(x=>{x.textContent=''});f.querySelectorAll('[aria-invalid]').forEach(x=>x.removeAttribute('aria-invalid'));" +
  "const b=f.querySelector('[type=submit]');if(b)b.disabled=true;st.textContent='Sending...';" +
  "try{const r=await fetch(p.endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(d)});" +
  "const j=await r.json().catch(()=>({}));if(r.ok&&j.ok){if(j.redirect){location.assign(j.redirect);return}f.reset();st.textContent=j.message||'Thank you!'}" +
  "else{let first;const er=j.errors||{};for(const k in er){const x=el.querySelector('[data-err=\"'+CSS.escape(k)+'\"]');const i=f.elements.namedItem(k);" +
  "if(x)x.textContent=er[k];if(i&&i.setAttribute){i.setAttribute('aria-invalid','true');first=first||i}}" +
  "st.textContent=j.error||'Please check the form and try again.';if(first&&first.focus)first.focus()}}" +
  "catch(_){st.textContent='Network error. Please try again.'}finally{if(b)b.disabled=false}})}";

interface FormData_ {
  form: { id: string; name: string; fields: FormFieldDef[] } | null;
  base: string;
}

function fieldControl(fd: FormFieldDef, uid: string): VNode {
  const id = `${uid}-${fd.name}`;
  const errId = `${id}-err`;
  const common = {
    id,
    name: fd.name,
    required: fd.required,
    'aria-required': fd.required ? 'true' : undefined,
    'aria-describedby': errId,
  };
  const label = h('label', { for: id }, fd.label, fd.required ? h('span', { class: 'forms-req', 'aria-hidden': 'true' }, ' *') : null);
  const err = h('p', { class: 'forms-error', id: errId, 'data-err': fd.name });
  if (fd.type === 'checkbox') {
    return h('div', { class: 'forms-field forms-field--check' }, h('input', { ...common, type: 'checkbox', value: 'on' }), label, err);
  }
  let control: VNode;
  if (fd.type === 'textarea') control = h('textarea', { ...common, rows: 5, maxlength: MAX_LENGTH });
  else if (fd.type === 'select')
    control = h('select', common, h('option', { value: '' }, 'Choose...'), ...fd.options.map((o) => h('option', { value: o }, o)));
  else if (fd.type === 'email') control = h('input', { ...common, type: 'email', autocomplete: 'email', maxlength: 254 });
  else if (fd.type === 'number') control = h('input', { ...common, type: 'number', step: 'any', inputmode: 'decimal' });
  else control = h('input', { ...common, type: 'text', maxlength: MAX_LENGTH });
  return h('div', { class: 'forms-field' }, label, control, err);
}

const formBlock = defineBlock<{ form: string; submitLabel: string }, FormData_>({
  type: 'forms:form',
  version: 1,
  label: 'Form',
  category: 'Forms',
  icon: 'form',
  description: 'Embed a form built in the Forms collection.',
  fields: {
    form: f.collection({ label: 'Form', model: 'forms.form' }),
    submitLabel: f.text({ label: 'Button label', default: 'Send' }),
  },
  css: FORM_CSS,
  island: { name: 'forms:form', script: ISLAND_SCRIPT },
  jsBudget: 2048,
  islandProps: (_props, data) => (data?.form ? { endpoint: `${data.base}/_api/m/forms/forms/${encodeURIComponent(data.form.id)}/submit` } : {}),
  load: async (props, { services, scope }) => {
    const base = String(scope.base ?? '');
    const ctx = services?.ctx as SiteContext | undefined;
    const id = String(props.form ?? '');
    if (!ctx || !UUID_RE.test(id)) return { form: null, base };
    const rec = await ctx.asSudo().repo('forms.form').findOne({ id });
    return { form: rec ? { id: rec.id, name: String(rec.name ?? ''), fields: normaliseFields(rec.fields) } : null, base };
  },
  render: (props, ctx) => {
    const form = ctx.data?.form ?? null;
    if (!form) {
      return ctx.root('div', { class: 'forms-form forms-form--empty' }, ctx.mode === 'edit' ? h('p', null, 'Choose a form in the inspector.') : null);
    }
    const base = String(ctx.data?.base ?? ctx.scope.base ?? '');
    const uid = `f-${ctx.node.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const hpId = `${uid}-hp`;
    return ctx.root(
      'div',
      { class: 'forms-form' },
      h(
        'form',
        { method: 'post', action: `${base}/forms/${encodeURIComponent(form.id)}/submit`, 'accept-charset': 'utf-8', 'aria-label': form.name || 'Form' },
        ...form.fields.map((fd) => fieldControl(fd, uid)),
        h(
          'div',
          { class: 'forms-hp', 'aria-hidden': 'true' },
          h('label', { for: hpId }, 'Leave this field empty'),
          h('input', { id: hpId, type: 'text', name: HONEYPOT, tabindex: '-1', autocomplete: 'off', value: '' }),
        ),
        h('div', { class: 'forms-status', role: 'status', 'aria-live': 'polite', 'data-status': '' }),
        h('button', { type: 'submit', class: 'forms-submit' }, props.submitLabel || 'Send'),
      ),
    );
  },
});

/* ───────────────────────── no-JS responses ───────────────────────── */

function htmlPage(title: string, inner: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 16px;line-height:1.6}</style></head><body>${inner}</body></html>`
  );
}

function backLink(req: RouteRequest, base: string): string {
  const ref = header(req.headers, 'referer') ?? '';
  const host = header(req.headers, 'host');
  let target = `${base}/`;
  if (ref.startsWith('/') && !ref.startsWith('//')) target = ref;
  else if (host) {
    try {
      const u = new URL(ref);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host === host) target = u.pathname + u.search;
    } catch {
      /* ignore */
    }
  }
  return safeUrl(target);
}

async function siteSubmit(req: RouteRequest): Promise<RouteResponse> {
  const base = requestBase(req.ctx, req.headers);
  const r = await submitForm(req.ctx, String(req.params.id ?? ''), req.body, req.headers);
  const back = `<p><a href="${escapeHtml(backLink(req, base))}">Go back</a></p>`;
  if (r.ok) {
    if (r.redirect) {
      const loc = r.redirect.startsWith('/') && !r.redirect.startsWith('//') ? `${base}${r.redirect}` : r.redirect;
      return { status: 303, headers: { location: safeUrl(loc) }, body: '' };
    }
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: htmlPage('Thank you', `<h1>Thank you</h1><p>${escapeHtml(r.message ?? DEFAULT_SUCCESS)}</p>${back}`) };
  }
  const list = r.errors ? `<ul>${Object.values(r.errors).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : '';
  return {
    status: r.status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: htmlPage('Submission problem', `<h1>Something went wrong</h1><p role="alert">${escapeHtml(r.error ?? 'Error')}</p>${list}${back}`),
  };
}

/* ───────────────────────── module ───────────────────────── */

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);

export default defineModule({
  name: 'forms',
  version: '1.0.0',
  label: 'Forms',
  description: 'Contact and lead forms with spam protection, notifications and CSV export.',
  category: 'content',
  kernel: '^1.0.0',
  models: [
    defineModel({
      name: 'forms.form',
      label: 'Form',
      titleField: 'name',
      fields: {
        name: mf.string({ required: true, label: 'Name' }),
        fields: mf.json({ label: 'Fields', default: [] }),
        success_message: mf.text({ label: 'Success message' }),
        notify_email: mf.email({ label: 'Notify email', private: true }),
        redirect: mf.url({ label: 'Redirect after submit' }),
      },
    }),
    defineModel({
      name: 'forms.submission',
      label: 'Submission',
      order: 'created_at desc',
      fields: {
        form: mf.ref('forms.form', { required: true, onDelete: 'cascade', index: true, label: 'Form' }),
        data: mf.json({ label: 'Data' }),
        meta: mf.json({ label: 'Meta', private: true }),
        status: mf.enum(['new', 'read', 'spam'], { default: 'new', index: true, label: 'Status' }),
      },
      access: { read: 'forms.manage' },
    }),
  ],
  blocks: [formBlock],
  hooks: [
    {
      hook: 'model.forms.form.beforeCreate',
      kind: 'filter',
      id: 'normalise-fields-create',
      fn: (values: Record<string, any>) => {
        if (values.fields !== undefined && values.fields !== null) values.fields = normaliseFields(values.fields);
        return values;
      },
    },
    {
      hook: 'model.forms.form.beforeUpdate',
      kind: 'filter',
      id: 'normalise-fields-update',
      fn: (values: Record<string, any>) => {
        if (values.fields !== undefined && values.fields !== null) values.fields = normaliseFields(values.fields);
        return values;
      },
    },
  ],
  routes: [
    {
      method: 'POST',
      path: '/forms/:id/submit',
      surface: 'api',
      permission: 'public',
      handler: async (req) => {
        const r = await submitForm(req.ctx, String(req.params.id ?? ''), req.body, req.headers);
        const { status, ...body } = r;
        return { status, body };
      },
    },
    {
      method: 'GET',
      path: '/forms/:id/submissions',
      surface: 'api',
      permission: 'forms.manage',
      handler: async (req) => {
        const form = await req.ctx.repo('forms.form').get(String(req.params.id));
        const where: Record<string, unknown> = { form: form.id };
        if (['new', 'read', 'spam'].includes(req.query.status ?? '')) where.status = req.query.status;
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const repo = req.ctx.repo('forms.submission');
        const [submissions, total] = await Promise.all([repo.find({ where, order: 'created_at desc', limit, offset }), repo.count(where)]);
        return { body: { form: { id: form.id, name: form.name, fields: normaliseFields(form.fields) }, submissions, total } };
      },
    },
    {
      method: 'GET',
      path: '/forms/:id/export.csv',
      surface: 'api',
      permission: 'forms.manage',
      handler: async (req) => {
        const form = await req.ctx.repo('forms.form').get(String(req.params.id));
        const fields = normaliseFields(form.fields);
        const subs: Record<string, any>[] = [];
        for (let offset = 0; offset < 100_000; offset += 1000) {
          const page = await req.ctx.repo('forms.submission').find({ where: { form: form.id }, order: 'created_at asc', limit: 1000, offset });
          subs.push(...page);
          if (page.length < 1000) break;
        }
        const keys = fields.map((x) => x.name);
        for (const s of subs) for (const k of Object.keys(s.data ?? {})) if (!keys.includes(k)) keys.push(k);
        const labels = keys.map((k) => fields.find((x) => x.name === k)?.label ?? k);
        const rows: unknown[][] = [['submitted_at', 'status', ...labels]];
        for (const s of subs) rows.push([s.created_at, s.status, ...keys.map((k) => s.data?.[k] ?? '')]);
        const filename = (String(form.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'form') + '-submissions.csv';
        return {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'x-content-type-options': 'nosniff' },
          body: '﻿' + toCsv(rows),
        };
      },
    },
    { method: 'POST', path: '/forms/:id/submit', surface: 'site', permission: 'public', handler: siteSubmit },
  ],
  events: [
    {
      event: 'forms.submission.created',
      id: 'queue-notify',
      handler: async (payload, ctx) => {
        const sub = await ctx.asSudo().repo('forms.submission').findOne({ id: payload.id });
        if (!sub || sub.status === 'spam') return;
        await ctx.enqueue('forms', 'notify', { id: sub.id });
      },
    },
  ],
  jobs: [
    {
      name: 'notify',
      maxAttempts: 5,
      handler: async (payload, ctx) => {
        const sudo = ctx.asSudo();
        const sub = await sudo.repo('forms.submission').findOne({ id: payload.id });
        if (!sub) return;
        const form = await sudo.repo('forms.form').findOne({ id: sub.form });
        if (!form) return;
        const fields = normaliseFields(form.fields);
        const data = (sub.data ?? {}) as Record<string, unknown>;
        const replyTo = fields.filter((x) => x.type === 'email').map((x) => data[x.name]).find((v) => typeof v === 'string' && v) as string | undefined;
        const message = {
          to: form.notify_email ?? null,
          subject: oneLine(`New submission: ${form.name} (${ctx.site.name})`),
          text: fields.map((x) => `${x.label}: ${fmtValue(data[x.name])}`).join('\n'),
          replyTo: replyTo ? oneLine(replyTo) : undefined,
          meta: { module: 'forms', form: form.id, submission: sub.id },
        };
        let result: any;
        let transport: string;
        if (ctx.hooks.has('mail.send')) {
          result = await ctx.hooks.filter('mail.send', { sent: false }, message, ctx);
          transport = String(result?.transport ?? 'hook');
        } else {
          console.log(`[forms] mail.send (no mailer installed) to=${message.to ?? '-'} subject=${JSON.stringify(message.subject)}\n${message.text}`);
          result = { sent: false };
          transport = 'console';
        }
        const notification = { attempted_at: new Date().toISOString(), to: message.to, sent: !!result?.sent, transport };
        await sudo.repo('forms.submission').update(sub.id, { meta: { ...((sub.meta as object) ?? {}), notification } });
        await ctx.audit('forms.notify', { submission: sub.id, form: form.id, sent: notification.sent, transport });
      },
    },
  ],
  services: (ctx) => ({
    submit: (formId: string, body: unknown, headers?: Record<string, string>) => submitForm(ctx, formId, body, headers ?? {}),
    validate: (fields: unknown, body: Record<string, unknown>) => validateSubmission(normaliseFields(fields), body),
    resetRateLimit: () => submissionLimiter.reset(),
  }),
  permissions: [{ key: 'forms.manage', label: 'Manage forms and submissions' }],
  grants: { editor: ['forms.manage'] },
  records: [
    {
      key: 'contact',
      model: 'forms.form',
      noupdate: true,
      values: {
        name: 'Contact',
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true },
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'message', label: 'Message', type: 'textarea', required: true },
        ],
        success_message: 'Thanks for getting in touch! We will reply soon.',
      },
    },
  ],
  editor: {
    collections: [
      { model: 'forms.form', label: 'Forms', icon: 'form', columns: ['name', 'notify_email'] },
      { model: 'forms.submission', label: 'Submissions', icon: 'inbox', columns: ['form', 'status', 'created_at'] },
    ],
  },
});
