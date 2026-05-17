import { getMap } from './map.js';
import { getOverlayCanvas, clearOverlay } from './overlay.js';
import { play, stop, restart } from './animation.js';
import { state } from './state.js';

// Records the animation by compositing the MapLibre GL canvas + overlay canvas
// onto a hidden composite canvas, then capturing that stream via MediaRecorder.
// preserveDrawingBuffer: true on the map means the GL canvas is always readable.
export async function recordAnimation(format, onProgress) {
  const mimeType = pickMimeType(format);
  if (!mimeType) {
    throw new Error('Video recording is not supported in this browser. Please use Chrome or Firefox.');
  }

  const mapCanvas     = getMap().getCanvas();
  const overlayCanvas = getOverlayCanvas();

  const composite = document.createElement('canvas');
  composite.width  = mapCanvas.width;
  composite.height = mapCanvas.height;
  const cctx = composite.getContext('2d');

  let rafHandle = null;
  function compositeFrame() {
    cctx.clearRect(0, 0, composite.width, composite.height);
    cctx.drawImage(mapCanvas, 0, 0);
    // Overlay canvas uses the same physical pixel dimensions as the map canvas
    cctx.drawImage(overlayCanvas, 0, 0);
    rafHandle = requestAnimationFrame(compositeFrame);
  }

  return new Promise((resolve, reject) => {
    const stream   = composite.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });

    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onerror = e => reject(e.error || new Error('Recording failed'));
    recorder.onstop  = () => {
      cancelAnimationFrame(rafHandle);
      resolve(new Blob(chunks, { type: mimeType }));
    };

    clearOverlay();
    recorder.start(500);
    rafHandle = requestAnimationFrame(compositeFrame);

    restart((currentTime, maxTime) => {
      if (onProgress) onProgress(maxTime > 0 ? currentTime / maxTime : 0);
      if (currentTime >= maxTime) {
        recorder.stop();
        stop();
      }
    });
  });
}

export function triggerDownload(blob, format) {
  const ext  = format === 'mp4' ? 'mp4' : 'webm';
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `strava-heatmap.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function pickMimeType(format) {
  const candidates = format === 'mp4'
    ? ['video/mp4;codecs=avc1', 'video/mp4']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}
