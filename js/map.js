// MapLibre is loaded as a global script in index.html (avoids importmap requirement)
const maplibregl = window.maplibregl;

// Resolve style paths relative to this module file, not the page URL
const _BASE = new URL('..', import.meta.url).href;
const STYLE_URLS = {
  dark:      `${_BASE}assets/map-styles/dark.json`,
  light:     `${_BASE}assets/map-styles/light.json`,
  satellite: `${_BASE}assets/map-styles/satellite.json`,
};

const SOURCE_ID       = 'tracks';
const LAYER_ID        = 'tracks-line';
const HEADS_SOURCE_ID = 'track-heads';
const HEADS_LAYER_ID  = 'track-heads-circle';

let map = null;
let currentStyle = 'dark';
let trackLayerPaint = null;
let headsColor = '#FC4C02';

export function initMap(containerId, style = 'dark') {
  currentStyle = style;
  map = new maplibregl.Map({
    container: containerId,
    style: STYLE_URLS[style],
    center: [13.405, 52.52],
    zoom: 11,
    attributionControl: true,
    preserveDrawingBuffer: false,
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
  map.once('style.load', () => {
    if (trackLayerPaint) attachTrackLayer(trackLayerPaint);
  });
}

// ── Track line layer ──────────────────────────────────────────────────────────

export function attachTrackLayer(paint) {
  trackLayerPaint = paint;
  headsColor = paint['line-color'] || headsColor;

  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID, type: 'line', source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint,
    });
  }

  // Heads layer — always on top of tracks
  if (!map.getSource(HEADS_SOURCE_ID)) {
    map.addSource(HEADS_SOURCE_ID, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getLayer(HEADS_LAYER_ID)) {
    map.addLayer({
      id: HEADS_LAYER_ID, type: 'circle', source: HEADS_SOURCE_ID,
      paint: {
        'circle-radius':       7,
        'circle-color':        headsColor,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-opacity':      1,
      },
    });
  }
}

export function updateTrackData(linesGeoJSON, headsGeoJSON) {
  map?.getSource(SOURCE_ID)?.setData(linesGeoJSON);
  if (headsGeoJSON) map?.getSource(HEADS_SOURCE_ID)?.setData(headsGeoJSON);
}

export function clearTrackData() {
  map?.getSource(SOURCE_ID)?.setData(emptyCollection());
  map?.getSource(HEADS_SOURCE_ID)?.setData(emptyCollection());
}

export function updateTrackPaint(paint) {
  if (!map?.getLayer(LAYER_ID)) return;
  for (const [prop, value] of Object.entries(paint)) {
    map.setPaintProperty(LAYER_ID, prop, value);
  }
  trackLayerPaint = { ...trackLayerPaint, ...paint };

  // Keep heads dot colour in sync
  if (paint['line-color']) {
    headsColor = paint['line-color'];
    if (map.getLayer(HEADS_LAYER_ID)) {
      map.setPaintProperty(HEADS_LAYER_ID, 'circle-color', headsColor);
    }
  }
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

// ── Export support ────────────────────────────────────────────────────────────

export async function withPreservedBuffer(cb) {
  const center = map.getCenter();
  const zoom   = map.getZoom();
  const style  = currentStyle;

  map.remove();
  map = new maplibregl.Map({
    container: 'map', style: STYLE_URLS[style], center, zoom,
    preserveDrawingBuffer: true,
  });

  await new Promise(resolve => map.once('style.load', resolve));
  if (trackLayerPaint) attachTrackLayer(trackLayerPaint);

  try {
    await cb(map.getCanvas());
  } finally {
    map.remove();
    map = new maplibregl.Map({
      container: 'map', style: STYLE_URLS[style], center, zoom,
      preserveDrawingBuffer: false,
    });
    map.once('style.load', () => {
      if (trackLayerPaint) attachTrackLayer(trackLayerPaint);
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}
