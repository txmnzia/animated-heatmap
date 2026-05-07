import { withPreservedBuffer, clearTrackData } from './map.js';
import { play, stop, restart } from './animation.js';
import { state } from './state.js';

// Records the animation playing in real time using the MediaRecorder API.
// onProgress(fraction 0–1) called each animation tick; resolves with a Blob.
export async function recordAnimation(format, onProgress) {
  const mimeType = pickMimeType(format);
  if (!mimeType) {
    throw new Error('Video recording is not supported in this browser. Please use Chrome or Firefox.');
  }

  return withPreservedBuffer(async (canvas) => {
    return new Promise((resolve, reject) => {
      const stream   = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
      });

      const chunks = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onerror = e => reject(e.error || new Error('Recording failed'));
      recorder.onstop  = () => resolve(new Blob(chunks, { type: mimeType }));

      clearTrackData();
      recorder.start(500);

      // Play animation; resolve when it reaches the end
      restart((currentTime, maxTime) => {
        if (onProgress) onProgress(maxTime > 0 ? currentTime / maxTime : 0);
        if (currentTime >= maxTime) {
          recorder.stop();
          stop();
        }
      });
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
