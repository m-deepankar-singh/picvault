import { useEffect, useMemo, useState } from 'react';
import { api, type TimelinePhoto } from '../api';
import { newAlbumKey, wrapAlbumKey } from '../crypto/keys';
import { cacheAlbumKey, getCachedAlbumKey } from '../vault';
import { shareFile } from '../photo-pipeline';
import { CameraCapture } from '../components/CameraCapture';
import { encryptMeta, type AlbumInfo, type AlbumKind } from '../album-meta';

export type { AlbumKind } from '../album-meta';

function dayDiff(iso: string): number {
  return Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 86_400_000);
}

export function Albums(props: {
  albums: AlbumInfo[];
  viewerId: string;
  publicKeyB64: string;
  onRefresh: () => Promise<void>;
  onOpen: (albumId: string, kind: AlbumKind) => void;
  onSignOut: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AlbumKind>('normal');
  const [spicyOpen, setSpicyOpen] = useState(false);
  const [error, setError] = useState('');
  const [cameraFor, setCameraFor] = useState<'choosing' | string | null>(null);
  const [timeline, setTimeline] = useState<TimelinePhoto[]>([]);

  useEffect(() => {
    api.timeline(0, 200).then(setTimeline).catch(() => undefined);
  }, [props.albums]);

  // Memories: something from ~1, ~6, or ~12 months ago this week.
  const memory = useMemo(() => {
    const spicyIds = new Set(props.albums.filter((a) => a.kind === 'spicy').map((a) => a.id));
    for (const target of [365, 180, 30]) {
      const hit = timeline.find(
        (p) => !spicyIds.has(p.albumId) && Math.abs(dayDiff(p.createdAt) - target) <= 3
      );
      if (hit) {
        const album = props.albums.find((a) => a.id === hit.albumId);
        const months = Math.round(target / 30);
        return album ? { album, months } : null;
      }
    }
    return null;
  }, [timeline, props.albums]);

  // Streak: consecutive days (ending today or yesterday) where BOTH of you
  // shared something. Computed entirely on-device.
  const streak = useMemo(() => {
    const mine = new Set<string>();
    const theirs = new Set<string>();
    for (const p of timeline) {
      (p.uploadedBy === props.viewerId ? mine : theirs).add(p.createdAt.slice(0, 10));
    }
    let count = 0;
    const day = new Date();
    const iso = () => day.toISOString().slice(0, 10);
    if (!(mine.has(iso()) && theirs.has(iso()))) day.setDate(day.getDate() - 1);
    while (mine.has(iso()) && theirs.has(iso())) {
      count++;
      day.setDate(day.getDate() - 1);
    }
    return count;
  }, [timeline, props.viewerId]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const albumKey = await newAlbumKey();
      const nameCt = await encryptMeta(newName, newKind, albumKey);
      // wrap for ourselves; members added later get their own wrap
      const wrappedAlbumKeyB64 = await wrapAlbumKey(albumKey, props.publicKeyB64);
      const album = await api.createAlbum({ nameCt, wrappedAlbumKeyB64 });
      cacheAlbumKey(album.id, albumKey);
      setNewName('');
      setCreating(false);
      if (newKind === 'spicy') setSpicyOpen(true);
      await props.onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  const sweet = props.albums.filter((a) => a.kind === 'normal');
  const spicy = props.albums.filter((a) => a.kind === 'spicy');

  const renderList = (items: AlbumInfo[], emptyCopy: string) => (
    <ul className="album-list">
      {items.map((a) => (
        <li key={a.id}>
          <button onClick={() => props.onOpen(a.id, a.kind)}>
            <span className="album-name">{a.name}</span>
            <span className="album-date">{a.createdAt.slice(0, 10)}</span>
          </button>
        </li>
      ))}
      {items.length === 0 && <li className="empty">{emptyCopy}</li>}
    </ul>
  );

  return (
    <div className="albums-screen">
      <header>
        <h1>Albums</h1>
        <span>
          {streak >= 2 && <span className="streak" title="Days in a row you both shared">{streak}-day streak</span>}
          <button className="link" onClick={props.onSignOut}>sign out</button>
        </span>
      </header>
      {error && <p className="error">{error}</p>}

      {memory && (
        <button className="memory-card" onClick={() => props.onOpen(memory.album.id, memory.album.kind)}>
          <span className="eyebrow">From our archive</span>
          <span className="memory-line">
            Around {memory.months === 12 ? 'a year' : `${memory.months} month${memory.months > 1 ? 's' : ''}`} ago,
            in “{memory.album.name}”
          </span>
        </button>
      )}

      <section>
        <h2 className="section-title">Everyday</h2>
        {renderList(sweet, 'No albums yet — start your first one together.')}
      </section>

      <section className="spicy-section">
        <button className="spicy-toggle" onClick={() => setSpicyOpen(!spicyOpen)}>
          <span>After dark</span>
          <span className="spicy-count">{spicyOpen ? 'hide' : spicy.length || ''}</span>
        </button>
        {spicyOpen && <div className="spicy-shelf">{renderList(spicy, 'Nothing in here… yet.')}</div>}
      </section>

      {creating ? (
        <form onSubmit={create} className="new-album">
          <input
            autoFocus
            placeholder="album name (encrypted)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <div className="kind-picker" role="radiogroup" aria-label="Album type">
            <button
              type="button"
              role="radio"
              aria-checked={newKind === 'normal'}
              className={newKind === 'normal' ? 'kind selected' : 'kind'}
              onClick={() => setNewKind('normal')}
            >
              Everyday
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={newKind === 'spicy'}
              className={newKind === 'spicy' ? 'kind selected spicy' : 'kind spicy'}
              onClick={() => setNewKind('spicy')}
            >
              After dark
            </button>
          </div>
          <div className="new-album-actions">
            <button type="submit">Create</button>
            <button type="button" className="link" onClick={() => setCreating(false)}>cancel</button>
          </div>
        </form>
      ) : (
        <div className="fab-row">
          <button
            className="fab-secondary"
            onClick={() => setCameraFor('choosing')}
            disabled={props.albums.length === 0}
          >
            Camera
          </button>
          <button className="fab" onClick={() => setCreating(true)}>+ New album</button>
        </div>
      )}

      {cameraFor === 'choosing' && (
        <div className="picker" role="dialog" aria-label="Save photo to album">
          <p className="section-title">Save the photo to…</p>
          <ul className="album-list">
            {props.albums.map((a) => (
              <li key={a.id}>
                <button onClick={() => setCameraFor(a.id)}>
                  <span className="album-name">{a.name}</span>
                  <span className="album-date">{a.kind === 'spicy' ? 'after dark' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="link" onClick={() => setCameraFor(null)}>cancel</button>
        </div>
      )}
      {cameraFor && cameraFor !== 'choosing' && (
        <CameraCapture
          onCapture={async (file) => {
            const key = getCachedAlbumKey(cameraFor);
            if (!key) throw new Error('album key missing — reopen the app');
            await shareFile(file, cameraFor, key);
          }}
          onClose={() => setCameraFor(null)}
        />
      )}
    </div>
  );
}
