// Central mutable state for the app.
// Loaded once at startup; auth and settings are persisted to localStorage.

export const state = {
  auth: {
    clientId: null,
    clientSecret: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
  },

  // All activity summaries fetched from Strava (includes start_latlng, type, name, etc.)
  activities: [],

  // Cluster objects generated from activity start points
  clusters: [],

  // The tile the user has clicked
  selectedCluster: null,

  // Set of Strava activity types the user has toggled on
  activeTypes: new Set(),

  // Visual + animation settings
  settings: {
    color: '#FC4C02',
    mapStyle: 'dark',
    thickness: 2,
    opacity: 0.6,
    glow: true,
    speed: 60,   // wall-clock seconds for one full animation loop
  },

  // Animation runtime — never persisted
  anim: {
    playing: false,
    currentTime: 0,    // current position in track-time (seconds)
    maxTime: 0,        // longest track duration (seconds)
    rafHandle: null,
    startWallTime: null,
    playbackRate: 1,   // track-seconds per wall-second
    tracks: [],        // prepared TrackData objects for rendering
  },
};

export function loadPersistedState() {
  state.auth.clientId     = localStorage.getItem('strava_client_id') || null;
  state.auth.clientSecret = localStorage.getItem('strava_client_secret') || null;
  state.auth.accessToken  = localStorage.getItem('strava_access_token') || null;
  state.auth.refreshToken = localStorage.getItem('strava_refresh_token') || null;
  state.auth.expiresAt    = parseInt(localStorage.getItem('strava_expires_at') || '0', 10);

  const s = localStorage.getItem('strava_settings');
  if (s) {
    try { Object.assign(state.settings, JSON.parse(s)); } catch {}
  }
}

export function persistAuth() {
  const a = state.auth;
  if (a.clientId)     localStorage.setItem('strava_client_id', a.clientId);
  if (a.clientSecret) localStorage.setItem('strava_client_secret', a.clientSecret);
  if (a.accessToken)  localStorage.setItem('strava_access_token', a.accessToken);
  if (a.refreshToken) localStorage.setItem('strava_refresh_token', a.refreshToken);
  localStorage.setItem('strava_expires_at', String(a.expiresAt));
}

export function persistSettings() {
  localStorage.setItem('strava_settings', JSON.stringify(state.settings));
}

export function clearAuth() {
  state.auth = { clientId: null, clientSecret: null, accessToken: null, refreshToken: null, expiresAt: 0 };
  ['strava_client_id','strava_client_secret','strava_access_token',
   'strava_refresh_token','strava_expires_at'].forEach(k => localStorage.removeItem(k));
}
