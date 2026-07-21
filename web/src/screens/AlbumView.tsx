import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlbumDetail } from '@picvault/shared/src/api-types';
import type { PhotoNote, TimelinePhoto } from '../api';
import { api } from '../api';
import { wrapAlbumKey, unwrapWithKey, wrapWithKey } from '../crypto/keys';
import { decryptPhoto } from '../crypto/photo';
import { safetyNumber } from '../crypto/safety';
import { getCachedAlbumKey } from '../vault';
import { shareFile, shareVideo } from '../photo-pipeline';
import { SecureImage } from '../components/SecureImage';
import { CameraCapture } from '../components/CameraCapture';
import { DuetCapture } from '../components/DuetCapture';
import { Viewer } from '../components/Viewer';
import type { AlbumInfo } from '../album-meta';

interface LoadedPhoto {
  record: TimelinePhoto;
  thumb: Uint8Array | null;
}

type Filter = 'all' | 'mine' | 'theirs' | 'favorites';

export function AlbumView(props: {
  albumId: string;
  kind: 'normal' | 'spicy';
  viewerId: string;
  viewerEmail: string;
  viewerPublicKeyB64: string;
  albums: AlbumInfo[];
  onBack: () => void;
}) {
  const spicy = props.kind === 'spicy';
  const [veiled, setVeiled] = useState(true);
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  const [photos, setPhotos] = useState<LoadedPhoto[]>([]);
  const [notes, setNotes] = useState<PhotoNote[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [safety, setSafety] = useState<{ email: string; number: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [capture, setCapture] = useState<'none' | 'solo' | 'duet'>('none');
  const [copyOf, setCopyOf] = useState<TimelinePhoto | null>(null);
  const [nudgedAt, setNudgedAt] = useState<string | null>(null);
  const lastEventId = useRef(0);
  const albumKey = getCachedAlbumKey(props.albumId);

  async function loadPhotos() {
    if (!albumKey) return;
    const records = (await api.photos(props.albumId)) as unknown as TimelinePhoto[];
    const loaded = await Promise.all(
      records.map(async (record) => {
        try {
          const ct = await api.blobBytes(record.id, 'thumb');
          const thumb = await decryptPhoto(ct, record.wrappedThumbKeyB64, albumKey);
          return { record, thumb };
        } catch {
          return { record, thumb: null };
        }
      })
    );
    setPhotos(loaded);
    setNotes(await api.notes(props.albumId));
  }

  function scanEvents(events: { kind: string; payload: string; createdAt: string }[]) {
    for (const e of events) {
      if (e.kind === 'nudge_sent') {
        try {
          const { by } = JSON.parse(e.payload) as { by: string };
          const ageMin = (Date.now() - new Date(e.createdAt + 'Z').getTime()) / 60000;
          if (by !== props.viewerId && ageMin < 60) setNudgedAt(e.createdAt);
        } catch {
          /* ignore */
        }
      }
    }
  }

  useEffect(() => {
    api.album(props.albumId).then(setDetail).catch((e) => setError(e.message));
    loadPhotos().catch((e) => setError(e.message));
    api.events(props.albumId, 0).then((evts) => {
      if (evts.length) lastEventId.current = evts[evts.length - 1]!.id;
      scanEvents(evts);
    });
    const timer = setInterval(async () => {
      try {
        const events = await api.events(props.albumId, lastEventId.current);
        if (events.length > 0) {
          lastEventId.current = events[events.length - 1]!.id;
          scanEvents(events);
          await loadPhotos();
          setDetail(await api.album(props.albumId));
        }
      } catch {
        /* transient poll errors are fine */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [props.albumId]);

  async function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length === 0 || !albumKey) return;
    setBusy(true);
    setError('');
    const failed: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(files.length > 1 ? `${i + 1} of ${files.length}` : 'encrypting…');
      try {
        await shareFile(files[i]!, props.albumId, albumKey);
      } catch {
        failed.push(files[i]!.name);
      }
    }
    setProgress('');
    setBusy(false);
    if (failed.length) setError(`Failed: ${failed.join(', ')} — try those again.`);
    await loadPhotos();
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!albumKey) return;
    setError('');
    try {
      const { publicKeyB64 } = await api.pubkey(inviteEmail);
      const wrappedAlbumKeyB64 = await wrapAlbumKey(albumKey, publicKeyB64);
      await api.addMember(props.albumId, { email: inviteEmail, wrappedAlbumKeyB64 });
      setInviteEmail('');
      setDetail(await api.album(props.albumId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'invite failed');
    }
  }

  async function copyTo(target: AlbumInfo) {
    if (!copyOf || !albumKey) return;
    try {
      const photoKey = await unwrapWithKey(copyOf.wrappedPhotoKeyB64, albumKey);
      const thumbKey = await unwrapWithKey(copyOf.wrappedThumbKeyB64, albumKey);
      await api.copyPhoto(copyOf.id, {
        toAlbumId: target.id,
        wrappedPhotoKeyB64: await wrapWithKey(photoKey, target.key),
        wrappedThumbKeyB64: await wrapWithKey(thumbKey, target.key),
      });
      setCopyOf(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'copy failed');
    }
  }

  const memberNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const m of detail?.members ?? []) names[m.userId] = m.email;
    return names;
  }, [detail]);

  const favCount = (photoId: string, userId?: string) =>
    notes.filter(
      (n) => n.kind === 'favorite' && n.photoId === photoId && (!userId || n.authorId === userId)
    ).length;

  const visible = useMemo(
    () =>
      photos.filter((p) => {
        if (filter === 'mine') return p.record.uploadedBy === props.viewerId;
        if (filter === 'theirs') return p.record.uploadedBy !== props.viewerId;
        if (filter === 'favorites') return favCount(p.record.id) % 2 === 1;
        return true;
      }),
    [photos, filter, notes]
  );

  const watermark = `${props.viewerEmail} · ${new Date().toISOString().slice(0, 10)}`;
  const otherAlbums = props.albums.filter((a) => a.id !== props.albumId);

  return (
    <div className="album-view">
      <header>
        <button className="link" onClick={props.onBack}>← back</button>
        <div>
          {spicy && (
            <button className="link" onClick={() => setVeiled(!veiled)}>
              {veiled ? 'reveal' : 'veil'}
            </button>
          )}
          <button className="link" onClick={() => setShowMembers(!showMembers)}>
            members ({detail?.members.length ?? '…'})
          </button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {progress && <p className="hint">Encrypting and sharing — {progress}</p>}

      {nudgedAt && (
        <div className="nudge-banner">
          <span>They'd love a photo right now.</span>
          <button className="link" onClick={() => { setNudgedAt(null); setCapture('solo'); }}>
            open camera
          </button>
          <button className="link" onClick={() => setNudgedAt(null)}>later</button>
        </div>
      )}

      {showMembers && detail && (
        <section className="members">
          <ul>
            {detail.members.map((m) => (
              <li key={m.userId}>
                {m.email}
                {m.email !== props.viewerEmail && (
                  <button
                    className="link"
                    onClick={async () =>
                      setSafety({
                        email: m.email,
                        number: await safetyNumber(props.viewerPublicKeyB64, m.publicKeyB64),
                      })
                    }
                  >
                    verify
                  </button>
                )}
              </li>
            ))}
          </ul>
          <form onSubmit={invite}>
            <input
              type="email"
              placeholder="invite by email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
            />
            <button type="submit">Invite</button>
          </form>
          <button className="link" onClick={() => api.nudge(props.albumId)}>
            Ask them for a photo
          </button>
          {safety && (
            <div className="safety">
              <p>
                Compare with <strong>{safety.email}</strong> on another channel. If the numbers
                match, your encryption is not being intercepted:
              </p>
              <code>{safety.number}</code>
              <button className="link" onClick={() => setSafety(null)}>close</button>
            </div>
          )}
          <p className="hint">
            Photos in this album are permanent: nobody — not even you — can delete them.
          </p>
        </section>
      )}

      <div className="filter-row">
        {(['all', 'mine', 'theirs', 'favorites'] as Filter[]).map((f) => (
          <button
            key={f}
            className={filter === f ? 'chip selected' : 'chip'}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className={spicy && veiled ? 'grid veiled' : 'grid'}>
        {visible.map((p, i) => (
          <div key={p.record.id} className="tile">
            <SecureImage
              bytes={p.thumb}
              watermark={watermark}
              className="thumb"
              onClick={() => {
                if (spicy && veiled) setVeiled(false);
                else setOpenIdx(i);
              }}
            />
            {p.record.mediaType === 'video' && <span className="video-badge">▶</span>}
            {favCount(p.record.id) % 2 === 1 && <span className="fav-badge">♥</span>}
            {otherAlbums.length > 0 && (
              <button className="tile-copy" onClick={() => setCopyOf(p.record)} title="Add to album">
                +
              </button>
            )}
          </div>
        ))}
        {photos.length === 0 && <p className="empty">No photos yet — share the first one.</p>}
      </div>

      <div className="fab-row">
        <button className="fab-secondary" onClick={() => setCapture('solo')} disabled={busy}>
          Camera
        </button>
        <label className="fab">
          {busy ? progress || 'working…' : '+ Share'}
          <input type="file" accept="image/*" multiple onChange={pickFiles} hidden disabled={busy} />
        </label>
        <button className="fab-secondary" onClick={() => setCapture('duet')} disabled={busy}>
          Together
        </button>
      </div>

      {capture === 'solo' && albumKey && (
        <CameraCapture
          onCapture={async (file) => {
            await shareFile(file, props.albumId, albumKey);
            await loadPhotos();
          }}
          onCaptureVideo={async (video, poster, durationS) => {
            setProgress('encrypting video…');
            await shareVideo(video, poster, durationS, props.albumId, albumKey, (d, t) =>
              setProgress(`uploading ${d}/${t}`)
            );
            setProgress('');
            await loadPhotos();
          }}
          onClose={() => setCapture('none')}
        />
      )}
      {capture === 'duet' && albumKey && (
        <DuetCapture
          albumId={props.albumId}
          onCapture={async (file) => {
            await shareFile(file, props.albumId, albumKey);
            await loadPhotos();
          }}
          onClose={() => setCapture('none')}
        />
      )}

      {copyOf && (
        <div className="picker" role="dialog" aria-label="Add to album">
          <p className="section-title">Add to…</p>
          <ul className="album-list">
            {otherAlbums.map((a) => (
              <li key={a.id}>
                <button onClick={() => copyTo(a)}>
                  <span className="album-name">{a.name}</span>
                  <span className="album-date">{a.kind === 'spicy' ? 'after dark' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">Adding never removes — albums only grow.</p>
          <button className="link" onClick={() => setCopyOf(null)}>cancel</button>
        </div>
      )}

      {openIdx !== null && albumKey && (
        <Viewer
          items={visible.map((p) => ({ record: p.record, albumKey }))}
          startIndex={openIdx}
          viewerId={props.viewerId}
          viewerEmail={props.viewerEmail}
          memberNames={memberNames}
          onClose={() => {
            setOpenIdx(null);
            loadPhotos();
          }}
        />
      )}
    </div>
  );
}
