import { useEffect, useMemo, useRef, useState } from 'react';
import type { PhotoNote, TimelinePhoto } from '../api';
import { api } from '../api';
import { decryptPhoto, decryptVideoChunk } from '../crypto/photo';
import { wrapWithKey, unwrapWithKey } from '../crypto/keys';
import { getSodium } from '../crypto/sodium';
import { SecureImage } from './SecureImage';

export interface ViewerItem {
  record: TimelinePhoto;
  albumKey: Uint8Array;
}

const REACTIONS = ['❤️', '😂', '😮', '🥺', '🔥'];

async function sealText(text: string, key: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return wrapWithKey(sodium.from_string(text), key);
}

async function openText(ct: string, key: Uint8Array): Promise<string> {
  if (!ct) return '';
  const sodium = await getSodium();
  try {
    return sodium.to_string(await unwrapWithKey(ct, key));
  } catch {
    return '';
  }
}

export function Viewer(props: {
  items: ViewerItem[];
  startIndex: number;
  viewerId: string;
  viewerEmail: string;
  memberNames: Record<string, string>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(props.startIndex);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [notes, setNotes] = useState<(PhotoNote & { body: string })[]>([]);
  const [comment, setComment] = useState('');
  const [captionDraft, setCaptionDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const touchStart = useRef<number | null>(null);

  const item = props.items[index];

  async function loadMedia(it: ViewerItem) {
    setLoading(true);
    setBytes(null);
    setZoomed(false);
    setVideoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    try {
      if (it.record.mediaType === 'video') {
        const parts: Uint8Array[] = [];
        for (let n = 0; n < it.record.chunkCount; n++) {
          const ct = await api.chunkBytes(it.record.id, n);
          parts.push(await decryptVideoChunk(ct, it.record.wrappedPhotoKeyB64, it.albumKey));
        }
        const buffers = parts.map((p) => p.slice().buffer as ArrayBuffer);
        setVideoUrl(URL.createObjectURL(new Blob(buffers, { type: 'video/webm' })));
      } else {
        const ct = await api.blobBytes(it.record.id, 'blob');
        setBytes(await decryptPhoto(ct, it.record.wrappedPhotoKeyB64, it.albumKey));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function loadNotes(it: ViewerItem) {
    const all = await api.notes(it.record.albumId);
    const mine = all.filter((n) => n.photoId === it.record.id);
    setNotes(
      await Promise.all(
        mine.map(async (n) => ({ ...n, body: await openText(n.bodyCt, it.albumKey) }))
      )
    );
  }

  useEffect(() => {
    if (!item) return;
    loadMedia(item);
    loadNotes(item).catch(() => undefined);
    return () => {
      setVideoUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    };
  }, [index]);

  const go = (dir: number) => {
    const next = index + dir;
    if (next >= 0 && next < props.items.length) setIndex(next);
  };

  // Append-only favorites: your heart is "on" when you've marked it an odd
  // number of times.
  const favOn = notes.filter((n) => n.kind === 'favorite' && n.authorId === props.viewerId).length % 2 === 1;
  const caption = notes.filter((n) => n.kind === 'caption').at(-1)?.body ?? '';
  const comments = notes.filter((n) => n.kind === 'comment');
  const reactions = notes.filter((n) => n.kind === 'reaction').map((n) => n.body).filter(Boolean);

  async function addNote(kind: PhotoNote['kind'], text: string) {
    if (!item) return;
    const bodyCt = text ? await sealText(text, item.albumKey) : '';
    await api.addNote(item.record.id, kind, bodyCt);
    await loadNotes(item);
  }

  if (!item) return null;
  const isUploader = item.record.uploadedBy === props.viewerId;
  const uploaderName = props.memberNames[item.record.uploadedBy] ?? 'them';
  const watermark = `${props.viewerEmail} · ${new Date().toISOString().slice(0, 10)}`;

  return (
    <div className="viewer" role="dialog" aria-label="Photo viewer">
      <div
        className="viewer-stage"
        onPointerDown={(e) => (touchStart.current = e.clientX)}
        onPointerUp={(e) => {
          if (touchStart.current === null) return;
          const dx = e.clientX - touchStart.current;
          touchStart.current = null;
          if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
        }}
        onDoubleClick={() => setZoomed(!zoomed)}
      >
        {loading && <p className="viewer-loading">decrypting…</p>}
        {error && <p className="error">{error}</p>}
        {videoUrl && (
          <video src={videoUrl} controls autoPlay playsInline className="viewer-video" />
        )}
        {bytes && (
          <SecureImage
            bytes={bytes}
            watermark={watermark}
            className={zoomed ? 'viewer-img zoomed' : 'viewer-img'}
          />
        )}
        {index > 0 && (
          <button className="pager prev" onClick={() => go(-1)} aria-label="Previous">‹</button>
        )}
        {index < props.items.length - 1 && (
          <button className="pager next" onClick={() => go(1)} aria-label="Next">›</button>
        )}
        <button className="viewer-close" onClick={props.onClose} aria-label="Close">×</button>
      </div>

      <div className="viewer-panel">
        <div className="viewer-meta">
          <span className="eyebrow">
            {uploaderName === props.viewerEmail ? 'you' : uploaderName} ·{' '}
            {item.record.createdAt.slice(0, 10)}
            {item.record.mediaType === 'video' && item.record.durationS
              ? ` · ${item.record.durationS}s`
              : ''}
          </span>
          <button
            className={favOn ? 'heart on' : 'heart'}
            onClick={() => addNote('favorite', '')}
            aria-label="Favorite"
          >
            {favOn ? '♥' : '♡'}
          </button>
        </div>

        {captionDraft !== null ? (
          <form
            className="caption-form"
            onSubmit={async (e) => {
              e.preventDefault();
              await addNote('caption', captionDraft);
              setCaptionDraft(null);
            }}
          >
            <input
              autoFocus
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              placeholder="caption (encrypted)"
            />
            <button type="submit" className="link">save</button>
          </form>
        ) : (
          <p className="caption" onClick={() => isUploader && setCaptionDraft(caption)}>
            {caption || (isUploader ? 'Add a caption…' : '')}
          </p>
        )}

        <div className="reactions">
          {REACTIONS.map((emo) => (
            <button key={emo} className="reaction" onClick={() => addNote('reaction', emo)}>
              {emo}
            </button>
          ))}
          {reactions.length > 0 && <span className="reaction-cluster">{reactions.join(' ')}</span>}
        </div>

        <ul className="comments">
          {comments.map((c) => (
            <li key={c.id}>
              <span className="comment-author">
                {props.memberNames[c.authorId] === props.viewerEmail
                  ? 'you'
                  : props.memberNames[c.authorId] ?? 'them'}
              </span>
              {c.body}
            </li>
          ))}
        </ul>
        <form
          className="comment-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!comment.trim()) return;
            await addNote('comment', comment.trim());
            setComment('');
          }}
        >
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="write something (encrypted)"
          />
          <button type="submit" className="link">send</button>
        </form>
      </div>
    </div>
  );
}
