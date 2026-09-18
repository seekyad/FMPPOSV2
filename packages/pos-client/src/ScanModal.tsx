import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@fmp/ui';

/** Minimal typing for the Shape Detection API (Chrome / Android); Safari falls back to ZXing. */
interface NativeDetector {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
}
type NativeDetectorCtor = (new (opts: { formats: string[] }) => NativeDetector) & {
  getSupportedFormats?: () => Promise<string[]>;
};

const NATIVE_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];

function cameraError(e: unknown): string {
  if (!window.isSecureContext) return 'The camera only works over HTTPS (or on localhost).';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot open the camera.';
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this site in the browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is in use by another app.';
  return e instanceof Error && e.message ? e.message : 'The camera could not be started.';
}

/**
 * Barcode scanner sheet. Uses the browser's native BarcodeDetector when
 * present, otherwise the ZXing decoder (loaded on demand so the main bundle
 * stays light). Reads 1D retail/IMEI codes plus QR and DataMatrix.
 */
export function ScanModal({
  open,
  title = 'Scan barcode',
  hint = 'Point the camera at the IMEI, serial or SKU barcode.',
  onScan,
  onClose,
}: {
  open: boolean;
  title?: string;
  hint?: string;
  onScan: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [error, setError] = useState('');
  const [engine, setEngine] = useState<'native' | 'zxing' | ''>('');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraIndex, setCameraIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopZxing: (() => void) | undefined;
    setError('');
    setEngine('');

    const cleanup = () => {
      if (timer) clearInterval(timer);
      stopZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    const finish = (text: string) => {
      if (cancelled) return;
      cancelled = true;
      try {
        navigator.vibrate?.(60);
      } catch {
        /* not supported */
      }
      cleanup();
      onScanRef.current(text);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        const chosen = cameras[cameraIndex];
        const video: MediaTrackConstraints = chosen
          ? { deviceId: { exact: chosen.deviceId } }
          : { facingMode: { ideal: 'environment' } };
        stream = await navigator.mediaDevices.getUserMedia({
          video: { ...video, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (cameras.length === 0) {
          const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          if (!cancelled) setCameras(list);
        }
        const el = videoRef.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play().catch(() => undefined);

        const Native = (window as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
        if (Native) {
          const supported = Native.getSupportedFormats ? await Native.getSupportedFormats() : NATIVE_FORMATS;
          const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
          if (formats.length > 0) {
            const detector = new Native({ formats });
            setEngine('native');
            timer = setInterval(async () => {
              if (cancelled || el.readyState < 2) return;
              try {
                const found = await detector.detect(el);
                const hit = found.find((b) => b.rawValue?.trim());
                if (hit) finish(hit.rawValue.trim());
              } catch {
                /* frame not ready */
              }
            }, 150);
            return;
          }
        }

        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ]);
        if (cancelled) return;
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.ITF,
          BarcodeFormat.CODABAR,
          BarcodeFormat.QR_CODE,
          BarcodeFormat.DATA_MATRIX,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
        setEngine('zxing');
        const controls = await reader.decodeFromStream(stream, el, (result) => {
          const text = result?.getText()?.trim();
          if (text) finish(text);
        });
        stopZxing = () => controls.stop();
        if (cancelled) stopZxing();
      } catch (e) {
        if (!cancelled) setError(cameraError(e));
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
    // `cameras` is only read to pick a device; refreshing the list must not restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cameraIndex]);

  const corners = (['top left', 'top right', 'bottom left', 'bottom right'] as const).map((corner) => {
    const [v, h] = corner.split(' ') as ['top' | 'bottom', 'left' | 'right'];
    return (
      <span
        key={corner}
        style={{
          position: 'absolute',
          [v]: -2,
          [h]: -2,
          width: 28,
          height: 28,
          borderTop: v === 'top' ? '4px solid var(--orange)' : undefined,
          borderBottom: v === 'bottom' ? '4px solid var(--orange)' : undefined,
          borderLeft: h === 'left' ? '4px solid var(--orange)' : undefined,
          borderRight: h === 'right' ? '4px solid var(--orange)' : undefined,
          borderRadius: 6,
        }}
      />
    );
  });

  return (
    <Modal open={open} onClose={onClose} width={560} style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ margin: 0, font: '700 20.5px Inter, sans-serif' }}>{title}</h2>
        {cameras.length > 1 && !error && (
          <button
            type="button"
            onClick={() => setCameraIndex((i) => (i + 1) % cameras.length)}
            style={{
              padding: '8px 12px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: 'var(--card)',
              font: '600 13.5px Inter, sans-serif',
              color: 'var(--ink-2)',
            }}
          >
            <i className="bi bi-arrow-repeat" style={{ marginRight: 6 }} />
            Switch camera
          </button>
        )}
      </div>
      <div
        data-testid="scan-viewport"
        style={{
          position: 'relative',
          marginTop: 14,
          borderRadius: 16,
          overflow: 'hidden',
          background: '#0b1220',
          aspectRatio: '4 / 3',
          maxHeight: '60vh',
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: error ? 'none' : 'block' }}
        />
        {!error && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: '18% 12%',
              border: '2px solid rgba(255,255,255,0.35)',
              borderRadius: 14,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
            }}
          >
            {corners}
          </div>
        )}
        {error && (
          <div
            role="alert"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 28,
              textAlign: 'center',
              color: '#fff',
            }}
          >
            <i className="bi bi-camera-video-off" style={{ fontSize: 40, opacity: 0.8 }} />
            <div style={{ marginTop: 12, fontSize: 15.5, lineHeight: 1.4 }}>{error}</div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14 }}>
        <div style={{ fontSize: 14, color: 'var(--ink-3)' }}>
          {error ? 'Use the keypad or keyboard to type the code instead.' : hint}
          {engine === 'zxing' && !error && <span style={{ color: 'var(--ink-4)' }}> Hold steady while it decodes.</span>}
        </div>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
