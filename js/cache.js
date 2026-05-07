import { openDB } from 'idb';

const DB_NAME    = 'stravaHeatmap';
const DB_VERSION = 1;

let db = null;

async function getDb() {
  if (db) return db;
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('activities')) {
        database.createObjectStore('activities', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('streams')) {
        database.createObjectStore('streams', { keyPath: 'activity_id' });
      }
    },
  });
  return db;
}

// ── Activities ───────────────────────────────────────────────────────────────

export async function getAllActivities() {
  const db = await getDb();
  return db.getAll('activities');
}

// Upsert a batch of activity summaries
export async function saveActivities(activities) {
  const db = await getDb();
  const tx = db.transaction('activities', 'readwrite');
  await Promise.all(activities.map(a => tx.store.put(a)));
  await tx.done;
}

// Returns the most recent start_date from cached activities (for incremental sync)
export async function getLatestActivityDate() {
  const all = await getAllActivities();
  if (!all.length) return null;
  return all.reduce((max, a) => (a.start_date > max ? a.start_date : max), '');
}

// ── Streams ──────────────────────────────────────────────────────────────────

export async function getStream(activityId) {
  const db = await getDb();
  return db.get('streams', activityId);
}

export async function saveStream(activityId, latlng, time) {
  const db = await getDb();
  await db.put('streams', { activity_id: activityId, latlng, time });
}

export async function hasStream(activityId) {
  const db = await getDb();
  const entry = await db.get('streams', activityId);
  return !!entry;
}

// Returns Set of activity IDs that have cached streams
export async function getCachedStreamIds(activityIds) {
  const db = await getDb();
  const results = await Promise.all(activityIds.map(id => db.get('streams', id)));
  const cached = new Set();
  results.forEach((r, i) => { if (r) cached.add(activityIds[i]); });
  return cached;
}

// ── Storage info ─────────────────────────────────────────────────────────────

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usageMB: Math.round(usage / 1_000_000), quotaMB: Math.round(quota / 1_000_000) };
}

export async function clearAllData() {
  const db = await getDb();
  await db.clear('activities');
  await db.clear('streams');
}
