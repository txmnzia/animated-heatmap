import { state } from './state.js';

let map = null, canvas = null, ctx = null;
let pixelCache   = null; // Float32Array [x0,y0, x1,y1, ...]
let trackOffsets = null; // Int32Array: start index per track
let trackLengths = null; // Int32Array: point count per track
let trackBBoxes  = null; // Float32Array: [minX,minY,maxX,maxY] per track
let cacheDirty   = true;

let _color = '#FC4C02', _thickness = 2, _opacity = 0.7, _glow = true;
const HEAD_RADIUS = 4;
const RENDER_INTERVAL = 1000 / 30; // 30fps cap
let lastRenderTime = -Infinity;

function upperBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function initOverlay(mapInstance) {
  map = mapInstance;
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
  map.getContainer().appendChild(canvas);
  ctx = canvas.getContext('2d');
  _resize();
  new ResizeObserver(_resize).observe(map.getContainer());
  map.on('move', () => { cacheDirty = true; });
  map.on('resize', _resize);
  // Repaint on map renders (handles panning while animation is paused)
  map.on('render', () => { if (state.anim.tracks.length) drawFrame(state.anim.currentTime); });
}

function _resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = map.getContainer().clientWidth;
  const h = map.getContainer().clientHeight;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  // Assigning canvas.width/height resets context transform — scale applied fresh below
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  cacheDirty = true;
}

function _buildCache() {
  cacheDirty = false;
  const tracks = state.anim.tracks;
  if (!tracks.length || !map) { pixelCache = null; return; }
  let total = 0;
  for (const t of tracks) total += t.coords.length;
  pixelCache   = new Float32Array(total * 2);
  trackOffsets = new Int32Array(tracks.length);
  trackLengths = new Int32Array(tracks.length);
  trackBBoxes  = new Float32Array(tracks.length * 4);
  let offset = 0;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    trackOffsets[i] = offset;
    trackLengths[i] = track.coords.length;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const coord of track.coords) {
      const p = map.project(coord);
      pixelCache[offset * 2]     = p.x;
      pixelCache[offset * 2 + 1] = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      offset++;
    }
    trackBBoxes[i * 4]     = minX;
    trackBBoxes[i * 4 + 1] = minY;
    trackBBoxes[i * 4 + 2] = maxX;
    trackBBoxes[i * 4 + 3] = maxY;
  }
}

export function setOverlayStyle({ color, thickness, opacity, glow }) {
  _color = color;
  _thickness = thickness;
  _opacity = opacity;
  _glow = glow;
}

export function drawFrame(trackTimeSec) {
  if (!ctx || !map) return;
  const now = performance.now();
  if (now - lastRenderTime < RENDER_INTERVAL) return;
  lastRenderTime = now;
  if (cacheDirty || !pixelCache) _buildCache();
  if (!pixelCache) return;
  _paint(trackTimeSec);
}

export function forceFrame(trackTimeSec) {
  lastRenderTime = -Infinity;
  if (cacheDirty || !pixelCache) _buildCache();
  if (pixelCache) _paint(trackTimeSec);
}

function _paint(trackTimeSec) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const tracks = state.anim.tracks;
  if (!tracks.length) return;

  ctx.globalAlpha = _opacity;
  ctx.strokeStyle = _color;
  ctx.lineWidth   = _thickness;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  if (_glow) { ctx.shadowColor = _color; ctx.shadowBlur = _thickness * 4; }
  else ctx.shadowBlur = 0;

  const tipXY = [];
  ctx.beginPath();
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const idx = upperBound(track.times, trackTimeSec);
    if (idx < 2) continue;

    // Cull tracks whose full bounding box is off-screen
    const bx0 = trackBBoxes[i * 4], by0 = trackBBoxes[i * 4 + 1];
    const bx1 = trackBBoxes[i * 4 + 2], by1 = trackBBoxes[i * 4 + 3];
    if (bx1 < 0 || bx0 > w || by1 < 0 || by0 > h) continue;

    const base = trackOffsets[i];
    let tipX, tipY;
    if (idx < track.coords.length) {
      const t0 = track.times[idx - 1], t1 = track.times[idx];
      const frac = t1 > t0 ? (trackTimeSec - t0) / (t1 - t0) : 0;
      tipX = pixelCache[(base + idx - 1) * 2]     + (pixelCache[(base + idx) * 2]     - pixelCache[(base + idx - 1) * 2])     * frac;
      tipY = pixelCache[(base + idx - 1) * 2 + 1] + (pixelCache[(base + idx) * 2 + 1] - pixelCache[(base + idx - 1) * 2 + 1]) * frac;
    } else {
      tipX = pixelCache[(base + idx - 1) * 2];
      tipY = pixelCache[(base + idx - 1) * 2 + 1];
    }

    ctx.moveTo(pixelCache[base * 2], pixelCache[base * 2 + 1]);
    for (let j = 1; j < idx; j++) {
      ctx.lineTo(pixelCache[(base + j) * 2], pixelCache[(base + j) * 2 + 1]);
    }
    ctx.lineTo(tipX, tipY);
    tipXY.push(tipX, tipY);
  }
  ctx.stroke();

  // Heads — fully opaque dots with a small blur halo, drawn in one batched fill
  ctx.shadowBlur  = HEAD_RADIUS * 0.5;
  ctx.shadowColor = _color;
  ctx.globalAlpha = 1;
  ctx.fillStyle   = _color;
  ctx.beginPath();
  for (let i = 0; i < tipXY.length; i += 2) {
    ctx.moveTo(tipXY[i] + HEAD_RADIUS, tipXY[i + 1]);
    ctx.arc(tipXY[i], tipXY[i + 1], HEAD_RADIUS, 0, Math.PI * 2);
  }
  ctx.fill();
}

export function clearOverlay() {
  if (!ctx || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  pixelCache = trackOffsets = trackLengths = trackBBoxes = null;
  cacheDirty = true;
}

export function getOverlayCanvas() { return canvas; }
