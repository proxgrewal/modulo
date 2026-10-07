import type { Db } from './db.ts';

/** Non-superuser role used for tenant queries so row-level security is enforced. */
export const APP_ROLE = (globalThis as any).process?.env?.MODULO_APP_ROLE ?? 'modulo_app';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(APP_ROLE)) throw new Error('Invalid MODULO_APP_ROLE');

export const SYSTEM_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} NOLOGIN;
  END IF;
  -- Non-superuser deployments: the connecting user must be able to SET ROLE to the app role
  -- (on PG16+ a role's creator only gets ADMIN, not SET, unless granted explicitly).
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    BEGIN
      EXECUTE format('GRANT ${APP_ROLE} TO %I', current_user);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Could not grant ${APP_ROLE} to %: %', current_user, SQLERRM;
    END;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS modulo_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(63) NOT NULL UNIQUE,
  name text NOT NULL,
  domain text UNIQUE,
  theme jsonb NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}',
  lock jsonb NOT NULL DEFAULT '{"kernel":"1.0.0","modules":[]}',
  resolutions jsonb NOT NULL DEFAULT '{}',
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modulo_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  password_hash text,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modulo_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES modulo_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS modulo_members (
  site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES modulo_users(id) ON DELETE CASCADE,
  role text NOT NULL,
  PRIMARY KEY (site_id, user_id)
);

CREATE TABLE IF NOT EXISTS modulo_roles (
  site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
  role text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (site_id, role)
);

CREATE TABLE IF NOT EXISTS modulo_site_modules (
  site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
  module text NOT NULL,
  version text NOT NULL,
  auto boolean NOT NULL DEFAULT false,
  requested boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}',
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, module)
);

CREATE TABLE IF NOT EXISTS modulo_schema_versions (
  module text PRIMARY KEY,
  version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modulo_models (
  name text PRIMARY KEY,
  module text NOT NULL,
  def jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modulo_records (
  site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
  module text NOT NULL,
  key text NOT NULL,
  model text NOT NULL,
  record_id uuid NOT NULL,
  shipped jsonb NOT NULL,
  noupdate boolean NOT NULL DEFAULT false,
  PRIMARY KEY (site_id, module, key)
);

CREATE TABLE IF NOT EXISTS modulo_outbox (
  id bigserial PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS modulo_outbox_pending ON modulo_outbox (id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS modulo_jobs (
  id bigserial PRIMARY KEY,
  site_id uuid REFERENCES modulo_sites(id) ON DELETE CASCADE,
  module text NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS modulo_jobs_due ON modulo_jobs (run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS modulo_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES modulo_sites(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modulo_audit (
  id bigserial PRIMARY KEY,
  site_id uuid REFERENCES modulo_sites(id) ON DELETE CASCADE,
  user_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
`;

export async function ensureSystemSchema(db: Db) {
  await db.exec(SYSTEM_SQL);
}
