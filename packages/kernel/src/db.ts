/**
 * Database port. Two adapters share one SQL dialect (PostgreSQL):
 *  - PGlite (embedded, WASM) for zero-setup dev and tests
 *  - node-postgres for production (docker-compose / managed Postgres)
 */
export interface QueryResult<T = any> {
  rows: T[];
  affectedRows?: number;
}

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement SQL without parameters (DDL). */
  exec(sql: string): Promise<void>;
  /** Run fn in a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  readonly inTx: boolean;
  readonly dialect: 'pglite' | 'pg';
  close(): Promise<void>;
}

class PgliteTxDb implements Db {
  readonly inTx = true;
  readonly dialect = 'pglite' as const;
  constructor(private t: any) {}
  async query<T>(sql: string, params: unknown[] = []) {
    const r = await this.t.query(sql, params);
    return { rows: r.rows as T[], affectedRows: r.affectedRows };
  }
  async exec(sql: string) {
    await this.t.exec(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close() {}
}

/**
 * PGlite is single-process: two processes opening one data dir corrupts it.
 * Hold an exclusive pid lock next to the directory; stale locks (dead pid) are taken over.
 */
async function lockDataDir(dataDir: string): Promise<() => void> {
  const fs = await import('node:fs');
  const lock = dataDir.replace(/[\/]+$/, '') + '.lock';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      const release = () => {
        try {
          if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
        } catch {}
      };
      process.once('exit', release);
      return release;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err: any) {
        alive = err?.code === 'EPERM';
      }
      if (alive) throw new Error(`Embedded database ${dataDir} is already open by process ${pid}. Only one process may use a PGlite directory; stop it or use PostgreSQL (DATABASE_URL=postgres://...).`);
      fs.unlinkSync(lock); // stale lock from a crashed process
    }
  }
  throw new Error(`Could not lock ${dataDir}`);
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  let release = () => {};
  if (dataDir) {
    (await import('node:fs')).mkdirSync(dataDir, { recursive: true });
    release = await lockDataDir(dataDir);
  }
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  try {
    await pg.waitReady;
  } catch (e) {
    release();
    throw e;
  }
  const db: Db = {
    inTx: false,
    dialect: 'pglite',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pg.query(sql, params);
      return { rows: r.rows as T[], affectedRows: r.affectedRows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return pg.transaction(async (t) => fn(new PgliteTxDb(t)));
    },
    async close() {
      await pg.close();
      release();
    },
  };
  return db;
}

class PgClientDb implements Db {
  readonly inTx = true;
  readonly dialect = 'pg' as const;
  constructor(private client: any) {}
  async query<T>(sql: string, params: unknown[] = []) {
    const r = await this.client.query(sql, params);
    return { rows: r.rows as T[], affectedRows: r.rowCount ?? undefined };
  }
  async exec(sql: string) {
    await this.client.query(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close() {}
}

export async function createPgDb(connectionString: string): Promise<Db> {
  const pgMod: any = await import('pg');
  const Pool = pgMod.default?.Pool ?? pgMod.Pool;
  const types = pgMod.default?.types ?? pgMod.types;
  // Return int8 / numeric as JS numbers (counts, money) to match PGlite behaviour.
  types.setTypeParser(20, (v: string) => Number(v));
  types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new Pool({ connectionString, max: 10 });
  return {
    inTx: false,
    dialect: 'pg',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[], affectedRows: r.rowCount ?? undefined };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(new PgClientDb(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export async function createDb(url?: string): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) return createPgDb(url);
  return createPgliteDb(url && url !== 'memory' ? url : undefined);
}

/** Quote an SQL identifier (only after validating it against a strict pattern). */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}
