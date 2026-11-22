import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, type OwnedBusiness } from './api';
import { aiConfigured, askStall, deviceState, parseEntry, prepareDeviceModel, weeklyAdvice, type DeviceState, type SaleDraft, type Source } from './stall/ai';
import { factSheet, money, newClientId, plainAnswer, stockReport, summarize, unknownAmounts, withPending, type Period } from './stall/numbers';
import { quickParse } from './stall/quickparse';
import {
  addPending, businesses as loadBusinesses, dismissRejected, loadLedger, loadPending, loadRejected, refreshLedger, removePending, syncNow,
} from './stall/store';
import type { Ledger, PendingEntry } from './stall/types';
import './stall.css';

/**
 * Stall mode: the owner's offline counter book.
 * Log in-person sales and restocks with or without a connection, see profit and stock instantly,
 * and ask questions. Answers come from Gemini Nano on the device when it is there, Gemini in the cloud when it is not,
 * and from plain calculation when neither is reachable. Everything syncs when the connection comes back.
 */
export default function StallMode() {
  const online = useOnline();
  const [list, setList] = useState<OwnedBusiness[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [bizId, setBizId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBusinesses()
      .then(({ list, fromCache }) => {
        setList(list);
        setFromCache(fromCache);
        const open = list.filter((b) => !b.closed);
        setBizId((cur) => cur ?? (open[0] ?? list[0])?.id ?? null);
      })
      .catch((e) => setError(e instanceof ApiError && e.status !== 0 ? e.message : 'Stall mode has not been opened on this device yet. Connect once to download your books.'));
  }, []);

  return (
    <div className="page stall">
      <section className="hero hero-coin hero-blend short" aria-label="Stall mode">
        <div className="hero-inner">
          <span className="eyebrow">Stall mode · works offline</span>
          <h1>Your <em>counter book</em></h1>
          <p>Log cash sales and restocks as they happen, even with no data. Profit and stock update instantly, and your questions are answered by the AI on this device when it can, or in the cloud when it cannot.</p>
        </div>
      </section>
      {error && <div className="error" role="alert">{error}</div>}
      {list && list.length === 0 && (
        <div className="card"><h2>No business yet</h2><p>Create one in the <a href="#/assistant">assistant</a> or on <a href="#/sell">My business</a> first.</p></div>
      )}
      {list && list.length > 1 && (
        <div className="stall-picker" role="group" aria-label="Business">
          {list.map((b) => (
            <button key={b.id} className={`chip${b.id === bizId ? ' on' : ''}`} onClick={() => setBizId(b.id)}>{b.name}{b.closed ? ' (closed)' : ''}</button>
          ))}
        </div>
      )}
      {bizId && <StallBook key={bizId} businessId={bizId} online={online} fromCache={fromCache} />}
    </div>
  );
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

function StallBook({ businessId, online, fromCache }: { businessId: string; online: boolean; fromCache: boolean }) {
  const [server, setServer] = useState<Ledger | null>(null);
  const [pending, setPending] = useState<PendingEntry[]>([]);
  const [rejected, setRejected] = useState<{ entry: PendingEntry; reason: string }[]>([]);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'failed'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reloadLocal = useCallback(async () => {
    const [l, p, r] = await Promise.all([loadLedger(businessId), loadPending(businessId), loadRejected(businessId)]);
    if (l) setServer(l);
    setPending(p);
    setRejected(r);
    return l;
  }, [businessId]);

  const sync = useCallback(async () => {
    setSyncState('syncing');
    try {
      const r = await syncNow(businessId);
      if (r) {
        setServer(r.ledger);
        if (r.sent) setNote(`Saved ${r.sent} ${r.sent === 1 ? 'entry' : 'entries'} to your account.`);
        if (r.rejected) setNote(`${r.rejected} ${r.rejected === 1 ? 'entry needs' : 'entries need'} your attention below.`);
      }
      setSyncState('idle');
    } catch (e) {
      setSyncState('failed');
      if (e instanceof ApiError && e.status !== 0) setNote(e.message);
    } finally {
      await reloadLocal();
    }
  }, [businessId, reloadLocal]);

  // Open from the device copy at once, then catch up with the server if it answers.
  useEffect(() => {
    reloadLocal().then((l) => {
      if (navigator.onLine) sync();
      else if (!l) setLoadError('This business has not been opened in Stall mode on this device yet. Connect once to download its books.');
    });
  }, [reloadLocal, sync]);
  useEffect(() => { if (online && pending.length) sync(); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const ledger = useMemo(() => (server ? withPending(server, pending) : null), [server, pending]);

  async function record(entry: PendingEntry) {
    await addPending(businessId, entry);
    await reloadLocal();
    if (navigator.onLine) sync();
  }
  async function undo(clientId: string) {
    await removePending(businessId, clientId);
    await reloadLocal();
  }

  if (loadError && !ledger) return <div className="error" role="alert">{loadError}</div>;
  if (!ledger) return <p>Loading your books…</p>;

  return (
    <>
      <StatusBar
        online={online}
        pending={pending.length}
        syncState={syncState}
        updated={server?.generatedAt}
        fromCache={fromCache || !online}
        onSync={sync}
      />
      {note && <p className="stall-note" role="status">{note} <button className="link" onClick={() => setNote(null)}>OK</button></p>}
      {rejected.length > 0 && (
        <div className="error" role="alert">
          <strong>These entries could not be saved:</strong>
          <ul>{rejected.map((r) => <li key={r.entry.clientId}>{r.entry.type === 'SALE' ? 'Sale' : 'Restock'} of {r.entry.quantity}: {r.reason}</li>)}</ul>
          <button className="chip" onClick={async () => { await dismissRejected(businessId); await reloadLocal(); }}>Dismiss</button>
        </div>
      )}
      <div className="stall-grid">
        <div className="stall-col">
          <LogBox ledger={ledger} onSave={record} />
          <Numbers ledger={ledger} />
          <StockCard ledger={ledger} />
        </div>
        <div className="stall-col">
          <AskBox ledger={ledger} online={online} />
          <Recent ledger={ledger} pending={pending} onUndo={undo} />
        </div>
      </div>
    </>
  );
}

function StatusBar(p: { online: boolean; pending: number; syncState: string; updated?: string; fromCache: boolean; onSync: () => void }) {
  const when = p.updated ? new Date(p.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  return (
    <div className="stall-status card">
      <span className={`badge ${p.online ? 'ok' : 'off'}`}>{p.online ? 'Online' : 'Offline'}</span>
      <span className="fine">
        {p.pending ? `${p.pending} ${p.pending === 1 ? 'entry' : 'entries'} saved on this device, waiting to sync. ` : 'Everything is synced. '}
        Last copy from the server: {when}.
      </span>
      <button className="chip" onClick={p.onSync} disabled={!p.online || p.syncState === 'syncing'}>
        {p.syncState === 'syncing' ? 'Syncing…' : 'Sync now'}
      </button>
      <DeviceModel />
    </div>
  );
}

/** Shows whether Gemini Nano is on this device and lets the owner download it for offline answers. */
function DeviceModel() {
  const [state, setState] = useState<DeviceState | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { deviceState().then(setState); }, []);
  if (!state) return null;

  async function download() {
    setFailed(false);
    setProgress(0);
    try {
      await prepareDeviceModel((f) => setProgress(f));
      setState(await deviceState());
    } catch {
      setFailed(true);
    } finally {
      setProgress(null);
    }
  }

  if (state === 'available') return <span className="badge ok" title="Gemini Nano runs in Chrome on this device">AI on this device: ready</span>;
  if (state === 'no-api' || state === 'unavailable')
    return <span className="badge off" title="Needs Chrome on desktop with the built-in Gemini Nano model">No on-device AI here · cloud when online</span>;
  if (!aiConfigured) return null;
  return (
    <span className="stall-dl">
      {progress !== null ? (
        <span className="badge">Downloading the offline model… {Math.round(progress * 100)}%</span>
      ) : (
        <button className="chip" onClick={download}>{state === 'downloading' ? 'Finish offline model download' : 'Download AI for offline use'}</button>
      )}
      {failed && <span className="fine">Download did not start. Check free disk space and try again.</span>}
    </span>
  );
}

// ---- Logging ----

function LogBox({ ledger, onSave }: { ledger: Ledger; onSave: (e: PendingEntry) => Promise<void> }) {
  const listings = ledger.listings.filter((l) => l.active);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<(SaleDraft & { source?: Source | 'rules' }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  async function read(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setHint(null);
    try {
      let d: (SaleDraft & { source?: Source | 'rules' }) | null = null;
      if (aiConfigured) d = await parseEntry(text, listings).catch(() => null);
      if (!d) { const q = quickParse(text, listings); d = q ? { ...q, source: 'rules' } : null; }
      if (!d) setHint('I could not tell which item that is. Pick it below.');
      setDraft(d ?? { type: 'SALE', listingId: listings[0]?.id ?? '', quantity: 1 });
    } finally { setBusy(false); }
  }

  const quick = (listingId: string, type: 'SALE' | 'RESTOCK' = 'SALE') => { setDraft({ type, listingId, quantity: 1 }); setHint(null); };

  return (
    <div className="card">
      <h2>Log a sale or restock</h2>
      <form className="stall-log" onSubmit={read}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="e.g. sold 3 samosas, or got 24 sodas at 55c" aria-label="What happened" />
        <button className="primary" disabled={busy || !text.trim()}>{busy ? 'Reading…' : 'Read'}</button>
      </form>
      <div className="stall-quick" aria-label="Quick sale">
        {listings.slice(0, 8).map((l) => <button key={l.id} className="chip" onClick={() => quick(l.id)}>+1 {l.title}</button>)}
      </div>
      {hint && <p className="fine">{hint}</p>}
      {draft && <DraftCard key={JSON.stringify(draft)} ledger={ledger} draft={draft} onCancel={() => setDraft(null)} onSave={async (e) => { await onSave(e); setDraft(null); setText(''); }} />}
    </div>
  );
}

function DraftCard({ ledger, draft, onSave, onCancel }: { ledger: Ledger; draft: SaleDraft & { source?: Source | 'rules' }; onSave: (e: PendingEntry) => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState(draft.type);
  const [listingId, setListingId] = useState(draft.listingId);
  const listing = ledger.listings.find((l) => l.id === listingId);
  const [qty, setQty] = useState(String(draft.quantity));
  const defaultPrice = type === 'SALE' ? (draft.unitPriceCents ?? listing?.priceCents) : (draft.unitCostCents ?? listing?.costCents ?? undefined);
  const [price, setPrice] = useState(defaultPrice !== undefined ? (defaultPrice / 100).toFixed(2) : '');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const quantity = parseInt(qty, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) { setError('Quantity must be a whole number from 1.'); return; }
    const cents = price.trim() === '' ? undefined : Math.round(parseFloat(price) * 100);
    if (cents !== undefined && (!Number.isFinite(cents) || cents < 0 || cents > 100000)) { setError('Enter the amount in dollars, for example 0.50.'); return; }
    if (type === 'SALE' && cents === undefined) { setError('Enter what the customer paid per unit.'); return; }
    await onSave({
      clientId: newClientId(),
      listingId,
      type,
      quantity,
      ...(type === 'SALE' ? { unitPriceCents: cents } : cents !== undefined ? { unitCostCents: cents } : {}),
      note: type === 'SALE' ? 'in person' : '',
      at: new Date().toISOString(),
    });
  }

  const total = (parseInt(qty, 10) || 0) * Math.round((parseFloat(price) || 0) * 100);
  return (
    <form className="stall-draft" onSubmit={save}>
      <p className="fine">
        Check this before saving.
        {draft.source && <SourceBadge source={draft.source} />}
      </p>
      <div className="stall-draft-row">
        <select value={type} onChange={(e) => setType(e.target.value as 'SALE' | 'RESTOCK')} aria-label="Type">
          <option value="SALE">Sold</option>
          <option value="RESTOCK">Restocked</option>
        </select>
        <input className="qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
        <select value={listingId} onChange={(e) => setListingId(e.target.value)} aria-label="Item">
          {ledger.listings.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
        <label className="stall-price">{type === 'SALE' ? 'at $' : 'cost $'}
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={type === 'SALE' ? 'price' : 'optional'} aria-label={type === 'SALE' ? 'Price per unit' : 'Cost per unit'} />
          each
        </label>
      </div>
      {total > 0 && <p className="fine">Total {money(total)}{type === 'SALE' && listing?.stockQty != null ? ` · ${listing.stockQty - (parseInt(qty, 10) || 0)} ${listing.title} left after this` : ''}</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="stall-actions">
        <button className="primary">Save</button>
        <button type="button" className="chip" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---- Numbers and stock (always calculated in code) ----

function Numbers({ ledger }: { ledger: Ledger }) {
  const [period, setPeriod] = useState<Period>('today');
  const s = summarize(ledger, period);
  const tabs: [Period, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', '30 days']];
  return (
    <div className="card">
      <div className="sales-head">
        <h2>Profit</h2>
        <div className="stall-tabs" role="tablist">
          {tabs.map(([p, label]) => <button key={p} role="tab" aria-selected={p === period} className={`chip${p === period ? ' on' : ''}`} onClick={() => setPeriod(p)}>{label}</button>)}
        </div>
      </div>
      <dl className="sales-stats">
        <div><dt>Sales</dt><dd>{money(s.revenueCents)}</dd></div>
        <div><dt>Costs</dt><dd>{s.costCents ? '−' : ''}{money(s.costCents)}</dd></div>
        <div><dt>Fees</dt><dd>{s.feesCents ? '−' : ''}{money(s.feesCents)}</dd></div>
        <div><dt>Profit</dt><dd className={s.profitCents < 0 ? 'stall-loss' : 'sales-net'}>{money(s.profitCents)}</dd></div>
      </dl>
      {s.sales === 0 ? <p className="fine">No sales {s.label}.</p> : (
        <ul className="lines">
          {s.items.map((i) => (
            <li key={i.listingId}>
              <span className="grow">{i.units} × {i.title}<small>sales {money(i.revenueCents)}{i.unitsWithoutCost ? ' · no cost recorded' : ''}</small></span>
              <span>{money(i.profitCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {s.missingCost.length > 0 && <p className="fine">Add what {s.missingCost.join(', ')} costs you on <a href="#/sell">My business</a> to see real profit.</p>}
      <p className="fine">Cash and in-person {money(s.cashCents)} · PayPal {money(s.onlineCents)}</p>
    </div>
  );
}

function StockCard({ ledger }: { ledger: Ledger }) {
  const rows = stockReport(ledger);
  const uncounted = ledger.listings.filter((l) => l.active && l.kind === 'PRODUCT' && l.stockQty === null);
  return (
    <div className="card">
      <h2>Stock</h2>
      {rows.length === 0 ? <p className="fine">No stock counted yet. Log a restock, or add a stock number on <a href="#/sell">My business</a>.</p> : (
        <ul className="lines">
          {rows.map((r) => (
            <li key={r.listing.id}>
              <span className="grow">{r.listing.title}
                <small>{r.daysLeft === null ? 'no sales in the last 7 days' : `about ${r.perDay.toFixed(1)} a day · lasts ~${Math.floor(r.daysLeft)} days`}</small>
              </span>
              <span className={`badge stock-${r.status}`}>{r.status === 'out' ? 'Out' : `${r.stock} left`}</span>
            </li>
          ))}
        </ul>
      )}
      {uncounted.length > 0 && <p className="fine">Not counted: {uncounted.map((l) => l.title).join(', ')}.</p>}
    </div>
  );
}

// ---- Asking ----

const SUGGESTIONS = ['How much profit did I make today?', 'What is running low?', 'What sold best this week?', 'Did I do better than yesterday?'];

interface Answer { question: string; text: string; source: Source | 'calculated'; unknown: string[]; facts: string }

function AskBox({ ledger, online }: { ledger: Ledger; online: boolean }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<'ask' | 'plan' | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);

  async function ask(question: string, kind: 'ask' | 'plan') {
    if (!question.trim() || busy) return;
    setBusy(kind);
    const facts = factSheet(ledger);
    let a: Answer;
    try {
      if (!aiConfigured) throw new Error('no ai');
      const r = kind === 'plan' ? await weeklyAdvice(facts) : await askStall(question, facts);
      a = { question, text: r.text, source: r.source, unknown: unknownAmounts(r.text, facts), facts };
    } catch {
      // No model on the device and no connection (or AI not set up): answer from the numbers alone.
      a = {
        question,
        text: kind === 'plan' ? 'Weekly advice needs the AI. Here are your numbers instead: ' + plainAnswer('this week', ledger) + ' ' + plainAnswer('running low', ledger) : plainAnswer(question, ledger),
        source: 'calculated',
        unknown: [],
        facts,
      };
    }
    setAnswers((prev) => [a, ...prev].slice(0, 6));
    setBusy(null);
    if (kind === 'ask') setQ('');
  }

  return (
    <div className="card">
      <h2>Ask about your stall</h2>
      <form className="stall-log" onSubmit={(e) => { e.preventDefault(); ask(q, 'ask'); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={400} placeholder="How much did I make this week?" aria-label="Your question" />
        <button className="primary" disabled={!!busy || !q.trim()}>{busy === 'ask' ? 'Thinking…' : 'Ask'}</button>
      </form>
      <div className="stall-quick">
        {SUGGESTIONS.map((s) => <button key={s} className="chip" disabled={!!busy} onClick={() => ask(s, 'ask')}>{s}</button>)}
      </div>
      <button className="ghost-dark stall-plan" disabled={!!busy} onClick={() => ask('Plan for next week', 'plan')}>
        {busy === 'plan' ? 'Planning…' : `Plan my next week${online ? '' : ' (offline: uses the device model)'}`}
      </button>
      {answers.map((a, i) => (
        <article key={i} className="stall-answer">
          <p className="stall-q">{a.question} <SourceBadge source={a.source} /></p>
          <div className="stall-a">{a.text.split('\n').filter(Boolean).map((line, j) => <p key={j}>{line}</p>)}</div>
          {a.unknown.length > 0 && (
            <p className="stall-warn">Check this: {a.unknown.join(', ')} {a.unknown.length === 1 ? 'is' : 'are'} not in your numbers. The figures on the left are the correct ones.</p>
          )}
          <details><summary className="fine">Numbers the answer used</summary><pre className="stall-facts">{a.facts}</pre></details>
        </article>
      ))}
    </div>
  );
}

function SourceBadge({ source }: { source: Source | 'calculated' | 'rules' }) {
  const label = { on_device: 'On this device', in_cloud: 'Cloud', calculated: 'Calculated, no AI', rules: 'Read without AI' }[source];
  const title = {
    on_device: 'Answered by Gemini Nano in Chrome. Nothing left this device.',
    in_cloud: 'Answered by Gemini in the cloud through Firebase AI Logic.',
    calculated: 'No AI was reachable, so this was worked out from your numbers directly.',
    rules: 'Read with simple rules because no AI was reachable.',
  }[source];
  return <span className={`badge src-${source}`} title={title}>{label}</span>;
}

// ---- History ----

function Recent({ ledger, pending, onUndo }: { ledger: Ledger; pending: PendingEntry[]; onUndo: (id: string) => void }) {
  const waiting = new Set(pending.map((p) => p.clientId));
  const rows = ledger.entries.slice(0, 15);
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="card">
      <h2>Recent</h2>
      {rows.length === 0 ? <p className="fine">Nothing recorded yet.</p> : (
        <ul className="lines">
          {rows.map((e) => (
            <li key={e.id}>
              <span className="grow">
                {e.type === 'SALE' ? 'Sold' : 'Restocked'} {e.quantity} × {e.title}
                <small>{when(e.at)} · {e.source === 'PAYPAL' ? 'PayPal' : 'in person'}{waiting.has(e.id) ? ' · not synced yet' : ''}</small>
              </span>
              <span>
                {e.type === 'SALE' && e.unitPriceCents !== null ? money(e.unitPriceCents * e.quantity) : ''}
                {waiting.has(e.id) && <button className="link" onClick={() => onUndo(e.id)}>Undo</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
