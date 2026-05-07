import { state } from './state.js';
import { ensureValidToken } from './auth.js';
import { saveActivities, saveStream } from './cache.js';

const BASE = 'https://www.strava.com/api/v3';

// Simple token bucket: track requests in the current 15-minute window
const rateLimit = {
  count: 0,
  windowStart: Date.now(),
  limit: 95, // stay under Strava's 100/15min hard limit

  reset() {
    const now = Date.now();
    if (now - this.windowStart > 15 * 60 * 1000) {
      this.count = 0;
      this.windowStart = now;
    }
  },

  async waitIfNeeded(onWait) {
    this.reset();
    if (this.count >= this.limit) {
      const waitMs = (this.windowStart + 15 * 60 * 1000) - Date.now() + 1000;
      if (onWait) onWait(Math.ceil(waitMs / 1000));
      await sleep(waitMs);
      this.reset();
    }
    this.count++;
  },
};

async function apiFetch(path, onRateWait) {
  await ensureValidToken();
  await rateLimit.waitIfNeeded(onRateWait);

  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${state.auth.accessToken}` },
  });

  if (res.status === 429) {
    // Hard rate limit from Strava — back off 60 seconds and retry once
    if (onRateWait) onRateWait(60);
    await sleep(61_000);
    return apiFetch(path, onRateWait);
  }

  if (!res.ok) throw new Error(`Strava API error ${res.status} on ${path}`);
  return res.json();
}

// ── Activity index ────────────────────────────────────────────────────────────

// Fetches ALL activity summaries (paginated). Calls onProgress(fetched, total).
// Uses after= to only fetch new activities since last sync.
export async function fetchAllActivities({ onProgress, onRateWait, afterDate } = {}) {
  const after = afterDate ? Math.floor(new Date(afterDate).getTime() / 1000) : 0;
  const perPage = 200;
  let page = 1;
  let fetched = 0;
  const all = [];

  while (true) {
    const params = new URLSearchParams({ per_page: perPage, page });
    if (after) params.set('after', after);

    const batch = await apiFetch(`/athlete/activities?${params}`, onRateWait);
    if (!batch.length) break;

    // Filter for activities that have GPS start point
    const withGPS = batch.filter(a => a.start_latlng?.length === 2);
    all.push(...withGPS);
    fetched += batch.length;

    await saveActivities(withGPS);
    if (onProgress) onProgress(fetched, null);

    if (batch.length < perPage) break;
    page++;
  }

  return all;
}

// ── GPS Streams ───────────────────────────────────────────────────────────────

// Fetches latlng + time streams for a single activity
export async function fetchStream(activityId, onRateWait) {
  const data = await apiFetch(
    `/activities/${activityId}/streams?keys=latlng,time&key_by_type=true`,
    onRateWait
  );

  const latlng = data.latlng?.data;
  const time   = data.time?.data;

  if (!latlng?.length) return null;

  await saveStream(activityId, latlng, time || latlng.map((_, i) => i));
  return { latlng, time };
}

// Fetches streams for a list of activity IDs respecting rate limits.
// Skips IDs already present in cachedIds.
// Calls onProgress(done, total) and onRateWait(secondsRemaining).
export async function fetchStreams(activityIds, cachedIds, { onProgress, onRateWait } = {}) {
  const needed = activityIds.filter(id => !cachedIds.has(id));
  const total = needed.length;
  let done = 0;

  // Process in batches of 5 concurrent requests
  for (let i = 0; i < needed.length; i += 5) {
    const chunk = needed.slice(i, i + 5);
    await Promise.allSettled(chunk.map(id => fetchStream(id, onRateWait)));
    done += chunk.length;
    if (onProgress) onProgress(done, total);
  }
}

// ── Athlete ───────────────────────────────────────────────────────────────────

export async function fetchAthlete() {
  return apiFetch('/athlete');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
