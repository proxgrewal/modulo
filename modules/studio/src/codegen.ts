import { mf, type ModelDef, type ModelExtension, type ModelField } from '@modulo/core';
import type { ModuleDefinition } from '@modulo/kernel';
import { renameModule } from './definition.ts';

/**
 * Turns a (data-only) local module into a standalone module package with
 * readable TypeScript source: "no-code customization exports as a module".
 */
export const EXPORT_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

export interface ExportOptions {
  /** Proper module name for the exported package (renames model/permission namespaces). */
  rename?: string;
}

export interface ExportResult {
  name: string;
  definition: ModuleDefinition;
  files: Record<string, string>;
}

export function exportModule(built: ModuleDefinition, opts: ExportOptions = {}): ExportResult {
  if (opts.rename !== undefined && !EXPORT_NAME_RE.test(opts.rename)) {
    throw new Error(`Invalid module name "${opts.rename}" (lowercase letters, digits and dashes)`);
  }
  const def = opts.rename ? renameModule(built, opts.rename) : structuredClone(built);
  if (def.category === 'local') delete def.category;
  return {
    name: def.name,
    definition: def,
    files: {
      'package.json': packageJson(def),
      'src/index.ts': moduleSource(def),
      'README.md': readme(def),
      'test/module.test.ts': testSource(def),
    },
  };
}

/* ───────────────────────── TypeScript literal printer ───────────────────────── */

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const pad = (n: number) => '  '.repeat(n);

function str(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}
function key(k: string): string {
  return IDENT_RE.test(k) ? k : str(k);
}

/** Print a JSON-ish value as a TS literal; short values stay on one line. */
export function lit(v: unknown, depth = 0): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const inline = `[${v.map((x) => lit(x, 0)).join(', ')}]`;
    if (inline.length <= 80 && !inline.includes('\n')) return inline;
    return `[\n${v.map((x) => pad(depth + 1) + lit(x, depth + 1)).join(',\n')},\n${pad(depth)}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return '{}';
    const inline = `{ ${entries.map(([k, x]) => `${key(k)}: ${lit(x, 0)}`).join(', ')} }`;
    if (inline.length <= 80 && !inline.includes('\n')) return inline;
    return `{\n${entries.map(([k, x]) => `${pad(depth + 1)}${key(k)}: ${lit(x, depth + 1)}`).join(',\n')},\n${pad(depth)}}`;
  }
  throw new Error(`Cannot print ${typeof v}`);
}

/** `mf.<kind>(...)` call reproducing the field exactly (helper defaults are omitted). */
export function fieldExpr(f: ModelField): string {
  let args: string[] = [];
  let base: ModelField;
  switch (f.kind) {
    case 'enum':
      base = mf.enum(f.options ?? []);
      args = [lit(f.options ?? [])];
      break;
    case 'ref':
      base = mf.ref(f.model!);
      args = [lit(f.model)];
      break;
    case 'slug':
      base = mf.slug(f.from!);
      args = [lit(f.from)];
      break;
    default:
      base = (mf[f.kind] as () => ModelField)();
  }
  const skip = new Set(['kind', ...(f.kind === 'enum' ? ['options'] : f.kind === 'ref' ? ['model'] : f.kind === 'slug' ? ['from'] : [])]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (skip.has(k) || v === undefined) continue;
    if (JSON.stringify((base as any)[k]) === JSON.stringify(v)) continue;
    extra[k] = v;
  }
  // Helper defaults the field explicitly lacks must be cleared to round-trip.
  for (const k of Object.keys(base)) if (!skip.has(k) && !(k in f)) extra[k] = undefined;
  const ordered = Object.keys(extra).sort((a, b) => keyRank(a) - keyRank(b));
  const sorted = Object.fromEntries(ordered.map((k) => [k, extra[k]]));
  const hasUndef = Object.values(extra).some((v) => v === undefined);
  const opts = Object.keys(extra).length
    ? hasUndef
      ? `{ ${Object.entries(sorted)
          .map(([k, v]) => `${key(k)}: ${v === undefined ? 'undefined' : lit(v)}`)
          .join(', ')} }`
      : lit(sorted)
    : '';
  if (opts) args.push(opts);
  return `mf.${f.kind}(${args.join(', ')})`;
}

const FIELD_KEY_ORDER = ['label', 'help', 'required', 'unique', 'index', 'default', 'max', 'options', 'model', 'onDelete', 'from', 'private'];
function keyRank(k: string) {
  const i = FIELD_KEY_ORDER.indexOf(k);
  return i < 0 ? 99 : i;
}

function fieldsBlock(fields: Record<string, ModelField>, depth: number): string {
  const entries = Object.entries(fields);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, f]) => `${pad(depth + 1)}${key(k)}: ${fieldExpr(f)},`).join('\n')}\n${pad(depth)}}`;
}

function modelExpr(m: ModelDef, depth: number): string {
  const lines: string[] = [];
  const p = pad(depth + 1);
  lines.push(`${p}name: ${str(m.name)},`);
  if (m.label) lines.push(`${p}label: ${str(m.label)},`);
  if (m.titleField) lines.push(`${p}titleField: ${str(m.titleField)},`);
  lines.push(`${p}fields: ${fieldsBlock(m.fields, depth + 1)},`);
  if (m.indexes?.length) lines.push(`${p}indexes: ${lit(m.indexes, depth + 1)},`);
  if (m.access && Object.keys(m.access).length) lines.push(`${p}access: ${lit(m.access, depth + 1)},`);
  if (m.order) lines.push(`${p}order: ${str(m.order)},`);
  return `defineModel({\n${lines.join('\n')}\n${pad(depth)}})`;
}

function extensionExpr(e: ModelExtension, depth: number): string {
  const p = pad(depth + 1);
  const lines = [`${p}model: ${str(e.model)},`, `${p}fields: ${fieldsBlock(e.fields ?? {}, depth + 1)},`];
  if (e.indexes?.length) lines.push(`${p}indexes: ${lit(e.indexes, depth + 1)},`);
  return `extendModel({\n${lines.join('\n')}\n${pad(depth)}})`;
}

export function moduleSource(def: ModuleDefinition): string {
  const coreImports = ['defineModel', ...(def.extendModels?.length ? ['extendModel'] : []), 'mf'];
  const out: string[] = [];
  out.push(`// Generated by Modulo Studio from the no-code module "${def.label ?? def.name}".`);
  out.push(`// This is now a regular module: edit freely, add hooks, blocks or routes.`);
  out.push(`import { defineModule } from '@modulo/kernel';`);
  out.push(`import { ${coreImports.join(', ')} } from '@modulo/core';`);
  out.push('');
  out.push('export default defineModule({');
  const p = pad(1);
  out.push(`${p}name: ${str(def.name)},`);
  out.push(`${p}version: ${str(def.version)},`);
  if (def.label) out.push(`${p}label: ${str(def.label)},`);
  if (def.description) out.push(`${p}description: ${str(def.description)},`);
  out.push(`${p}kernel: ${str(def.kernel)},`);
  if (def.category) out.push(`${p}category: ${str(def.category)},`);
  if (def.depends && Object.keys(def.depends).length) out.push(`${p}depends: ${lit(def.depends, 1)},`);
  if (def.models?.length) out.push(`${p}models: [\n${def.models.map((m) => `${pad(2)}${modelExpr(m, 2)},`).join('\n')}\n${p}],`);
  if (def.extendModels?.length) out.push(`${p}extendModels: [\n${def.extendModels.map((e) => `${pad(2)}${extensionExpr(e, 2)},`).join('\n')}\n${p}],`);
  for (const k of ['patches', 'permissions', 'grants', 'editor'] as const) {
    const v = def[k];
    if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) out.push(`${p}${k}: ${lit(v, 1)},`);
  }
  out.push('});');
  return out.join('\n') + '\n';
}

function packageJson(def: ModuleDefinition): string {
  return (
    JSON.stringify(
      {
        name: `@modulo/mod-${def.name}`,
        version: def.version,
        type: 'module',
        description: def.description ?? def.label ?? def.name,
        exports: { '.': './src/index.ts' },
        dependencies: { '@modulo/core': 'workspace:*', '@modulo/kernel': 'workspace:*' },
      },
      null,
      2,
    ) + '\n'
  );
}

function readme(def: ModuleDefinition): string {
  const lines: string[] = [];
  lines.push(`# ${def.label ?? def.name}`, '');
  if (def.description) lines.push(def.description, '');
  lines.push(`Module \`${def.name}\` v${def.version} (kernel \`${def.kernel}\`), exported from Modulo Studio.`, '');
  if (def.depends && Object.keys(def.depends).length) {
    lines.push('## Dependencies', '', ...Object.entries(def.depends).map(([n, r]) => `- \`${n}\` ${r}`), '');
  }
  const table = (fields: Record<string, ModelField>) => [
    '| Field | Kind | Required | Notes |',
    '| --- | --- | --- | --- |',
    ...Object.entries(fields).map(([n, f]) => {
      const notes = [f.label, f.options ? `options: ${f.options.join(', ')}` : '', f.model ? `→ ${f.model}` : '', f.unique ? 'unique' : '', f.from ? `from ${f.from}` : '']
        .filter(Boolean)
        .join('; ');
      return `| \`${n}\` | ${f.kind} | ${f.required ? 'yes' : ''} | ${notes} |`;
    }),
    '',
  ];
  for (const m of def.models ?? []) lines.push(`## Model \`${m.name}\`${m.label ? ` — ${m.label}` : ''}`, '', ...table(m.fields));
  for (const e of def.extendModels ?? []) lines.push(`## Extends \`${e.model}\``, '', ...table(e.fields ?? {}));
  if (def.permissions?.length) lines.push('## Permissions', '', ...def.permissions.map((p) => `- \`${p.key}\` — ${p.label}`), '');
  lines.push(
    '## Usage',
    '',
    `Copy this folder to \`modules/${def.name}/\`, run \`pnpm install\`, then install it on a site:`,
    '',
    '```sh',
    `pnpm modulo module install ${def.name} --site <slug>`,
    `npx vitest run modules/${def.name}`,
    '```',
    '',
  );
  if (def.name.startsWith('x_')) {
    lines.push(
      'This export keeps the site-local module name, so its tables are the ones the site already uses.',
      'Re-export with `--rename <name>` to give it a reusable module name (new tables).',
      '',
    );
  }
  return lines.join('\n');
}

const SAMPLE: Record<string, unknown> = {
  string: 'Sample',
  text: 'Sample text',
  richtext: '<p>Sample</p>',
  slug: 'sample',
  email: 'sample@example.com',
  url: 'https://example.com',
  int: 1,
  float: 1.5,
  money: 9.99,
  boolean: true,
  date: '2024-01-01',
  datetime: '2024-01-01T00:00:00.000Z',
  json: {},
  media: 'sample.png',
};

function sampleRecord(m: ModelDef): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(m.fields)) {
    if (!f.required) continue;
    if (f.kind === 'ref') return null;
    out[k] = f.kind === 'enum' ? f.options![0] : f.kind === 'string' && f.max && f.max < 6 ? 'S' : SAMPLE[f.kind];
  }
  return out;
}

function testSource(def: ModuleDefinition): string {
  const hasDeps = !!def.depends && Object.keys(def.depends).length > 0;
  const first = def.models?.find((m) => sampleRecord(m));
  const lines: string[] = [];
  lines.push(`import { describe, expect, it } from 'vitest';`);
  lines.push(`import { Kernel, createPgliteDb, type ModuleDefinition } from '@modulo/kernel';`);
  if (hasDeps) lines.push(`import { discoverModules } from '../../../packages/server/src/boot.ts';`);
  lines.push(`import mod from '../src/index.ts';`);
  lines.push('');
  lines.push(`describe(${str(def.name)}, () => {`);
  lines.push(`  it('installs on a site and exposes its models', async () => {`);
  if (hasDeps) {
    lines.push(`    // Dependencies (${Object.keys(def.depends!).join(', ')}) come from the other modules in this repo.`);
    lines.push(`    const others = (await discoverModules()).flatMap((d) => d.defs).filter((d) => d.name !== mod.name);`);
    lines.push(`    const modules: ModuleDefinition[] = [mod, ...others];`);
  } else lines.push(`    const modules: ModuleDefinition[] = [mod];`);
  lines.push(`    const kernel = await Kernel.create({ db: await createPgliteDb(), modules });`);
  lines.push(`    try {`);
  lines.push(`      const site = await kernel.createSite({ slug: 'test', name: 'Test', modules: { ${key(def.name)}: '*' } });`);
  lines.push(`      const ctx = await kernel.context(site.id, null, { sudo: true });`);
  lines.push(`      for (const m of mod.models ?? []) expect(await ctx.repo(m.name).count()).toBe(0);`);
  if (first) {
    lines.push(`      const rec = await ctx.repo(${str(first.name)}).create(${lit(sampleRecord(first), 3)});`);
    lines.push(`      expect((await ctx.repo(${str(first.name)}).get(rec.id)).id).toBe(rec.id);`);
  }
  lines.push(`    } finally {`);
  lines.push(`      await kernel.close();`);
  lines.push(`    }`);
  lines.push(`  });`);
  lines.push(`});`);
  return lines.join('\n') + '\n';
}
