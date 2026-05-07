// Thin IndexedDB wrapper — no external dependency needed.

const DB_NAME    = 'stravaHeatmap';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('activities')) {
        db.createObjectStore('activities', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('streams')) {
        db.createObjectStore('streams', { keyPath: 'activity_id' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function tx(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const req = fn(store);
    transaction.oncomplete = () => resolve(req?.result);
    transaction.onerror    = e => reject(e.target.error);
  }));
}

function getAll(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function getOne(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function putAll(storeName, items) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const s = t.objectStore(storeName);
    items.forEach(item => s.put(item));
    t.oncomplete = () => resolve();
    t.onerror    = e => reject(e.target.error);
  }));
}

function putOne(storeName, item) {
  return putAll(storeName, [item]);
}

function clearStore(storeName) {
  return tx(storeName, 'readwrite', s => s.clear());
}

// ── Activities ────────────────────────────────────────────────────────────────

export async function getAllActivities() {
  return getAll('activities');
}

export async function saveActivities(activities) {
  return putAll('activities', activities);
}

export async function getLatestActivityDate() {
  const all = await getAllActivities();
  if (!all.length) return null;
  return all.reduce((max, a) => (a.start_date > max ? a.start_date : max), '');
}

// ── Streams ───────────────────────────────────────────────────────────────────

export async function getStream(activityId) {
  return getOne('streams', activityId);
}

export async function saveStream(activityId, latlng, time) {
  return putOne('streams', { activity_id: activityId, latlng, time });
}

export async function getCachedStreamIds(activityIds) {
  const cached = new Set();
  await Promise.all(activityIds.map(async id => {
    const entry = await getOne('streams', id);
    if (entry) cached.add(id);
  }));
  return cached;
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usageMB: Math.round(usage / 1_000_000), quotaMB: Math.round(quota / 1_000_000) };
}

export async function clearAllData() {
  await clearStore('activities');
  await clearStore('streams');
}
