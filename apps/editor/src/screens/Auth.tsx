import { useState } from 'react';
import { errorMessage, post } from '../api.ts';
import { navigate } from '../router.ts';
import type { User } from '../types.ts';
import { Row, useUid } from '../ui/controls.tsx';

export function Logo() {
  return (
    <div className="logo-lockup">
      <svg viewBox="0 0 32 32" width="36" height="36" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M8 22V10l8 7 8-7v12" stroke="#fff" strokeWidth="3" fill="none" strokeLinejoin="round" />
      </svg>
      <span>Modulo</span>
    </div>
  );
}

export function AuthScreen({ mode, onAuthed }: { mode: 'login' | 'signup'; onAuthed: (u: User) => void }) {
  const uid = useUid('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await post<{ user: User }>(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', mode === 'login' ? { email, password } : { email, password, name });
      onAuthed(r.user);
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="screen-center auth-bg">
      <main className="card auth-card">
        <Logo />
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">{mode === 'login' ? 'Sign in to edit your sites.' : 'The first account on a new server becomes the superadmin.'}</p>
        <form className="form" onSubmit={submit}>
          {mode === 'signup' && (
            <Row label="Name" htmlFor={`${uid}-n`}>
              <input id={`${uid}-n`} className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Row>
          )}
          <Row label="Email" htmlFor={`${uid}-e`}>
            <input id={`${uid}-e`} className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </Row>
          <Row label="Password" htmlFor={`${uid}-p`} help={mode === 'signup' ? 'At least 8 characters.' : undefined}>
            <input id={`${uid}-p`} className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Row>
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="auth-switch">
          {mode === 'login' ? (
            <>
              New here?{' '}
              <button className="link-btn" onClick={() => navigate({ name: 'signup' })}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button className="link-btn" onClick={() => navigate({ name: 'login' })}>
                Sign in
              </button>
            </>
          )}
        </p>
      </main>
    </div>
  );
}
