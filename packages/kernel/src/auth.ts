import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.ts';
import { ConflictError, UnauthorizedError, ValidationError } from './errors.ts';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
}

export async function createUser(db: Db, input: { email: string; password: string; name?: string; superadmin?: boolean }): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Invalid email');
  if (input.password.length < 8) throw new ValidationError('Password must be at least 8 characters');
  const exists = await db.query(`SELECT 1 FROM modulo_users WHERE email=$1`, [email]);
  if (exists.rows.length) throw new ConflictError('Email already registered');
  const r = await db.query<UserRow>(
    `INSERT INTO modulo_users (email, name, password_hash, is_superadmin) VALUES ($1,$2,$3,$4) RETURNING id, email, name, is_superadmin`,
    [email, input.name ?? '', await hashPassword(input.password), !!input.superadmin],
  );
  return r.rows[0]!;
}

const SESSION_DAYS = 14;

export async function login(db: Db, email: string, password: string): Promise<{ token: string; user: UserRow }> {
  const r = await db.query<UserRow & { password_hash: string }>(`SELECT * FROM modulo_users WHERE email=$1`, [email.trim().toLowerCase()]);
  const u = r.rows[0];
  if (!u || !(await verifyPassword(password, u.password_hash))) throw new UnauthorizedError('Invalid email or password');
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO modulo_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [hashToken(token), u.id]);
  return { token, user: { id: u.id, email: u.email, name: u.name, is_superadmin: u.is_superadmin } };
}

export async function sessionUser(db: Db, token: string | undefined | null): Promise<UserRow | null> {
  if (!token) return null;
  const r = await db.query<UserRow>(
    `SELECT u.id, u.email, u.name, u.is_superadmin FROM modulo_sessions s JOIN modulo_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return r.rows[0] ?? null;
}

export async function logout(db: Db, token: string) {
  await db.query(`DELETE FROM modulo_sessions WHERE token_hash=$1`, [hashToken(token)]);
}
