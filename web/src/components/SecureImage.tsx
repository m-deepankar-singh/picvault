import { useEffect, useRef } from 'react';

// Deterrence-rendered image: decrypted bytes go straight onto a canvas (no
// <img>, no URL to long-press-save), tiled with a watermark identifying the
// viewer so any leaked screenshot identifies the leaker. This deters casual
// saving — it cannot and does not claim to prevent OS screenshots.
export function SecureImage(props: {
  bytes: Uint8Array | null;
  watermark: string;
  className?: string;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !props.bytes) return;
    let cancelled = false;
    (async () => {
      const buf = props.bytes!.slice().buffer as ArrayBuffer;
      const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
      if (cancelled) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      // tiled diagonal watermark
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(14, canvas.width / 40)}px system-ui, sans-serif`;
      ctx.rotate(-Math.PI / 6);
      const step = Math.max(160, canvas.width / 5);
      for (let y = -canvas.width; y < canvas.height * 2; y += step / 2) {
        for (let x = -canvas.height; x < canvas.width * 2; x += step * 1.5) {
          ctx.fillText(props.watermark, x, y);
        }
      }
      ctx.restore();
      canvas.classList.add('developed');
    })();
    return () => {
      cancelled = true;
    };
  }, [props.bytes, props.watermark]);

  return (
    <canvas
      ref={ref}
      className={`secure-img ${props.className ?? ''}`}
      onClick={props.onClick}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    />
  );
}
