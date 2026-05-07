import maplibregl from 'maplibre-gl';

// Resolve style paths relative to this module file, not the page URL
const _BASE = new URL('..', import.meta.url).href;
const STYLE_URLS = {
  dark:      `${_BASE}assets/map-styles/dark.json`,
  light:     `${_BASE}assets/map-styles/light.json`,
  satellite: `${_BASE}assets/map-styles/satellite.json`,
};

const SOURCE_ID = 'tracks';
const LAYER_ID  = 'tracks-line';

let map = null;
let currentStyle = 'dark';
let trackLayerPaint = null; // last used paint props for re-attaching after style switch

export function initMap(containerId, style = 'dark') {
  currentStyle = style;
  map = new maplibregl.Map({
    container: containerId,
    style: STYLE_URLS[style],
    center: [13.405, 52.52], // Berlin as default — overridden when cluster selected
    zoom: 11,
    attributionControl: true,
    preserveDrawingBuffer: false, // set true only during export
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
  // Re-attach track layer after the new style loads
  map.once('style.load', () => {
    if (trackLayerPaint) attachTrackLayer(trackLayerPaint);
  });
}

// ── Track layers ──────────────────────────────────────────────────────────────

export function attachTrackLayer(paint) {
  trackLayerPaint = paint;
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: emptyCollection(),
    });
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id:     LAYER_ID,
      type:   'line',
      source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint,
    });
  }
}

export function updateTrackData(geojson) {
  const src = map?.getSource(SOURCE_ID);
  if (src) src.setData(geojson);
}

export function clearTrackData() {
  const src = map?.getSource(SOURCE_ID);
  if (src) src.setData(emptyCollection());
}

export function updateTrackPaint(paint) {
  if (!map?.getLayer(LAYER_ID)) return;
  for (const [prop, value] of Object.entries(paint)) {
    map.setPaintProperty(LAYER_ID, prop, value);
  }
  trackLayerPaint = { ...trackLayerPaint, ...paint };
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function flyToCluster(cluster) {
  const { minLat, maxLat, minLng, maxLng } = cluster.bounds;
  map.fitBounds(
    [[minLng, minLat], [maxLng, maxLat]],
    { padding: 40, duration: 900, maxZoom: 17 }
  );
}

// ── Export support ────────────────────────────────────────────────────────────

// Recreate the map with preserveDrawingBuffer for canvas capture, then restore
export async function withPreservedBuffer(cb) {
  const center = map.getCenter();
  const zoom   = map.getZoom();
  const style  = currentStyle;

  // Destroy current map
  map.remove();

  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_URLS[style],
    center,
    zoom,
    preserveDrawingBuffer: true,
  });

  await new Promise(resolve => map.once('style.load', resolve));
  if (trackLayerPaint) attachTrackLayer(trackLayerPaint);

  try {
    await cb(map.getCanvas());
  } finally {
    // Restore without preserveDrawingBuffer
    map.remove();
    map = new maplibregl.Map({
      container: 'map',
      style: STYLE_URLS[style],
      center,
      zoom,
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
