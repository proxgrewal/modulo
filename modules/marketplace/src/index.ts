import { f } from '@modulo/core';
import { APP_ROLE, ConflictError, defineModule, ForbiddenError, NotFoundError, ValidationError, type Db, type Kernel, type RouteRequest, type SiteContext } from '@modulo/kernel';
import { appToModule, validatePackage, type AppManifest, type AppToModuleOptions } from '@modulo/sandbox';
import { canonicalPublicKey, keyFingerprint, verifyPackage, type MarketplaceTrust, type SignedPackage } from './signing.ts';

export * from './signing.ts';

/**
 * Marketplace: signed community app packages, trust tiers, capability
 * consent, and installation into sites. Packages are stored in global
 * (not site-scoped) tables and registered into the kernel catalog at boot.
 */

const DDL = `
CREATE TABLE IF NOT EXISTS marketplace_packages (
  name text NOT NULL,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  code text NOT NULL,
  signature text NOT NULL,
  publisher_key text NOT NULL,
  trust text NOT NULL,
  digest text NOT NULL,
  published_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS marketplace_trusted_publishers (
  public_key text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketplace_consents (
  id bigserial PRIMARY KEY,
  site_id uuid NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  capabilities jsonb NOT NULL,
  user_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
-- Global tables: tenant (RLS-bound) code must not touch them.
REVOKE ALL ON marketplace_packages, marketplace_trusted_publishers, marketplace_consents FROM ${APP_ROLE};
`;

const ready = new WeakSet<Db>();
export async function ensureMarketplaceTables(db: Db) {
  if (ready.has(db)) return;
  await db.exec(DDL);
  ready.add(db);
}

interface PackageRow {
  name: string;
  version: string;
  manifest: AppManifest;
  code: string;
  signature: string;
  publisher_key: string;
  trust: MarketplaceTrust;
  digest: string;
  published_at: string | Date;
}

const rowToPackage = (r: PackageRow): SignedPackage => ({ manifest: r.manifest, code: r.code, signature: r.signature, publisherKey: r.publisher_key });

/** Options applied to every app definition the marketplace creates (sandbox limits, logging). */
let appOptions: AppToModuleOptions = {};
export function configureMarketplace(opts: AppToModuleOptions) {
  appOptions = opts;
}

/** Simple semver comparison (major.minor.patch, prerelease sorts lower). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0]!.split(/-(.*)/s);
    return { nums: core!.split('.').map((n) => Number(n) || 0), pre: pre ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export async function globalTrustedKeys(db: Db): Promise<string[]> {
  await ensureMarketplaceTables(db);
  return (await db.query<{ public_key: string }>(`SELECT public_key FROM marketplace_trusted_publishers`)).rows.map((r) => r.public_key);
}

/** Add a publisher key to the global trusted list (packages it signs become "verified"). */
export async function trustPublisher(db: Db, publicKey: string, name = '') {
  await ensureMarketplaceTables(db);
  const key = canonicalPublicKey(publicKey);
  await db.query(`INSERT INTO marketplace_trusted_publishers (public_key, name) VALUES ($1,$2) ON CONFLICT (public_key) DO UPDATE SET name=EXCLUDED.name`, [key, name]);
  return key;
}

function siteTrustedKeys(ctx: SiteContext): string[] {
  const raw = ctx.settings('marketplace').trustedPublishers;
  return typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : [];
}

async function trustedFor(ctx: SiteContext) {
  return [...(await globalTrustedKeys(ctx.kernel.db)), ...siteTrustedKeys(ctx)];
}

/** Register a package version into the kernel catalog (no-op if already present). */
function register(kernel: Kernel, pkg: SignedPackage, trust: MarketplaceTrust) {
  if (kernel.catalog.get(pkg.manifest.name).some((d) => d.version === pkg.manifest.version)) return;
  kernel.catalog.add(appToModule(pkg, { ...appOptions, trust }));
}

/** Boot hook: create tables, register every stored (and still validly signed) package, then recompose the schema. */
export async function onKernelBoot(kernel: Kernel) {
  await ensureMarketplaceTables(kernel.db);
  const trusted = await globalTrustedKeys(kernel.db);
  const rows = (await kernel.db.query<PackageRow>(`SELECT * FROM marketplace_packages ORDER BY name, published_at`)).rows;
  for (const r of rows) {
    const pkg = rowToPackage(r);
    const v = verifyPackage(pkg, trusted);
    if (!v.ok) {
      console.warn(`[marketplace] skipping ${r.name}@${r.version}: ${v.error}`);
      continue;
    }
    try {
      register(kernel, pkg, v.trust);
    } catch (e: any) {
      console.warn(`[marketplace] skipping ${r.name}@${r.version}: ${e?.message ?? e}`);
    }
  }
  await kernel.recompose();
}

const sameSet = (a: unknown, b: string[]) =>
  Array.isArray(a) && a.every((x) => typeof x === 'string') && new Set(a).size === new Set(b).size && b.every((x) => a.includes(x));

async function listPackages(req: RouteRequest) {
  const { ctx } = req;
  await ensureMarketplaceTables(ctx.kernel.db);
  const trusted = await trustedFor(ctx);
  const rows = (await ctx.kernel.db.query<PackageRow>(`SELECT * FROM marketplace_packages`)).rows;
  const byName = new Map<string, PackageRow[]>();
  for (const r of rows) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(r);
  const out = [];
  for (const [name, list] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => compareVersions(b.version, a.version));
    const latest = list[0]!;
    const v = verifyPackage(rowToPackage(latest), trusted);
    const installed = ctx.runtime.defs.find((d) => d.name === name);
    out.push({
      name,
      label: latest.manifest.label,
      description: latest.manifest.description,
      latest: latest.version,
      versions: list.map((r) => r.version),
      trust: v.ok ? v.trust : 'invalid',
      publisher: keyFingerprint(latest.publisher_key),
      capabilities: latest.manifest.capabilities,
      installed: !!installed,
      installedVersion: installed?.version ?? null,
      publishedAt: new Date(latest.published_at).toISOString(),
    });
  }
  return { body: out };
}

async function publishPackage(req: RouteRequest) {
  const { ctx } = req;
  // Superadmin-only by default: site owners/admins hold "*" on their site, which must not
  // let them publish code into the global catalog. Only an explicit grant counts.
  if (!ctx.sudo && !ctx.user?.isSuperadmin && !ctx.user?.permissions.has('marketplace.publish')) throw new ForbiddenError('Publishing packages requires a superadmin or an explicit "marketplace.publish" grant');
  const pkg = req.body as SignedPackage;
  const v = verifyPackage(pkg, await trustedFor(ctx));
  if (!v.ok) throw new ValidationError(`Rejected package: ${v.error}`, { reason: 'invalid_signature' });
  const clean = validatePackage(pkg); // structural validation (throws 400 with the problem list)
  appToModule(clean); // also validates capability/hook consistency
  const { name, version } = clean.manifest;
  const db = ctx.kernel.db;
  await ensureMarketplaceTables(db);
  const existing = (await db.query<PackageRow>(`SELECT * FROM marketplace_packages WHERE name=$1`, [name])).rows;
  if (existing.some((r) => canonicalPublicKey(r.publisher_key) !== v.publisherKey))
    throw new ForbiddenError(`Package ${name} belongs to a different publisher`);
  const same = existing.find((r) => r.version === version);
  if (same) {
    if (same.digest === v.digest) return { status: 200, body: { name, version, trust: v.trust, capabilities: clean.manifest.capabilities, duplicate: true } };
    throw new ConflictError(`${name}@${version} is already published with different contents; bump the version`);
  }
  const signed: SignedPackage = { manifest: pkg.manifest, code: pkg.code, signature: pkg.signature, publisherKey: v.publisherKey };
  register(ctx.kernel, signed, v.trust);
  await db.query(
    `INSERT INTO marketplace_packages (name, version, manifest, code, signature, publisher_key, trust, digest, published_by) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)`,
    [name, version, JSON.stringify(pkg.manifest), pkg.code, pkg.signature, v.publisherKey, v.trust, v.digest, ctx.user?.id ?? null],
  );
  return { status: 201, body: { name, version, trust: v.trust, publisher: keyFingerprint(v.publisherKey), capabilities: clean.manifest.capabilities } };
}

async function installPackage(req: RouteRequest) {
  const { ctx } = req;
  if (ctx.inSiteTx) throw new Error('marketplace install must run outside a transaction');
  const name = req.params.name!;
  const body = (req.body ?? {}) as { version?: string; acceptCapabilities?: unknown };
  const db = ctx.kernel.db;
  await ensureMarketplaceTables(db);
  const rows = (await db.query<PackageRow>(`SELECT * FROM marketplace_packages WHERE name=$1`, [name])).rows;
  if (!rows.length) throw new NotFoundError(`Package ${name} not found`);
  const row = body.version ? rows.find((r) => r.version === body.version) : rows.sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!row) throw new NotFoundError(`Package ${name}@${body.version} not found`);
  const pkg = rowToPackage(row);
  // Re-verify at install time so tampered rows can never be installed.
  const v = verifyPackage(pkg, await trustedFor(ctx));
  if (!v.ok) throw new ValidationError(`Refusing to install ${name}@${row.version}: ${v.error}`);
  if (v.trust === 'community' && ctx.settings('marketplace').allowCommunity === false)
    throw new ForbiddenError(`This site only allows verified packages; ${name} is a community package`);
  const caps = row.manifest.capabilities ?? [];
  if (!sameSet(body.acceptCapabilities, caps)) {
    throw new ValidationError(
      `Installing ${name}@${row.version} requires consent to its capabilities: ${caps.length ? caps.join(', ') : '(none)'}. Resend with acceptCapabilities set to exactly this list.`,
      { capabilities: caps, trust: v.trust },
    );
  }
  register(ctx.kernel, pkg, v.trust);
  const report = await ctx.kernel.applyChange(ctx.site.id, { install: { [name]: row.version } }, { actorId: ctx.user?.id });
  await db.query(`INSERT INTO marketplace_consents (site_id, name, version, capabilities, user_id) VALUES ($1,$2,$3,$4::jsonb,$5)`, [
    ctx.site.id,
    name,
    row.version,
    JSON.stringify(caps),
    ctx.user?.id ?? null,
  ]);
  await ctx.audit('marketplace.install', { name, version: row.version, capabilities: caps, trust: v.trust });
  return { body: { installed: { name, version: row.version }, trust: v.trust, capabilities: caps, added: report.added, upgraded: report.upgraded } };
}

async function uninstallPackage(req: RouteRequest) {
  const { ctx } = req;
  const name = req.params.name!;
  if (!name.startsWith('app-')) throw new ValidationError('Only marketplace apps can be uninstalled here');
  const report = await ctx.kernel.applyChange(ctx.site.id, { uninstall: [name] }, { actorId: ctx.user?.id });
  await ctx.audit('marketplace.uninstall', { name });
  return { body: { removed: report.removed } };
}

async function addPublisher(req: RouteRequest) {
  const { ctx } = req;
  if (!ctx.sudo && !ctx.user?.isSuperadmin) throw new ForbiddenError('Only superadmins can trust publishers globally');
  const b = (req.body ?? {}) as { publicKey?: string; name?: string };
  let key: string;
  try {
    key = await trustPublisher(ctx.kernel.db, String(b.publicKey ?? ''), String(b.name ?? ''));
  } catch (e: any) {
    throw new ValidationError(`Invalid publisher key: ${e.message}`);
  }
  return { status: 201, body: { publicKey: key, fingerprint: keyFingerprint(key) } };
}

export default defineModule({
  name: 'marketplace',
  version: '1.0.0',
  kernel: '^1.0.0',
  label: 'Marketplace',
  description: 'Install signed community apps that run sandboxed with explicit capabilities.',
  category: 'system',
  permissions: [
    { key: 'marketplace.publish', label: 'Publish packages to the marketplace' },
    { key: 'marketplace.install', label: 'Install and uninstall marketplace apps' },
  ],
  // No default grants: publish is superadmin-only, install is owner/admin ("*") unless granted.
  settings: {
    trustedPublishers: f.textarea({ label: 'Trusted publisher keys (one per line)', default: '' }),
    allowCommunity: f.boolean({ label: 'Allow community (unverified) packages', default: true }),
  },
  routes: [
    { method: 'GET', path: '/packages', surface: 'api', permission: 'auth', handler: listPackages },
    { method: 'POST', path: '/packages', surface: 'api', permission: 'marketplace.publish', handler: publishPackage },
    { method: 'POST', path: '/packages/:name/install', surface: 'api', permission: 'marketplace.install', handler: installPackage },
    { method: 'POST', path: '/packages/:name/uninstall', surface: 'api', permission: 'marketplace.install', handler: uninstallPackage },
    { method: 'POST', path: '/publishers', surface: 'api', permission: 'marketplace.publish', handler: addPublisher },
  ],
  editor: { panels: [{ id: 'marketplace', label: 'Marketplace', kind: 'settings' }] },
});
