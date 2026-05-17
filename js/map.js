// MapLibre is loaded as a global script in index.html (avoids importmap requirement)
const maplibregl = window.maplibregl;

// Resolve style paths relative to this module file, not the page URL
const _BASE = new URL('..', import.meta.url).href;
const STYLE_URLS = {
  dark:      `${_BASE}assets/map-styles/dark.json`,
  light:     `${_BASE}assets/map-styles/light.json`,
  satellite: `${_BASE}assets/map-styles/satellite.json`,
};

let map = null;
let currentStyle = 'dark';

export function initMap(containerId, style = 'dark') {
  currentStyle = style;
  map = new maplibregl.Map({
    container: containerId,
    style: STYLE_URLS[style],
    center: [13.405, 52.52],
    zoom: 11,
    attributionControl: true,
    preserveDrawingBuffer: true,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  return map;
}

export function getMap() { return map; }

// ── Style switching ───────────────────────────────────────────────────────────

export function setMapStyle(style) {
  if (!map || style === currentStyle) return;
  currentStyle = style;
  map.setStyle(STYLE_URLS[style]);
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function flyToCluster(cluster) {
  const { minLat, maxLat, minLng, maxLng } = cluster.bounds;
  map.fitBounds(
    [[minLng, minLat], [maxLng, maxLat]],
    { padding: 60, duration: 900, maxZoom: 15 }
  );
}

export function fitTrackBounds(bounds) {
  const { minLat, maxLat, minLng, maxLng } = bounds;
  map.fitBounds(
    [[minLng, minLat], [maxLng, maxLat]],
    { padding: 60, duration: 700, maxZoom: 15 }
  );
}
