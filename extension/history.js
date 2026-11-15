// Screenshot history in IndexedDB (shared by the service worker, which writes, and the panel, which
// reads). Blobs are stored as they are. `kv` keeps small things, e.g. the chosen save-folder handle.
const DB_NAME = 'cdp-screenshot';
const DB_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

let dbPromise;
function db(idb = globalThis.indexedDB) {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('history', { keyPath: 'id' });
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function store(name, mode) {
  return (await db()).transaction(name, mode).objectStore(name);
}

export const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** @param {{kind: string, width: number, height: number, mime: string, blob: Blob, pageUrl?: string, pageTitle?: string}} entry */
export async function addEntry(entry) {
  const item = { id: newId(), createdAt: Date.now(), ...entry };
  await wrap((await store('history', 'readwrite')).put(item));
  return item;
}

/** Newest first. */
export async function listEntries() {
  const all = await wrap((await store('history', 'readonly')).getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getEntry(id) {
  return wrap((await store('history', 'readonly')).get(id));
}

/** Merge `patch` into an entry (e.g. the note about what was saved where); no-op if it is gone. */
export async function updateEntry(id, patch) {
  const current = await getEntry(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await wrap((await store('history', 'readwrite')).put(next));
  return next;
}

export async function deleteEntry(id) {
  await wrap((await store('history', 'readwrite')).delete(id));
}

export async function clearEntries() {
  await wrap((await store('history', 'readwrite')).clear());
}

/** Pure: ids of entries older than `days` (0 or less: nothing expires). */
export function expiredIds(entries, days, now = Date.now()) {
  if (!(days > 0)) return [];
  const limit = now - days * DAY_MS;
  return entries.filter((e) => e.createdAt < limit).map((e) => e.id);
}

/** Delete expired entries; returns how many. */
export async function pruneExpired(days, now = Date.now()) {
  const ids = expiredIds(await listEntries(), days, now);
  for (const id of ids) await deleteEntry(id);
  return ids.length;
}

export async function kvGet(key) {
  return wrap((await store('kv', 'readonly')).get(key));
}

export async function kvSet(key, value) {
  await wrap((await store('kv', 'readwrite')).put(value, key));
}

export async function kvDelete(key) {
  await wrap((await store('kv', 'readwrite')).delete(key));
}
