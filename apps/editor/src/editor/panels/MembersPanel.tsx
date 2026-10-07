import { useCallback, useEffect, useState } from 'react';
import { del, errorMessage, get, post, sitePath } from '../../api.ts';
import { useStore } from '../../lib/store.ts';
import type { Member } from '../../types.ts';
import { Dialog } from '../../ui/Dialog.tsx';
import { Row, Spinner, useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { colorFor, editor, initials } from '../state.ts';

const ROLES = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'author', label: 'Author' },
  { value: 'viewer', label: 'Viewer' },
];

export function MembersPanel() {
  const site = useStore(editor, (s) => s.site);
  const me = useStore(editor, (s) => s.runtime?.user);
  const canManage = !!me && (me.isSuperadmin || me.permissions.includes('*') || me.permissions.includes('core.members'));
  const [list, setList] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const uid = useUid('mem');
  const load = useCallback(() => get<Member[]>(sitePath(site, '/members')).then(setList).catch((e) => toast.error(errorMessage(e))), [site]);
  useEffect(() => {
    load();
  }, [load]);

  const addMember = async (em: string, r: string, nm?: string, isRoleChange = false) => {
    setBusy(true);
    try {
      const res = await post<{ tempPassword?: string }>(sitePath(site, '/members'), { email: em, name: nm || undefined, role: r });
      if (res.tempPassword) setTemp({ email: em, password: res.tempPassword });
      else toast.success(isRoleChange ? 'Role updated' : `${em} added`);
      if (!isRoleChange) {
        setEmail('');
        setName('');
      }
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Members</h2>
        <p className="muted small">People who can edit this site.</p>
      </div>
      <div className="panel-body">
        {!list ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : (
          <ul className="member-list">
            {list.map((m) => (
              <li key={m.id}>
                <span className="avatar" style={{ background: colorFor(m.id) }} aria-hidden="true">
                  {initials(m.name || m.email)}
                </span>
                <span className="member-text">
                  <strong>{m.name || m.email.split('@')[0]}</strong>
                  <span className="muted small">{m.email}</span>
                </span>
                <select className="input sm" aria-label={`Role for ${m.email}`} value={m.role} disabled={!canManage || m.role === 'owner' || m.id === me?.id} onChange={(e) => addMember(m.email, e.target.value, undefined, true)}>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value} disabled={r.value === 'owner' && !me?.isSuperadmin && me?.role !== 'owner'}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-btn sm danger"
                  aria-label={`Remove ${m.email}`}
                  disabled={!canManage || m.role === 'owner' || m.id === me?.id}
                  onClick={() =>
                    del(sitePath(site, `/members/${m.id}`))
                      .then(() => {
                        toast.success('Member removed');
                        load();
                      })
                      .catch((e) => toast.error(errorMessage(e)))
                  }
                >
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            className="sub form"
            onSubmit={(e) => {
              e.preventDefault();
              addMember(email, role, name);
            }}
          >
            <h3>Invite someone</h3>
            <Row label="Email" htmlFor={`${uid}-e`}>
              <input id={`${uid}-e`} className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Row>
            <Row label="Name (optional)" htmlFor={`${uid}-n`}>
              <input id={`${uid}-n`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Row>
            <Row label="Role" htmlFor={`${uid}-r`}>
              <select id={`${uid}-r`} className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.filter((r) => r.value !== 'owner' || me?.isSuperadmin || me?.role === 'owner').map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Row>
            <button className="btn primary" disabled={busy || !email}>
              <Icon name="plus" size={14} /> Add member
            </button>
          </form>
        )}
      </div>
      {temp && (
        <Dialog
          title="Member added"
          onClose={() => setTemp(null)}
          footer={
            <button className="btn primary" onClick={() => setTemp(null)}>
              Done
            </button>
          }
        >
          <p>
            A new account was created for <strong>{temp.email}</strong>. Share this temporary password with them securely:
          </p>
          <p className="temp-pass">
            <code>{temp.password}</code>
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(temp.password).then(() => toast.info('Copied'))}>
              Copy
            </button>
          </p>
        </Dialog>
      )}
    </div>
  );
}
