import { state, persistAuth, clearAuth } from './state.js';

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const REDIRECT_URI = window.location.origin + window.location.pathname.replace(/\/$/, '');

export function isAuthenticated() {
  return !!state.auth.accessToken && !!state.auth.refreshToken;
}

// Redirect user to Strava OAuth consent page
export function startOAuthFlow() {
  const params = new URLSearchParams({
    client_id:     state.auth.clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope:         'activity:read_all',
  });
  window.location.href = `${STRAVA_AUTH_URL}?${params}`;
}

// Check URL for OAuth callback code; returns the code string or null
export function extractOAuthCode() {
  const params = new URLSearchParams(window.location.search);
  const code  = params.get('code');
  const error = params.get('error');
  if (code || error) {
    // Clean the URL immediately so refresh doesn't re-trigger
    history.replaceState({}, '', window.location.pathname);
  }
  if (error) throw new Error(`Strava auth denied: ${error}`);
  return code || null;
}

// Exchange authorization code for tokens
export async function exchangeCode(code) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     state.auth.clientId,
      client_secret: state.auth.clientSecret,
      code,
      grant_type:    'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Token exchange failed (${res.status})`);
  }
  const data = await res.json();
  applyTokenResponse(data);
}

// Refresh an expired access token using the stored refresh token
export async function refreshAccessToken() {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     state.auth.clientId,
      client_secret: state.auth.clientSecret,
      refresh_token: state.auth.refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token refresh failed — please reconnect Strava');
  const data = await res.json();
  applyTokenResponse(data);
}

// Ensure access token is valid; refreshes if expiring within 60 seconds
export async function ensureValidToken() {
  if (Date.now() / 1000 > state.auth.expiresAt - 60) {
    await refreshAccessToken();
  }
}

export function disconnect() {
  clearAuth();
}

function applyTokenResponse(data) {
  state.auth.accessToken  = data.access_token;
  state.auth.refreshToken = data.refresh_token;
  state.auth.expiresAt    = data.expires_at;
  persistAuth();
}
