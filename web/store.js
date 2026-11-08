// Remembering tracks between visits, with IndexedDB: a database every browser keeps for each website, on this device.
// It survives reloads and app updates (the database belongs to the address, not to the code), and nothing is uploaded.
// Each record holds the original file bytes, so the audio can be decoded again, and the measurements, so they need
// not be recomputed. Clearing the browser's site data for this address, or changing the address or port, empties it.
const DB = "mix-and-learn", STORE = "tracks", VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const saveTrack = (record) => run("readwrite", (s) => s.put(record));
export const forgetTrack = (id) => run("readwrite", (s) => s.delete(id));
export const allTracks = () => run("readonly", (s) => s.getAll());

// How much this site may store, and how much it uses, in megabytes.
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usedMB: e.usage / 1e6, quotaMB: e.quota / 1e6 };
}
