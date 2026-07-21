import { useEffect, useRef, useState } from 'react';
import { getToken } from '../api';

// "Together" capture: both people open this in the same album. Video flows
// peer-to-peer over WebRTC, end-to-end encrypted by DTLS-SRTP — the server
// only relays the opaque connection handshake and never sees a frame.
// Either person can press the shutter; a 3-second count lets you both pose.
//
// iceServers is empty on purpose: with no STUN/TURN configured, connections
// work on the same network. For captures across the internet, point this at
// a coturn server on the EC2 box — never at a third party.
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

type Layout = 'side' | 'ghost';

export function DuetCapture(props: {
  albumId: string;
  onCapture: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [layout, setLayout] = useState<Layout>('side');
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let closed = false;

    function send(msg: object) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    }

    function makePc(stream: MediaStream): RTCPeerConnection {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: 'ice', payload: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        if (remoteRef.current && e.streams[0]) {
          remoteRef.current.srcObject = e.streams[0];
          setConnected(true);
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setConnected(false);
        }
      };
      pcRef.current = pc;
      return pc;
    }

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        setError('Camera unavailable. Check permissions and try again.');
        return;
      }
      if (closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (localRef.current) localRef.current.srcObject = stream;

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${location.host}/api/rtc?token=${getToken()}&album=${props.albumId}`
      );
      wsRef.current = ws;

      ws.onmessage = async (evt) => {
        const msg = JSON.parse(evt.data as string) as { type: string; payload?: unknown };
        try {
          if (msg.type === 'peer-joined') {
            // We were here first — we make the offer.
            const pc = makePc(stream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({ type: 'offer', payload: offer });
          } else if (msg.type === 'offer') {
            const pc = pcRef.current ?? makePc(stream);
            await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send({ type: 'answer', payload: answer });
          } else if (msg.type === 'answer') {
            await pcRef.current?.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
          } else if (msg.type === 'ice') {
            await pcRef.current?.addIceCandidate(msg.payload as RTCIceCandidateInit);
          } else if (msg.type === 'peer-left') {
            setConnected(false);
            pcRef.current?.close();
            pcRef.current = null;
          }
        } catch {
          setError('Connection hiccup — close and try again.');
        }
      };
      ws.onclose = (evt) => {
        if (evt.code === 4401) setError('Not authorized for this album.');
      };
    })();

    return () => {
      closed = true;
      pcRef.current?.close();
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [props.albumId]);

  async function shutter() {
    const local = localRef.current;
    const remote = remoteRef.current;
    if (!local || !remote || remote.videoWidth === 0) return;
    setBusy(true);
    for (let n = 3; n > 0; n--) {
      setCount(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCount(null);
    try {
      const H = 1080;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      if (layout === 'side') {
        const wL = Math.round((local.videoWidth / local.videoHeight) * H);
        const wR = Math.round((remote.videoWidth / remote.videoHeight) * H);
        canvas.width = wL + wR;
        canvas.height = H;
        ctx.drawImage(local, 0, 0, wL, H);
        ctx.drawImage(remote, wL, 0, wR, H);
      } else {
        const w = Math.round((local.videoWidth / local.videoHeight) * H);
        canvas.width = w;
        canvas.height = H;
        ctx.drawImage(local, 0, 0, w, H);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(remote, 0, 0, w, H);
        ctx.globalAlpha = 1;
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture failed'))), 'image/jpeg', 0.92)
      );
      await props.onCapture(new File([blob], 'together.jpg', { type: 'image/jpeg' }));
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'capture failed');
      setBusy(false);
    }
  }

  return (
    <div className="camera-modal">
      {error && <p className="error camera-error">{error}</p>}
      {!error && (
        <div className={layout === 'ghost' ? 'duet-stage ghost' : 'duet-stage'}>
          <video ref={localRef} autoPlay playsInline muted className="camera-feed local" />
          <video ref={remoteRef} autoPlay playsInline className="camera-feed remote" />
          {!connected && (
            <p className="duet-waiting">
              Waiting for them to open <em>Together</em> in this album…
            </p>
          )}
          {count !== null && <div className="countdown">{count}</div>}
        </div>
      )}
      <div className="camera-bar">
        <button className="link" onClick={props.onClose}>close</button>
        <button
          className="shutter"
          onClick={shutter}
          disabled={busy || !connected}
          aria-label="Take photo together"
        />
        <button
          className="link"
          onClick={() => setLayout(layout === 'side' ? 'ghost' : 'side')}
          disabled={!connected}
        >
          {layout === 'side' ? 'overlay' : 'side by side'}
        </button>
      </div>
    </div>
  );
}
