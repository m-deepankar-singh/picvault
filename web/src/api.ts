import type {
  AlbumDetail,
  AlbumEvent,
  AlbumSummary,
  LoginResponse,
  PhotoRecord,
  PublicKeyResponse,
} from '@picvault/shared/src/api-types';

let authToken: string | null = null;
export function setToken(token: string | null) {
  authToken = token;
}
export function getToken(): string | null {
  return authToken;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface TimelinePhoto {
  id: string;
  albumId: string;
  wrappedPhotoKeyB64: string;
  wrappedThumbKeyB64: string;
  uploadedBy: string;
  mediaType: 'photo' | 'video';
  durationS: number | null;
  chunkCount: number;
  createdAt: string;
}

export interface PhotoNote {
  id: number;
  photoId: string;
  authorId: string;
  kind: 'caption' | 'comment' | 'reaction' | 'favorite';
  bodyCt: string;
  createdAt: string;
}

export const api = {
  salt: (email: string) =>
    call<{ kdfSaltB64: string }>(`/api/salt?email=${encodeURIComponent(email)}`),
  signup: (body: object) =>
    call<LoginResponse>('/api/signup', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: object) =>
    call<LoginResponse>('/api/login', { method: 'POST', body: JSON.stringify(body) }),
  pubkey: (email: string) =>
    call<PublicKeyResponse>(`/api/users/pubkey?email=${encodeURIComponent(email)}`),
  albums: () => call<AlbumSummary[]>('/api/albums'),
  album: (id: string) => call<AlbumDetail>(`/api/albums/${id}`),
  createAlbum: (body: object) =>
    call<AlbumSummary>('/api/albums', { method: 'POST', body: JSON.stringify(body) }),
  addMember: (albumId: string, body: object) =>
    call<{ ok: boolean }>(`/api/albums/${albumId}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  photos: (albumId: string) => call<PhotoRecord[]>(`/api/albums/${albumId}/photos`),
  uploadPhoto: (albumId: string, body: object) =>
    call<PhotoRecord>(`/api/albums/${albumId}/photos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  events: (albumId: string, after: number) =>
    call<AlbumEvent[]>(`/api/albums/${albumId}/events?after=${after}`),
  timeline: (offset = 0, limit = 100) =>
    call<TimelinePhoto[]>(`/api/timeline?offset=${offset}&limit=${limit}`),
  notes: (albumId: string, after = 0) =>
    call<PhotoNote[]>(`/api/albums/${albumId}/notes?after=${after}`),
  addNote: (photoId: string, kind: PhotoNote['kind'], bodyCt: string) =>
    call<PhotoNote>(`/api/photos/${photoId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ kind, bodyCt }),
    }),
  copyPhoto: (photoId: string, body: object) =>
    call<TimelinePhoto>(`/api/photos/${photoId}/copy`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  uploadBlob: (albumId: string, dataB64: string) =>
    call<{ blobId: string }>(`/api/albums/${albumId}/blobs`, {
      method: 'POST',
      body: JSON.stringify({ dataB64 }),
    }),
  registerVideo: (albumId: string, body: object) =>
    call<TimelinePhoto>(`/api/albums/${albumId}/videos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  nudge: (albumId: string) =>
    call<{ ok: boolean }>(`/api/albums/${albumId}/nudge`, { method: 'POST', body: '{}' }),
  chunkBytes: async (photoId: string, n: number): Promise<Uint8Array> => {
    const res = await fetch(`/api/photos/${photoId}/chunk/${n}`, {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    });
    if (!res.ok) throw new Error(`chunk fetch failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
  blobBytes: async (photoId: string, kind: 'blob' | 'thumb'): Promise<Uint8Array> => {
    const res = await fetch(`/api/photos/${photoId}/${kind}`, {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    });
    if (!res.ok) throw new Error(`blob fetch failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
