/*
 * idb-projects.ts — project payload storage in IndexedDB (hand-rolled, no deps).
 *
 * Rationale: project payloads used to live in localStorage under
 * `octobx:project:<name>` as JSON with the Octopus binary base64-encoded.
 * Base64 inflates binary state by ~4/3, and localStorage is capped at ~5 MB
 * per origin — the quota is hit after only ~25-50 saved projects. IndexedDB
 * stores binary natively (Uint8Array, no base64 round-trip) with a far larger
 * quota, so all project payloads move there.
 *
 * Storage split (see state-persistence.ts):
 *   - Payloads (Octopus binary + app-state JSON): IndexedDB, this module.
 *   - Project index + active-project name: localStorage (small, synchronous).
 *
 * DB layout: db `octobx`, version 1, object store `projects` (keyPath "name").
 * Record: { name, octopusState: Uint8Array | null, appStateJson, savedAt }.
 *
 * The DB is lazy-opened with a cached open promise so all callers share one
 * connection; an `indexeddb.open` failure rejects for every awaiter.
 */

const DB_NAME = "octobx";
const DB_VERSION = 1;
const STORE_NAME = "projects";

// Legacy localStorage payload keys (`octobx:project:<name>`) — see
// migrateLegacyProjects().
const LEGACY_PREFIX = "octobx:project:";

interface ProjectRecord {
    name: string;
    octopusState: Uint8Array | null;
    appStateJson: string;
    savedAt: string;
}

// Cached open promise — created lazily on first use, shared by all callers.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "name" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
    });
    return dbPromise;
}

/*
 * Run a single-request transaction on the projects store. Resolves with the
 * request result once the transaction COMPLETES (not just on request success)
 * so a resolved write means the data is durably stored.
 */
function runRequest<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then((db) => new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = fn(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    }));
}

function putRecord(rec: ProjectRecord): Promise<void> {
    return runRequest("readwrite", (store) => store.put(rec)).then(() => undefined);
}

// ---- Public API ----

/* Upsert a project payload (binary stored natively, no base64). */
export function idbSaveProject(name: string, octopusBytes: Uint8Array | null, appStateJson: string): Promise<void> {
    return putRecord({
        name,
        octopusState: octopusBytes,
        appStateJson,
        savedAt: new Date().toISOString(),
    });
}

/* Load a project payload; resolves null when the name is unknown. */
export async function idbLoadProject(name: string): Promise<{
    octopusState: Uint8Array | null;
    appStateJson: string;
    savedAt: string;
} | null> {
    const rec = await runRequest<ProjectRecord | undefined>("readonly", (store) => store.get(name));
    if (!rec) return null;
    return {
        octopusState: rec.octopusState ?? null,
        appStateJson: typeof rec.appStateJson === "string" ? rec.appStateJson : "{}",
        savedAt: typeof rec.savedAt === "string" ? rec.savedAt : "",
    };
}

/* Delete a project payload. */
export function idbDeleteProject(name: string): Promise<void> {
    return runRequest("readwrite", (store) => store.delete(name)).then(() => undefined);
}

/* Existence check (store.get + null check). */
export async function idbHasProject(name: string): Promise<boolean> {
    const rec = await runRequest<ProjectRecord | undefined>("readonly", (store) => store.get(name));
    return rec != null;
}

// ---- Legacy migration ----

/*
 * One-time migration: move legacy localStorage payloads (`octobx:project:*`,
 * base64-in-JSON schema) into IndexedDB. Each localStorage key is removed
 * ONLY after its IDB write resolved, so a failed IDB write never loses data.
 * Projects already present in IDB are skipped (never clobber newer data).
 * Returns how many projects were migrated. Individual failures are logged
 * and skipped — this never throws.
 */
export async function migrateLegacyProjects(): Promise<number> {
    // Scan localStorage for legacy payload keys first (mutating localStorage
    // while iterating it is unsafe).
    const legacyKeys: string[] = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
        }
    } catch (e) {
        console.warn("[project] Migration: localStorage scan failed", e);
        return 0;
    }
    if (legacyKeys.length === 0) return 0;

    let migrated = 0;
    for (const key of legacyKeys) {
        const name = key.slice(LEGACY_PREFIX.length);
        try {
            if (await idbHasProject(name)) continue; // already migrated / newer data

            const raw = localStorage.getItem(key);
            if (raw === null) continue; // vanished mid-scan

            let parsed: { octopus_state?: unknown; app_state?: unknown; saved_at?: unknown };
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                console.warn(`[project] Migration: skipping "${name}" (unparseable legacy payload)`, e);
                continue;
            }

            // Decode the legacy base64 binary payload
            let octopusState: Uint8Array | null = null;
            if (typeof parsed.octopus_state === "string" && parsed.octopus_state.length > 0) {
                try {
                    const binary = atob(parsed.octopus_state);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    octopusState = bytes;
                } catch (e) {
                    console.warn(`[project] Migration: bad base64 in "${name}", migrating without binary`, e);
                }
            }

            await putRecord({
                name,
                octopusState,
                appStateJson: typeof parsed.app_state === "string" ? parsed.app_state : "{}",
                savedAt: typeof parsed.saved_at === "string" ? parsed.saved_at : new Date().toISOString(),
            });

            // IDB write resolved — safe to drop the localStorage original
            localStorage.removeItem(key);
            migrated++;
        } catch (e) {
            console.warn(`[project] Migration: failed to migrate "${name}" (localStorage payload kept)`, e);
        }
    }
    return migrated;
}
