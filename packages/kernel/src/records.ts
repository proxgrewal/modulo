import type { SiteContext } from './context.ts';
import type { ModuleDefinition } from './module.ts';

/**
 * Module-shipped records with stable keys (Odoo external ids). On upgrade a
 * three-way merge (last shipped vs new shipped vs current) keeps fields the
 * user edited and updates the rest; true conflicts keep the user's value and
 * are reported. Values may reference other shipped records: { $ref: "module.key" }.
 */
export interface RecordsReport {
  created: string[];
  updated: string[];
  conflicts: { key: string; field: string; kept: unknown; shipped: unknown }[];
  skipped: string[];
}

function eq(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function resolveRefs(ctx: SiteContext, values: Record<string, unknown>, module: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v && typeof v === 'object' && '$ref' in (v as any)) {
      const ref = String((v as any).$ref);
      const [mod, key] = ref.includes('.') ? [ref.slice(0, ref.indexOf('.')), ref.slice(ref.indexOf('.') + 1)] : [module, ref];
      const r = await ctx.db.query(`SELECT record_id FROM modulo_records WHERE site_id=$1 AND module=$2 AND key=$3`, [ctx.site.id, mod, key]);
      if (!r.rows[0]) throw new Error(`Shipped record ${module}: unresolved $ref ${ref}`);
      out[k] = r.rows[0].record_id;
    } else out[k] = v;
  }
  return out;
}

export async function applyShippedRecords(ctx: SiteContext, def: ModuleDefinition): Promise<RecordsReport> {
  const report: RecordsReport = { created: [], updated: [], conflicts: [], skipped: [] };
  const sudo = ctx.asSudo();
  for (const rec of def.records ?? []) {
    const values = await resolveRefs(sudo, rec.values, def.name);
    const track = await sudo.db.query(`SELECT * FROM modulo_records WHERE site_id=$1 AND module=$2 AND key=$3`, [ctx.site.id, def.name, rec.key]);
    const row = track.rows[0];
    const repo = sudo.repo(rec.model);
    if (!row) {
      const created = await repo.create(values);
      await sudo.db.query(`INSERT INTO modulo_records (site_id, module, key, model, record_id, shipped, noupdate) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [
        ctx.site.id,
        def.name,
        rec.key,
        rec.model,
        created.id,
        JSON.stringify(values),
        !!rec.noupdate,
      ]);
      report.created.push(rec.key);
      continue;
    }
    if (row.noupdate) {
      report.skipped.push(rec.key);
      continue;
    }
    const current = await repo.findOne({ id: row.record_id });
    if (!current) {
      // The user deleted it: respect that.
      report.skipped.push(rec.key);
      continue;
    }
    const base = row.shipped as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    for (const field of new Set([...Object.keys(base), ...Object.keys(values)])) {
      const b = base[field];
      const t = values[field];
      const m = current[field];
      if (eq(b, t) || eq(m, t)) continue;
      if (eq(m, b)) changes[field] = t;
      else report.conflicts.push({ key: rec.key, field, kept: m, shipped: t });
    }
    if (Object.keys(changes).length) {
      await repo.update(row.record_id, changes);
      report.updated.push(rec.key);
    }
    await sudo.db.query(`UPDATE modulo_records SET shipped=$4::jsonb WHERE site_id=$1 AND module=$2 AND key=$3`, [ctx.site.id, def.name, rec.key, JSON.stringify(values)]);
  }
  return report;
}

/** Look up the record id of a shipped record. */
export async function shippedRecordId(ctx: SiteContext, module: string, key: string): Promise<string | null> {
  const r = await ctx.db.query(`SELECT record_id FROM modulo_records WHERE site_id=$1 AND module=$2 AND key=$3`, [ctx.site.id, module, key]);
  return r.rows[0]?.record_id ?? null;
}
