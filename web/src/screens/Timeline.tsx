import { useEffect, useMemo, useState } from 'react';
import type { TimelinePhoto } from '../api';
import { api } from '../api';
import { decryptPhoto } from '../crypto/photo';
import { loadAlbumInfos, type AlbumInfo } from '../album-meta';
import { SecureImage } from '../components/SecureImage';
import { Viewer, type ViewerItem } from '../components/Viewer';

interface Tile {
  record: TimelinePhoto;
  album: AlbumInfo;
  thumb: Uint8Array | null;
}

export function Timeline(props: {
  publicKeyB64: string;
  privateKey: Uint8Array;
  viewerId: string;
  viewerEmail: string;
}) {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [includeSpicy, setIncludeSpicy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);

  async function load(offset: number) {
    setLoadingMore(true);
    try {
      const albums = await loadAlbumInfos(props.publicKeyB64, props.privateKey);
      const byId = new Map(albums.map((a) => [a.id, a]));
      const names: Record<string, string> = { [props.viewerId]: props.viewerEmail };
      for (const a of albums) {
        const detail = await api.album(a.id);
        for (const m of detail.members) names[m.userId] = m.email;
      }
      setMemberNames(names);
      const records = await api.timeline(offset, 100);
      if (records.length < 100) setDone(true);
      const loaded = await Promise.all(
        records.map(async (record) => {
          const album = byId.get(record.albumId);
          if (!album) return null;
          try {
            const ct = await api.blobBytes(record.id, 'thumb');
            const thumb = await decryptPhoto(ct, record.wrappedThumbKeyB64, album.key);
            return { record, album, thumb };
          } catch {
            return { record, album, thumb: null };
          }
        })
      );
      setTiles((prev) => [...prev, ...(loaded.filter(Boolean) as Tile[])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    setTiles([]);
    setDone(false);
    load(0);
  }, []);

  const visible = useMemo(
    () => tiles.filter((t) => includeSpicy || t.album.kind !== 'spicy'),
    [tiles, includeSpicy]
  );

  // group by day, newest first (records already arrive newest-first)
  const groups = useMemo(() => {
    const map = new Map<string, Tile[]>();
    for (const t of visible) {
      const day = t.record.createdAt.slice(0, 10);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(t);
    }
    return [...map.entries()];
  }, [visible]);

  const viewerItems: ViewerItem[] = visible.map((t) => ({ record: t.record, albumKey: t.album.key }));

  return (
    <div className="album-view timeline">
      <div className="timeline-controls">
        <span className="section-title">Every day, together</span>
        <button className="link" onClick={() => setIncludeSpicy(!includeSpicy)}>
          {includeSpicy ? 'hide after dark' : 'include after dark'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      {groups.map(([day, dayTiles]) => (
        <section key={day}>
          <h2 className="day-header">{day}</h2>
          <div className="grid">
            {dayTiles.map((t) => (
              <div key={t.record.id} className="tile">
                <SecureImage
                  bytes={t.thumb}
                  watermark={`${props.viewerEmail} · ${day}`}
                  className={t.album.kind === 'spicy' && !includeSpicy ? 'thumb veiled-tile' : 'thumb'}
                  onClick={() => setOpen(viewerItems.findIndex((v) => v.record.id === t.record.id))}
                />
                {t.record.mediaType === 'video' && <span className="video-badge">▶</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && !loadingMore && (
        <p className="empty">Nothing here yet — your days will collect below.</p>
      )}
      {!done && !loadingMore && tiles.length > 0 && (
        <button className="link" onClick={() => load(tiles.length)}>load more</button>
      )}
      {loadingMore && <p className="empty">decrypting…</p>}

      {open !== null && open >= 0 && (
        <Viewer
          items={viewerItems}
          startIndex={open}
          viewerId={props.viewerId}
          viewerEmail={props.viewerEmail}
          memberNames={memberNames}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
