// Request/response types shared between server and web client.
// All *B64 fields are base64 (original variant). The server treats every
// one of them as an opaque blob — it can never decrypt any of them.

export interface SignupRequest {
  email: string;
  authHashB64: string;
  kdfSaltB64: string;
  publicKeyB64: string;
  keyBackupB64: string;
}

export interface LoginRequest {
  email: string;
  authHashB64: string;
}

export interface LoginResponse {
  token: string;
  userId: string;
  email: string;
  kdfSaltB64: string;
  keyBackupB64: string;
  publicKeyB64: string;
}

export interface SaltResponse {
  kdfSaltB64: string;
}

export interface CreateAlbumRequest {
  nameCt: string; // album name, encrypted client-side with the album key
  wrappedAlbumKeyB64: string; // album key sealed to the creator's own public key
}

export interface AlbumSummary {
  id: string;
  nameCt: string;
  wrappedAlbumKeyB64: string;
  createdAt: string;
}

export interface AddMemberRequest {
  email: string;
  wrappedAlbumKeyB64: string; // album key sealed to the invitee's public key
}

export interface AlbumMember {
  userId: string;
  email: string;
  publicKeyB64: string;
}

export interface AlbumDetail extends AlbumSummary {
  members: AlbumMember[];
}

export interface UploadPhotoRequest {
  photoB64: string; // encrypted full-size image bytes
  thumbB64: string; // encrypted thumbnail bytes
  wrappedPhotoKeyB64: string;
  wrappedThumbKeyB64: string;
}

export interface PhotoRecord {
  id: string;
  albumId: string;
  wrappedPhotoKeyB64: string;
  wrappedThumbKeyB64: string;
  uploadedBy: string;
  createdAt: string;
}

export interface AlbumEvent {
  id: number;
  albumId: string;
  kind: 'album_created' | 'member_added' | 'photo_added';
  payload: string; // JSON
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface PublicKeyResponse {
  userId: string;
  publicKeyB64: string;
}
