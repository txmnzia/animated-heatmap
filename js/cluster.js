// Generates location cluster tiles from activity start points.
// Two scales: neighborhood (~1km) and city (~30km).
// Clusters are NON-EXCLUSIVE: each activity appears in every cluster that
// geographically contains its start point.

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

// Grid resolutions: degrees of lat/lng per cell
const TIGHT_RES = 0.009;  // ~1km
const BROAD_RES = 0.27;   // ~30km

// Minimum activity count to promote a grid cell into a tile
const TIGHT_MIN = 3;
const BROAD_MIN = 5;

// ── Public API ────────────────────────────────────────────────────────────────

export async function computeClusters(activities) {
  const withGPS = activities.filter(a => a.start_latlng?.length === 2);
  if (!withGPS.length) return [];

  const tightCells = buildGrid(withGPS, TIGHT_RES);
  const broadCells = buildGrid(withGPS, BROAD_RES);

  const tightClusters = cellsToClusters(tightCells, TIGHT_MIN, 'neighborhood', TIGHT_RES, withGPS);
  const broadClusters = cellsToClusters(broadCells, BROAD_MIN, 'city', BROAD_RES, withGPS);

  // Merge: deduplicate cells that resolve to the same place name
  const all = [...tightClusters, ...broadClusters];

  // Sort by activity count descending
  all.sort((a, b) => b.count - a.count);

  // Geocode in small batches (Nominatim rate limit: 1 req/sec)
  await geocodeClusters(all);

  // After geocoding, deduplicate by name+type
  return deduplicateByName(all);
}

// Render activity start points onto a canvas element for the tile minimap
export function renderTileCanvas(canvas, cluster, color) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = '#18181e';
  ctx.fillRect(0, 0, W, H);

  const { minLat, maxLat, minLng, maxLng } = cluster.bounds;
  const latRange = maxLat - minLat || 0.001;
  const lngRange = maxLng - minLng || 0.001;

  // 10% padding so dots don't sit on canvas edges
  const pad = 0.10;

  const dotColor = hexToRgba(color, 0.7);
  const glowColor = hexToRgba(color, 0.25);

  for (const act of cluster.activities) {
    const [lat, lng] = act.start_latlng;
    const x = W * ((lng - minLng) / lngRange * (1 - 2*pad) + pad);
    const y = H * (1 - ((lat - minLat) / latRange * (1 - 2*pad) + pad));

    // Glow
    ctx.fillStyle = glowColor;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Core dot
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Grid building ─────────────────────────────────────────────────────────────

function buildGrid(activities, res) {
  const grid = new Map();
  for (const act of activities) {
    const [lat, lng] = act.start_latlng;
    const row = Math.round(lat / res) * res;
    const col = Math.round(lng / res) * res;
    const key = `${row.toFixed(6)},${col.toFixed(6)}`;
    if (!grid.has(key)) grid.set(key, { centerLat: row, centerLng: col, acts: [] });
    grid.get(key).acts.push(act);
  }
  return grid;
}

function cellsToClusters(grid, minCount, type, res, allActivities) {
  const half = res * 0.6; // slight expansion so border activities are captured
  const clusters = [];

  for (const [, cell] of grid) {
    if (cell.acts.length < minCount) continue;

    const bounds = {
      minLat: cell.centerLat - half,
      maxLat: cell.centerLat + half,
      minLng: cell.centerLng - half,
      maxLng: cell.centerLng + half,
    };

    // Non-exclusive: all activities whose start falls within bounds
    const matchingActs = allActivities.filter(a => {
      const [lat, lng] = a.start_latlng;
      return lat >= bounds.minLat && lat <= bounds.maxLat &&
             lng >= bounds.minLng && lng <= bounds.maxLng;
    });

    if (matchingActs.length < minCount) continue;

    // Compute tight actual bounds of matching activities
    const actualBounds = activityBounds(matchingActs);

    clusters.push({
      id: `${type}-${cell.centerLat.toFixed(4)}-${cell.centerLng.toFixed(4)}`,
      type,
      center: [cell.centerLat, cell.centerLng],
      bounds: expandBounds(actualBounds, 0.15), // 15% padding for map flyTo
      activities: matchingActs,
      count: matchingActs.length,
      name: null, // filled by geocoder
    });
  }

  return clusters;
}

// ── Bounds helpers ────────────────────────────────────────────────────────────

function activityBounds(activities) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const a of activities) {
    const [lat, lng] = a.start_latlng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function expandBounds(b, factor) {
  const dLat = (b.maxLat - b.minLat) * factor;
  const dLng = (b.maxLng - b.minLng) * factor;
  const minSize = 0.003; // at least ~300m on each side
  return {
    minLat: b.minLat - Math.max(dLat, minSize),
    maxLat: b.maxLat + Math.max(dLat, minSize),
    minLng: b.minLng - Math.max(dLng, minSize),
    maxLng: b.maxLng + Math.max(dLng, minSize),
  };
}

// ── Reverse geocoding ─────────────────────────────────────────────────────────

// Persist geocode results so we never hit Nominatim twice for the same cluster
const GEO_CACHE_KEY = 'strava_geocode_cache';
function loadGeocodeCache() {
  try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveGeocodeCache(cache) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

async function geocodeClusters(clusters) {
  const cache = loadGeocodeCache();
  let didFetch = false;

  for (const cluster of clusters) {
    if (cache[cluster.id]) {
      cluster.name = cache[cluster.id];
      continue;
    }
    try {
      cluster.name = await reverseGeocode(cluster.center[0], cluster.center[1], cluster.type);
      cache[cluster.id] = cluster.name;
      saveGeocodeCache(cache);
      // Nominatim policy: max 1 req/sec — only delay when we actually fetched
      if (didFetch) await sleep(1100);
      didFetch = true;
    } catch {
      cluster.name = coordLabel(cluster.center[0], cluster.center[1]);
    }
  }
}

async function reverseGeocode(lat, lng, type) {
  const zoom = type === 'neighborhood' ? 16 : 10;
  const url  = `${NOMINATIM}?lat=${lat}&lon=${lng}&zoom=${zoom}&format=jsonv2&accept-language=en`;
  const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('Nominatim error');
  const data = await res.json();
  return extractPlaceName(data, type);
}

function extractPlaceName(data, type) {
  const addr = data.address || {};
  if (type === 'neighborhood') {
    return addr.road || addr.neighbourhood || addr.suburb || addr.city_district ||
           addr.city || addr.town || addr.village || data.display_name?.split(',')[0] || 'Unknown';
  }
  return addr.city || addr.town || addr.village || addr.county ||
         addr.state || data.display_name?.split(',')[0] || 'Unknown';
}

function coordLabel(lat, lng) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateByName(clusters) {
  const seen = new Map();
  const result = [];
  for (const c of clusters) {
    const key = `${c.name}|${c.type}`;
    if (seen.has(key)) {
      // Keep the one with higher count
      const existing = seen.get(key);
      if (c.count > existing.count) {
        const idx = result.indexOf(existing);
        result.splice(idx, 1, c);
        seen.set(key, c);
      }
    } else {
      seen.set(key, c);
      result.push(c);
    }
  }
  return result;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
