import { useEffect, useState } from 'react';
import { Auth } from './screens/Auth';
import { Albums } from './screens/Albums';
import { AlbumView } from './screens/AlbumView';
import { Timeline } from './screens/Timeline';
import { loadSession, clearSession } from './vault';
import { setToken } from './api';
import { loadAlbumInfos, type AlbumInfo, type AlbumKind } from './album-meta';

interface SignedIn {
  userId: string;
  email: string;
  publicKeyB64: string;
  privateKey: Uint8Array;
}

export function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SignedIn | null>(null);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [tab, setTab] = useState<'albums' | 'timeline'>('albums');
  const [openAlbum, setOpenAlbum] = useState<{ id: string; kind: AlbumKind } | null>(null);
  const [hidden, setHidden] = useState(false);

  async function refreshAlbums(u: SignedIn) {
    try {
      setAlbums(await loadAlbumInfos(u.publicKeyB64, u.privateKey));
    } catch {
      /* first load may race the network; screens surface their own errors */
    }
  }

  useEffect(() => {
    loadSession().then(async (stored) => {
      if (stored) {
        setToken(stored.session.token);
        const u = {
          userId: stored.session.userId,
          email: stored.session.email,
          publicKeyB64: stored.session.publicKeyB64,
          privateKey: stored.privateKey,
        };
        setUser(u);
        await refreshAlbums(u);
      }
      setReady(true);
    });
  }, []);

  // The after-dark theme also owns the page background outside the app column.
  useEffect(() => {
    document.body.classList.toggle('after-dark-body', openAlbum?.kind === 'spicy');
  }, [openAlbum]);

  // Deterrence: blur all content the instant the tab loses visibility
  // (app switcher previews, casting, screen recording pickers).
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function signedIn() {
    const stored = await loadSession();
    if (stored) {
      const u = {
        userId: stored.session.userId,
        email: stored.session.email,
        publicKeyB64: stored.session.publicKeyB64,
        privateKey: stored.privateKey,
      };
      setUser(u);
      await refreshAlbums(u);
    }
  }

  async function signOut() {
    await clearSession();
    setToken(null);
    setUser(null);
    setAlbums([]);
    setOpenAlbum(null);
  }

  if (!ready) return null;

  const spicy = openAlbum?.kind === 'spicy';
  const appClass = `app${hidden ? ' blurred' : ''}${spicy ? ' after-dark' : ''}`;

  return (
    <div className={appClass}>
      {!user ? (
        <Auth onSignedIn={signedIn} />
      ) : openAlbum ? (
        <AlbumView
          albumId={openAlbum.id}
          kind={openAlbum.kind}
          viewerId={user.userId}
          viewerEmail={user.email}
          viewerPublicKeyB64={user.publicKeyB64}
          albums={albums}
          onBack={() => setOpenAlbum(null)}
        />
      ) : (
        <>
          <nav className="tabs">
            <button className={tab === 'albums' ? 'tab selected' : 'tab'} onClick={() => setTab('albums')}>
              Albums
            </button>
            <button className={tab === 'timeline' ? 'tab selected' : 'tab'} onClick={() => setTab('timeline')}>
              Timeline
            </button>
          </nav>
          {tab === 'albums' ? (
            <Albums
              albums={albums}
              viewerId={user.userId}
              publicKeyB64={user.publicKeyB64}
              onRefresh={() => refreshAlbums(user)}
              onOpen={(id, kind) => setOpenAlbum({ id, kind })}
              onSignOut={signOut}
            />
          ) : (
            <Timeline
              publicKeyB64={user.publicKeyB64}
              privateKey={user.privateKey}
              viewerId={user.userId}
              viewerEmail={user.email}
            />
          )}
        </>
      )}
    </div>
  );
}
