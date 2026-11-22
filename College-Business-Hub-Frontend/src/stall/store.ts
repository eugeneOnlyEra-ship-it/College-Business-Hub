import { ApiError, getMyBusinesses, getSession, type OwnedBusiness } from '../api';
import type { Ledger, PendingEntry, SyncResult } from './types';

/**
 * Stall mode keeps its own copy of the owner's numbers in IndexedDB, so it works with no connection:
 * - the last ledger from the server (listings, stock, 90 days of sales),
 * - the entries recorded on this device and not yet saved by the server,
 * - the owner's business list, so the page can open offline.
 * Everything is keyed by the signed-in email, so two people sharing a laptop never see each other's books.
 */

const DB = 'cbc-stall';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
const db = () => (dbPromise ??= openDb());

async function get<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Private windows on some browsers have no IndexedDB: fall back to localStorage.
    try {
      const raw = localStorage.getItem(`${DB}:${key}`);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  }
}

async function set(key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    localStorage.setItem(`${DB}:${key}`, JSON.stringify(value));
  }
}

const who = () => getSession()?.email ?? 'anonymous';
const k = (kind: string, businessId?: string) => `${who()}:${kind}${businessId ? `:${businessId}` : ''}`;

export const loadLedger = (businessId: string) => get<Ledger>(k('ledger', businessId));
export const saveLedger = (businessId: string, l: Ledger) => set(k('ledger', businessId), l);
export const loadPending = async (businessId: string) => (await get<PendingEntry[]>(k('pending', businessId))) ?? [];
export const savePending = (businessId: string, p: PendingEntry[]) => set(k('pending', businessId), p);
export const loadRejected = async (businessId: string) => (await get<{ entry: PendingEntry; reason: string }[]>(k('rejected', businessId))) ?? [];
const saveRejected = (businessId: string, r: { entry: PendingEntry; reason: string }[]) => set(k('rejected', businessId), r);

export async function addPending(businessId: string, entry: PendingEntry) {
  const p = await loadPending(businessId);
  await savePending(businessId, [...p, entry]);
}

export async function removePending(businessId: string, clientId: string) {
  const p = await loadPending(businessId);
  await savePending(businessId, p.filter((e) => e.clientId !== clientId));
}

/** The owner's businesses: from the server when it answers, otherwise the last copy on this device. */
export async function businesses(): Promise<{ list: OwnedBusiness[]; fromCache: boolean }> {
  try {
    const list = await getMyBusinesses();
    await set(k('businesses'), list);
    return { list, fromCache: false };
  } catch (e) {
    const cached = await get<OwnedBusiness[]>(k('businesses'));
    if (cached && (!(e instanceof ApiError) || e.status === 0)) return { list: cached, fromCache: true };
    throw e;
  }
}

// ---- Talking to the server (same base URL and token as the rest of the app) ----

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.PROD ? '' : 'http://localhost:3000');

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSession()?.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError((data as { message?: string } | null)?.message ?? 'The server refused the request.', res.status, data);
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('No connection.', 0, null);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches a fresh ledger and keeps it. Throws ApiError status 0 when offline. */
export async function refreshLedger(businessId: string): Promise<Ledger> {
  const l = await call<Ledger>(`/businesses/${encodeURIComponent(businessId)}/ledger`);
  await saveLedger(businessId, l);
  return l;
}

let syncing: Promise<unknown> | null = null;

/**
 * Sends everything recorded on this device. Entries the server saved (or had already) are removed;
 * entries it can never accept are moved to a "needs attention" list instead of being retried forever.
 * If the connection drops halfway, nothing is lost: the same entries are simply sent again next time.
 */
export async function syncNow(businessId: string): Promise<{ sent: number; rejected: number; ledger: Ledger } | null> {
  if (syncing) await syncing.catch(() => undefined);
  const run = (async () => {
    const pending = await loadPending(businessId);
    if (!pending.length) return { sent: 0, rejected: 0, ledger: await refreshLedger(businessId) };
    const batch = pending.slice(0, 200);
    const r = await call<SyncResult>(`/businesses/${encodeURIComponent(businessId)}/ledger/sync`, {
      method: 'POST',
      body: JSON.stringify({ entries: batch }),
    });
    const done = new Set([...r.accepted, ...r.rejected.map((x) => x.clientId)]);
    // Re-read: the owner may have logged another sale while the request was in flight.
    const now = await loadPending(businessId);
    await savePending(businessId, now.filter((e) => !done.has(e.clientId)));
    if (r.rejected.length) {
      const why = new Map(r.rejected.map((x) => [x.clientId, x.reason]));
      const old = await loadRejected(businessId);
      await saveRejected(businessId, [...old, ...batch.filter((e) => why.has(e.clientId)).map((entry) => ({ entry, reason: why.get(entry.clientId)! }))]);
    }
    await saveLedger(businessId, r.ledger);
    return { sent: r.accepted.length, rejected: r.rejected.length, ledger: r.ledger };
  })();
  syncing = run;
  try {
    return await run;
  } finally {
    syncing = null;
  }
}

export async function dismissRejected(businessId: string) {
  await saveRejected(businessId, []);
}
