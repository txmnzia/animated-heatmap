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
  state.anim.playbackRate = 30; // 1h of activity = 2min of animation

  return { trackCount: tracks.length, maxTime };
}

// ── Frame rendering ───────────────────────────────────────────────────────────

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function computeFrame(trackTimeSec) {
  const lines = [];
  const heads = [];

  for (const track of state.anim.tracks) {
    const idx = upperBound(track.times, trackTimeSec);
    if (idx < 2) continue;

    // Interpolate fractionally between the last committed point and the next
    // so the head (and line tip) moves smoothly rather than snapping.
    let tip;
    if (idx < track.coords.length) {
      const t0 = track.times[idx - 1];
      const t1 = track.times[idx];
      const frac = t1 > t0 ? (trackTimeSec - t0) / (t1 - t0) : 0;
      tip = lerp(track.coords[idx - 1], track.coords[idx], frac);
    } else {
      tip = track.coords[idx - 1];
    }

    lines.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [...track.coords.slice(0, idx), tip] },
    });

    heads.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: tip },
    });
  }

  return {
    lines: { type: 'FeatureCollection', features: lines },
    heads: { type: 'FeatureCollection', features: heads },
  };
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
      const { lines, heads } = computeFrame(state.anim.currentTime);
      updateTrackData(lines, heads);
      if (onTick) onTick(state.anim.currentTime, state.anim.maxTime, false);
      stop();
      return;
    }

    const { lines, heads } = computeFrame(state.anim.currentTime);
    updateTrackData(lines, heads);
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
  const { lines, heads } = computeFrame(t);
  updateTrackData(lines, heads);
  if (onTick) onTick(t, state.anim.maxTime, state.anim.playing);
}

export function jumpToEnd() {
  state.anim.currentTime = state.anim.maxTime;
  const { lines, heads } = computeFrame(state.anim.maxTime);
  updateTrackData(lines, heads);
}

export function getTrackBounds() {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const track of state.anim.tracks) {
    for (const [lng, lat] of track.coords) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  return { minLat, maxLat, minLng, maxLng };
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
