import { useEffect, useRef, useState } from 'react';

// In-app camera. Frames go sensor → canvas → encryption; video goes
// MediaRecorder → encryption. Nothing is ever written to the phone's gallery.
export function CameraCapture(props: {
  onCapture: (file: File) => Promise<void>;
  onCaptureVideo?: (video: File, poster: File, durationS: number) => Promise<void>;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStart = useRef(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [timer, setTimer] = useState<0 | 3 | 10>(0);
  const [count, setCount] = useState<number | null>(null);
  const [grid, setGrid] = useState(false);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 } },
          audio: mode === 'video',
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch {
        setError('Camera unavailable. Check permissions and try again.');
      }
    })();
    return () => {
      cancelled = true;
      recorderRef.current?.state === 'recording' && recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, mode]);

  function grabFrame(): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
    const video = videoRef.current!;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve({ blob: b, canvas }) : reject(new Error('capture failed'))),
        'image/jpeg',
        0.92
      )
    );
  }

  async function countdown() {
    if (timer === 0) return;
    for (let n = timer; n > 0; n--) {
      setCount(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCount(null);
  }

  async function shutterPhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    setBusy(true);
    try {
      await countdown();
      const { blob } = await grabFrame();
      await props.onCapture(new File([blob], 'capture.jpg', { type: 'image/jpeg' }));
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'capture failed');
      setBusy(false);
    }
  }

  async function toggleRecord() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video || video.videoWidth === 0 || !props.onCaptureVideo) return;
    setBusy(true);
    try {
      await countdown();
      const { blob: posterBlob } = await grabFrame();
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const parts: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
      recorder.onstop = async () => {
        setRecording(false);
        const durationS = Math.round((Date.now() - recordStart.current) / 1000);
        try {
          await props.onCaptureVideo!(
            new File(parts, 'clip.webm', { type: 'video/webm' }),
            new File([posterBlob], 'poster.jpg', { type: 'image/jpeg' }),
            durationS
          );
          props.onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'upload failed');
          setBusy(false);
        }
      };
      recordStart.current = Date.now();
      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording(true);
      setBusy(false);
      setTimeout(() => recorder.state === 'recording' && recorder.stop(), 60_000); // 60s cap
    } catch (err) {
      setError(err instanceof Error ? err.message : 'recording failed');
      setBusy(false);
    }
  }

  return (
    <div className="camera-modal">
      {error ? (
        <p className="error camera-error">{error}</p>
      ) : (
        <div className="camera-stage">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={facing === 'user' ? 'camera-feed mirrored' : 'camera-feed'}
          />
          {grid && <div className="camera-grid" aria-hidden="true" />}
          {count !== null && <div className="countdown">{count}</div>}
          {recording && <div className="rec-dot" aria-label="Recording">● REC</div>}
        </div>
      )}
      <div className="camera-options">
        <button className="link" onClick={() => setTimer(timer === 0 ? 3 : timer === 3 ? 10 : 0)}>
          timer {timer === 0 ? 'off' : `${timer}s`}
        </button>
        <button className="link" onClick={() => setGrid(!grid)}>grid {grid ? 'on' : 'off'}</button>
        {props.onCaptureVideo && (
          <button
            className="link"
            onClick={() => !recording && setMode(mode === 'photo' ? 'video' : 'photo')}
          >
            mode: {mode}
          </button>
        )}
      </div>
      <div className="camera-bar">
        <button className="link" onClick={props.onClose} disabled={recording}>close</button>
        <button
          className={recording ? 'shutter recording' : 'shutter'}
          onClick={mode === 'photo' ? shutterPhoto : toggleRecord}
          disabled={busy || !!error}
          aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Record'}
        />
        <button className="link" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')} disabled={recording}>
          flip
        </button>
      </div>
    </div>
  );
}
