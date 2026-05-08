import { state, loadPersistedState, persistSettings } from './state.js';
import { isAuthenticated, startOAuthFlow, extractOAuthCode, exchangeCode, disconnect } from './auth.js';
import { getAllActivities, getLatestActivityDate, getStream, getCachedStreamIds } from './cache.js';
import { fetchAllActivities, fetchStreams } from './api.js';
import { computeClusters, renderTileCanvas } from './cluster.js';
import { initMap, setMapStyle, attachTrackLayer, updateTrackPaint, flyToCluster, clearTrackData, fitTrackBounds } from './map.js';
import { prepareAnimation, play, pause, stop, restart, seekTo, jumpToEnd, formatTrackTime, getPlaybackProgress, getTrackBounds } from './animation.js';
import { recordAnimation, triggerDownload } from './export.js';

// ── Startup ───────────────────────────────────────────────────────────────────

loadPersistedState();
initMap('map', state.settings.mapStyle);

(async () => {
  // Handle OAuth redirect callback
  try {
    const code = extractOAuthCode();
    if (code) {
      showLoading('Connecting to Strava…');
      await exchangeCode(code);
      await runSync();
      return;
    }
  } catch (err) {
    showAuthModal();
    showAuthError(err.message);
    return;
  }

  if (isAuthenticated()) {
    await runSync();
  } else {
    showAuthModal();
  }
})();

// ── Sync flow ─────────────────────────────────────────────────────────────────

async function runSync() {
  showLoading('Loading your activities…');

  // 1. Load from cache first for instant start
  let cached = await getAllActivities();
  if (cached.length) {
    await buildClusters(cached);
  }

  // 2. Fetch new activities from Strava
  try {
    const afterDate = await getLatestActivityDate();
    const fresh = await fetchAllActivities({
      afterDate,
      onProgress: (fetched) => updateLoadingProgress(fetched, null, `Synced ${fetched} activities…`),
      onRateWait: (secs) => updateLoadingMsg(`Rate limited — resuming in ${secs}s…`),
    });

    // If we got new data, re-cluster
    if (fresh.length > 0 || !cached.length) {
      cached = await getAllActivities();
      await buildClusters(cached);
    }
  } catch (err) {
    if (!cached.length) {
      showLoading(`Sync failed: ${err.message}`);
      return;
    }
    // Non-fatal: we already have cached data shown
    console.warn('Sync error (showing cached data):', err);
  }

  hideLoading();
  showApp();
}

async function buildClusters(activities) {
  state.activities = activities;

  // Compute active types from all activities
  const types = [...new Set(activities.map(a => a.sport_type || a.type).filter(Boolean))];
  if (!state.activeTypes.size) types.forEach(t => state.activeTypes.add(t));

  buildFilterChips(types);

  updateLoadingMsg('Analysing your routes…');
  const clusters = await computeClusters(activities);
  state.clusters = clusters;

  renderTileRow();
}

// ── Cluster tiles ─────────────────────────────────────────────────────────────

function renderTileRow() {
  const scroll = document.getElementById('tiles-scroll');
  scroll.innerHTML = '';

  if (!state.clusters.length) {
    scroll.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:16px">No location clusters found.</p>';
    return;
  }

  for (const cluster of state.clusters) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.clusterId = cluster.id;

    const canvas = document.createElement('canvas');
    canvas.className = 'tile-canvas';
    canvas.width  = 340; // 2x for retina
    canvas.height = 176;

    const info = document.createElement('div');
    info.className = 'tile-info';

    const typeLabel = cluster.type === 'neighborhood' ? '📍' : '🌆';
    const typeNames = [...new Set(cluster.activities.map(a => a.sport_type || a.type))]
      .filter(Boolean)
      .sort()
      .slice(0, 3)
      .join(' · ');

    info.innerHTML = `
      <div class="tile-name">${typeLabel} ${cluster.name}</div>
      <div class="tile-meta">${cluster.count} activities · ${typeNames || 'Mixed'}</div>
    `;

    tile.appendChild(canvas);
    tile.appendChild(info);
    scroll.appendChild(tile);

    renderTileCanvas(canvas, cluster, state.settings.color);

    tile.addEventListener('click', () => selectCluster(cluster));
  }
}

function selectCluster(cluster) {
  state.selectedCluster = cluster;

  // Update tile selection UI
  document.querySelectorAll('.tile').forEach(t => t.classList.remove('selected'));
  const el = document.querySelector(`[data-cluster-id="${cluster.id}"]`);
  if (el) el.classList.add('selected');

  flyToCluster(cluster);
  updateActivityCount();
  document.getElementById('btn-generate').classList.remove('hidden');
}

// ── Filter chips ──────────────────────────────────────────────────────────────

function buildFilterChips(types) {
  const row = document.getElementById('filter-chips');
  row.innerHTML = '';
  for (const type of types) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.activeTypes.has(type) ? ' active' : '');
    chip.textContent = type;
    chip.dataset.type = type;
    chip.addEventListener('click', () => toggleType(type, chip));
    row.appendChild(chip);
  }
}

function toggleType(type, chip) {
  if (state.activeTypes.has(type)) {
    state.activeTypes.delete(type);
    chip.classList.remove('active');
  } else {
    state.activeTypes.add(type);
    chip.classList.add('active');
  }
  updateActivityCount();
  // If animation is showing, clear it — user must re-generate
  clearTrackData();
  stop();
  document.getElementById('btn-generate').classList.remove('hidden');
  document.getElementById('anim-bar').classList.add('hidden');
}

function getFilteredActivities() {
  if (!state.selectedCluster) return [];
  return state.selectedCluster.activities.filter(a =>
    state.activeTypes.has(a.sport_type || a.type)
  );
}

function updateActivityCount() {
  const count = getFilteredActivities().length;
  document.getElementById('activity-count').textContent =
    count > 0 ? `${count} activities` : 'No activities';
}

// ── Generate animation ────────────────────────────────────────────────────────

async function generate() {
  const activities = getFilteredActivities();
  if (!activities.length) return;

  // Stop any in-progress animation before starting a new one
  stop();
  clearTrackData();

  const ids = activities.map(a => a.id);

  try {
    const cachedIds = await getCachedStreamIds(ids);
    const missing = ids.filter(id => !cachedIds.has(id));

    if (missing.length) {
      showLoading(`Fetching GPS tracks…`);
      showLoadingProgress(0, missing.length);
      document.getElementById('btn-cancel-load').classList.remove('hidden');

      let cancelled = false;
      document.getElementById('btn-cancel-load').onclick = () => { cancelled = true; hideLoading(); };

      await fetchStreams(ids, cachedIds, {
        onProgress: (done, total) => {
          if (cancelled) throw new Error('cancelled');
          updateLoadingProgress(done, total, `GPS tracks: ${done} / ${total}`);
        },
        onRateWait: (secs) => updateLoadingMsg(`Rate limited — resuming in ${secs}s…`),
      });

      if (cancelled) return;
      hideLoading();
    }

    // Build streams map from cache
    const streamsMap = new Map();
    for (const id of ids) {
      const s = await getStream(id);
      if (s) streamsMap.set(id, s);
    }

    if (!streamsMap.size) {
      alert('No GPS data found. Make sure your activities have GPS tracks on Strava.');
      return;
    }

    const { trackCount } = prepareAnimation(ids, streamsMap);
    if (!trackCount) {
      alert('No GPS data found for the selected activities.');
      return;
    }

    // Zoom map to cover all tracks before animation starts
    fitTrackBounds(getTrackBounds());

    // Attach (or refresh) the MapLibre track layer
    attachTrackLayer(buildTrackPaint());

    // Show animation controls
    document.getElementById('btn-generate').classList.add('hidden');
    document.getElementById('anim-bar').classList.remove('hidden');
    document.getElementById('btn-export').removeAttribute('disabled');

    playAnimation();

  } catch (err) {
    if (err.message === 'cancelled') return;
    hideLoading();
    console.error('Generate failed:', err);
    alert(`Failed to generate animation: ${err.message}`);
  }
}

function playAnimation() {
  play(onAnimTick);
  document.getElementById('btn-playpause').textContent = '⏸';
}

function onAnimTick(currentTime, maxTime, stillPlaying) {
  document.getElementById('time-display').textContent = formatTrackTime(currentTime);
  const fraction = maxTime > 0 ? currentTime / maxTime : 0;
  document.getElementById('scrubber').value = Math.round(fraction * 1000);
  if (!stillPlaying) {
    document.getElementById('btn-playpause').textContent = '▶';
  }
}

// ── Track paint ───────────────────────────────────────────────────────────────

export function buildTrackPaint() {
  const { color, thickness, opacity, glow } = state.settings;
  const paint = {
    'line-color': color,
    'line-width': thickness,
    'line-opacity': opacity / 100,
  };
  if (glow) {
    paint['line-blur'] = thickness * 1.5;
  }
  return paint;
}

// ── Settings panel ────────────────────────────────────────────────────────────

function applySettingsToMap() {
  updateTrackPaint(buildTrackPaint());
}

function applyColorToTiles() {
  document.querySelectorAll('.tile-canvas').forEach((canvas, i) => {
    const cluster = state.clusters[i];
    if (cluster) renderTileCanvas(canvas, cluster, state.settings.color);
  });
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

// Auth modal
document.getElementById('input-client-id').addEventListener('input', validateAuthForm);
document.getElementById('input-client-secret').addEventListener('input', validateAuthForm);

document.querySelector('.show-toggle').addEventListener('click', function () {
  const inp = document.getElementById(this.dataset.target);
  const isText = inp.type === 'text';
  inp.type = isText ? 'password' : 'text';
  this.textContent = isText ? 'show' : 'hide';
});

document.getElementById('btn-connect').addEventListener('click', () => {
  const id  = document.getElementById('input-client-id').value.trim();
  const sec = document.getElementById('input-client-secret').value.trim();
  if (!id || !sec) return;
  state.auth.clientId     = id;
  state.auth.clientSecret = sec;
  localStorage.setItem('strava_client_id',     id);
  localStorage.setItem('strava_client_secret', sec);
  startOAuthFlow();
});

function validateAuthForm() {
  const ok = document.getElementById('input-client-id').value.trim() &&
             document.getElementById('input-client-secret').value.trim();
  document.getElementById('btn-connect').disabled = !ok;
}

// Disconnect
document.getElementById('btn-disconnect').addEventListener('click', () => {
  if (!confirm('Disconnect Strava and clear all cached data?')) return;
  disconnect();
  location.reload();
});

// Re-sync
document.getElementById('btn-resync').addEventListener('click', async () => {
  showLoading('Re-syncing activities…');
  try {
    const fresh = await fetchAllActivities({
      onProgress: (n) => updateLoadingMsg(`Synced ${n} activities…`),
      onRateWait: (s) => updateLoadingMsg(`Rate limited — resuming in ${s}s…`),
    });
    const all = await getAllActivities();
    await buildClusters(all);
    hideLoading();
  } catch (err) {
    hideLoading();
    alert(`Sync failed: ${err.message}`);
  }
});

// Settings button
document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
});

// Color picker
const colorInput = document.getElementById('input-color');
colorInput.addEventListener('input', () => {
  state.settings.color = colorInput.value;
  document.getElementById('color-hex').textContent = colorInput.value.toUpperCase();
  applySettingsToMap();
  applyColorToTiles();
  persistSettings();
});
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const c = btn.dataset.color;
    colorInput.value = c;
    state.settings.color = c;
    document.getElementById('color-hex').textContent = c.toUpperCase();
    applySettingsToMap();
    applyColorToTiles();
    persistSettings();
  });
});

// Map style
document.querySelectorAll('.style-btn').forEach(btn => {
  if (!btn.dataset.style) return;
  btn.addEventListener('click', () => {
    document.querySelectorAll('.style-btn[data-style]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.settings.mapStyle = btn.dataset.style;
    setMapStyle(btn.dataset.style);
    persistSettings();
  });
});

// Track sliders
document.getElementById('input-thickness').addEventListener('input', function () {
  state.settings.thickness = parseFloat(this.value);
  document.getElementById('val-thickness').textContent = this.value;
  applySettingsToMap();
  persistSettings();
});
document.getElementById('input-opacity').addEventListener('input', function () {
  state.settings.opacity = parseFloat(this.value);
  document.getElementById('val-opacity').textContent = this.value;
  applySettingsToMap();
  persistSettings();
});
document.getElementById('input-glow').addEventListener('change', function () {
  state.settings.glow = this.checked;
  applySettingsToMap();
  persistSettings();
});

// Re-render
document.getElementById('btn-rerender').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
  clearTrackData();
  stop();
  document.getElementById('btn-generate').classList.remove('hidden');
  document.getElementById('anim-bar').classList.add('hidden');
});

// Generate
document.getElementById('btn-generate').addEventListener('click', generate);

// Animation controls
document.getElementById('btn-restart').addEventListener('click', () => {
  clearTrackData();
  state.anim.currentTime = 0;
  playAnimation();
});
document.getElementById('btn-playpause').addEventListener('click', () => {
  if (state.anim.playing) {
    pause();
    document.getElementById('btn-playpause').textContent = '▶';
  } else {
    playAnimation();
  }
});
document.getElementById('btn-end').addEventListener('click', () => {
  jumpToEnd();
  onAnimTick(state.anim.maxTime, state.anim.maxTime, false);
});

let scrubbing = false;
const scrubber = document.getElementById('scrubber');
scrubber.addEventListener('mousedown', () => { scrubbing = true; pause(); });
scrubber.addEventListener('input', () => {
  seekTo(scrubber.value / 1000, (t, max) => {
    document.getElementById('time-display').textContent = formatTrackTime(t);
  });
});
scrubber.addEventListener('mouseup', () => {
  scrubbing = false;
  playAnimation();
});

// Export button
document.getElementById('btn-export').addEventListener('click', () => {
  document.getElementById('export-overlay').classList.remove('hidden');
  document.getElementById('export-idle').classList.remove('hidden');
  document.getElementById('export-recording').classList.add('hidden');
  document.getElementById('export-done').classList.add('hidden');
});
document.getElementById('btn-cancel-export').addEventListener('click', () => {
  document.getElementById('export-overlay').classList.add('hidden');
});
document.getElementById('btn-close-export').addEventListener('click', () => {
  document.getElementById('export-overlay').classList.add('hidden');
});

let exportFormat = 'webm';
document.querySelectorAll('.style-btn[data-format]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.style-btn[data-format]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    exportFormat = btn.dataset.format;
  });
});

document.getElementById('btn-start-export').addEventListener('click', async () => {
  document.getElementById('export-idle').classList.add('hidden');
  document.getElementById('export-recording').classList.remove('hidden');

  try {
    const blob = await recordAnimation(exportFormat, (fraction) => {
      document.getElementById('export-bar').style.width = `${Math.round(fraction * 100)}%`;
      document.getElementById('export-detail').textContent =
        `Recording… ${Math.round(fraction * 100)}%`;
    });

    document.getElementById('export-recording').classList.add('hidden');
    document.getElementById('export-done').classList.remove('hidden');

    const link = document.getElementById('export-download');
    link.href = URL.createObjectURL(blob);
    link.download = `strava-heatmap.${exportFormat === 'mp4' ? 'mp4' : 'webm'}`;
  } catch (err) {
    document.getElementById('export-recording').classList.add('hidden');
    document.getElementById('export-idle').classList.remove('hidden');
    alert(`Export failed: ${err.message}`);
  }
});

document.getElementById('btn-abort-export').addEventListener('click', () => {
  document.getElementById('export-overlay').classList.add('hidden');
  stop();
});

// ── Loading helpers ───────────────────────────────────────────────────────────

function showLoading(msg) {
  document.getElementById('loading-overlay').classList.remove('hidden');
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-progress-wrap').classList.add('hidden');
  document.getElementById('btn-cancel-load').classList.add('hidden');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}
function updateLoadingMsg(msg) {
  document.getElementById('loading-msg').textContent = msg;
}
function showLoadingProgress(done, total) {
  const wrap = document.getElementById('loading-progress-wrap');
  wrap.classList.remove('hidden');
  updateLoadingProgress(done, total, '');
}
function updateLoadingProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById('loading-bar').style.width  = `${pct}%`;
  document.getElementById('loading-detail').textContent = label;
}

// ── Visibility helpers ────────────────────────────────────────────────────────

function showAuthModal() {
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loading-overlay').classList.add('hidden');
}
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function showApp() {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('loading-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Sync settings panel UI to persisted state
  syncSettingsUI();
}

function syncSettingsUI() {
  const s = state.settings;
  document.getElementById('input-color').value     = s.color;
  document.getElementById('color-hex').textContent = s.color.toUpperCase();
  document.getElementById('input-thickness').value = s.thickness;
  document.getElementById('val-thickness').textContent = s.thickness;
  document.getElementById('input-opacity').value   = s.opacity;
  document.getElementById('val-opacity').textContent = s.opacity;
  document.getElementById('input-glow').checked    = s.glow;

  document.querySelectorAll('.style-btn[data-style]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.style === s.mapStyle);
  });
}
