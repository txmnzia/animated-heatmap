import { state } from './state.js';
import { updateTrackData, clearTrackData } from './map.js';

// Ramer-Douglas-Peucker simplification — keeps geometry accurate while
// reducing point count for performance.
function rdp(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const denom = Math.hypot(bx - ax, by - ay) || 1e-9;

  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / denom;
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left  = rdp(points.slice(0, maxIdx + 1), epsilon);
    const right = rdp(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

// Binary search: index of last element where arr[i] <= target
function upperBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Track preparation ─────────────────────────────────────────────────────────

// Convert raw streams into simplified track objects ready for rendering.
// Runs once when the user clicks Generate.
export function prepareAnimation(activityIds, streamsMap) {
  const tracks = [];
  let maxTime = 0;

  for (const id of activityIds) {
    const s = streamsMap.get(id);
    if (!s?.latlng?.length) continue;

    // RDP epsilon: ~5m in degree space (rough, good enough for screen display)
    const simplified = rdp(s.latlng, 0.00005);

    // Re-sample time array to match simplified point indices
    const ratio = s.latlng.length / simplified.length;
    const times = simplified.map((_, i) => s.time[Math.min(Math.round(i * ratio), s.time.length - 1)]);

    const duration = times[times.length - 1] || 0;
    if (duration > maxTime) maxTime = duration;

    tracks.push({
      // MapLibre GeoJSON uses [lng, lat]
      coords: simplified.map(([lat, lng]) => [lng, lat]),
      times,
      duration,
    });
  }

  state.anim.tracks = tracks;
  state.anim.maxTime = maxTime;
  state.anim.currentTime = 0;
  state.anim.playbackRate = 120; // fixed: 1h of activity = 30s of animation

  return { trackCount: tracks.length, maxTime };
}

// ── Frame rendering ───────────────────────────────────────────────────────────

function computeFrame(trackTimeSec) {
  const features = [];

  for (const track of state.anim.tracks) {
    const idx = upperBound(track.times, trackTimeSec);
    if (idx < 2) continue;

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: track.coords.slice(0, idx),
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

// ── Playback controls ─────────────────────────────────────────────────────────

export function play(onTick) {
  if (state.anim.playing) return;
  state.anim.playing = true;

  let prevWall = performance.now();

  function tick(wallTime) {
    const delta = wallTime - prevWall;
    prevWall = wallTime;

    if (!state.anim.playing) return;

    state.anim.currentTime += (delta / 1000) * state.anim.playbackRate;

    if (state.anim.currentTime >= state.anim.maxTime) {
      state.anim.currentTime = state.anim.maxTime;
      updateTrackData(computeFrame(state.anim.currentTime));
      if (onTick) onTick(state.anim.currentTime, state.anim.maxTime, false);
      stop();
      return;
    }

    updateTrackData(computeFrame(state.anim.currentTime));
    if (onTick) onTick(state.anim.currentTime, state.anim.maxTime, true);
    state.anim.rafHandle = requestAnimationFrame(tick);
  }

  state.anim.rafHandle = requestAnimationFrame(tick);
}

export function pause() {
  state.anim.playing = false;
  if (state.anim.rafHandle) {
    cancelAnimationFrame(state.anim.rafHandle);
    state.anim.rafHandle = null;
  }
}

export function stop() {
  pause();
}

export function restart(onTick) {
  stop();
  state.anim.currentTime = 0;
  clearTrackData();
  play(onTick);
}

export function seekTo(fraction, onTick) {
  const t = fraction * state.anim.maxTime;
  state.anim.currentTime = t;
  updateTrackData(computeFrame(t));
  if (onTick) onTick(t, state.anim.maxTime, state.anim.playing);
}

export function jumpToEnd() {
  state.anim.currentTime = state.anim.maxTime;
  updateTrackData(computeFrame(state.anim.maxTime));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatTrackTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function getPlaybackProgress() {
  if (!state.anim.maxTime) return 0;
  return state.anim.currentTime / state.anim.maxTime;
}
