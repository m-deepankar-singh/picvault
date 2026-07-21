import { useState } from 'react';
import { api, setToken } from '../api';
import {
  deriveFromPassword,
  newSalt,
  generateIdentityKeypair,
  encryptPrivateKeyBackup,
  decryptPrivateKeyBackup,
} from '../crypto/keys';
import { saveSession } from '../vault';

// One form for both people. We try to open an existing vault first; if the
// email is unknown, a new vault is created on this device. A wrong password
// on an existing vault surfaces as exactly that.
export function Auth(props: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setStatus('Unlocking…');
      const { kdfSaltB64: loginSalt } = await api.salt(email);
      const derived = await deriveFromPassword(password, loginSalt);
      try {
        const res = await api.login({ email, authHashB64: derived.authHashB64 });
        const privateKey = await decryptPrivateKeyBackup(res.keyBackupB64, derived.masterKey);
        setToken(res.token);
        await saveSession(
          { token: res.token, userId: res.userId, email: res.email, publicKeyB64: res.publicKeyB64 },
          privateKey
        );
        props.onSignedIn();
        return;
      } catch {
        // Unknown email or wrong password — try creating a vault; a 409
        // tells us the vault exists and the password was wrong.
      }
      setStatus('Creating your vault…');
      const kdfSaltB64 = await newSalt();
      const { authHashB64, masterKey } = await deriveFromPassword(password, kdfSaltB64);
      const { publicKeyB64, privateKey } = await generateIdentityKeypair();
      const keyBackupB64 = await encryptPrivateKeyBackup(privateKey, masterKey);
      try {
        const res = await api.signup({ email, authHashB64, kdfSaltB64, publicKeyB64, keyBackupB64 });
        setToken(res.token);
        await saveSession(
          { token: res.token, userId: res.userId, email: res.email, publicKeyB64 },
          privateKey
        );
        props.onSignedIn();
      } catch (err) {
        if (err instanceof Error && /registered/.test(err.message)) {
          setError('Wrong password for this vault.');
        } else {
          setError(err instanceof Error ? err.message : 'Could not open the vault.');
        }
      }
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  return (
    <div className="auth-screen">
      <p className="eyebrow">A private edition · encrypted on your device</p>
      <h1>PicVault</h1>
      <p className="tagline">The photographs that are only for the two of you.</p>
      <form onSubmit={submit}>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            minLength={8}
            required
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy} type="submit">
          {busy ? status || 'Working…' : 'Open vault'}
        </button>
      </form>
      <p className="hint">
        First time here? Your vault and its keys are created on this device the moment you open
        it. Your password never leaves your hands — and can never be recovered.
      </p>
    </div>
  );
}
