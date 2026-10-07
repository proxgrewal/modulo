import { useEffect, useState } from 'react';
import { get, post } from './api.ts';
import { EditorShell } from './editor/EditorShell.tsx';
import { actions } from './editor/state.ts';
import { navigate, useRoute } from './router.ts';
import { AuthScreen } from './screens/Auth.tsx';
import { NewSiteScreen, SitesScreen } from './screens/Sites.tsx';
import type { User } from './types.ts';
import { Spinner } from './ui/controls.tsx';
import { Toasts } from './ui/Toasts.tsx';

export function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    get<{ user: User | null }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  // Route guards: signed-out users go to login; signed-in users skip auth screens.
  useEffect(() => {
    if (user === undefined) return;
    if (!user && route.name !== 'login' && route.name !== 'signup') navigate({ name: 'login' }, true);
    if (user && (route.name === 'login' || route.name === 'signup' || route.name === 'home')) navigate({ name: 'sites' }, true);
  }, [user, route.name]);

  const logout = async () => {
    await post('/api/auth/logout').catch(() => {});
    actions.closePage();
    setUser(null);
    navigate({ name: 'login' }, true);
  };

  let screen: React.ReactNode;
  if (user === undefined) screen = <div className="screen-center"><Spinner label="Loading" /></div>;
  else if (!user) screen = <AuthScreen mode={route.name === 'signup' ? 'signup' : 'login'} onAuthed={(u) => (setUser(u), navigate({ name: 'sites' }, true))} />;
  else if (route.name === 'editor' && route.site) screen = <EditorShell site={route.site} page={route.page} onLogout={logout} />;
  else if (route.name === 'new-site') screen = <NewSiteScreen user={user} onLogout={logout} />;
  else screen = <SitesScreen user={user} onLogout={logout} />;

  return (
    <>
      {screen}
      <Toasts />
    </>
  );
}
