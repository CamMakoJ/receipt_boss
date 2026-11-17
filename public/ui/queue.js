// Offline queue (IndexedDB): receipts, household items and quick captures made without a connection (or still being read) wait here
// and are sent when possible. Each entry: { client_id, user_id, url, data, label, project_id?, hold?, error?, duplicate?, created? }.
// Sending is idempotent (the server returns the existing record for a repeated client_id), so a retry can never duplicate anything.
import { state, hooks, api, isNetworkError, toast, icon, $, uuid, money, pad, plural } from './core.js';
import { confirmDialog } from './dialogs.js';

const idb = new Promise((resolve, reject) => {
  const open = indexedDB.open('receipt-boss', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('queue', { keyPath: 'client_id' });
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
async function store(mode, fn) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const t = db.transaction('queue', mode);
    const req = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
/** Only this user's entries: queued data belongs to the account that made it. */
export const queueAll = async () => ((await store('readonly', (s) => s.getAll())) || []).filter((i) => i.user_id === state.me?.id && i.url);
export const queuePut = (item) => store('readwrite', (s) => s.put({ ...item, user_id: state.me.id }));
export const queueDel = (id) => store('readwrite', (s) => s.delete(id));

export const dupText = (d) => (d.project_name ? `#${pad(d.number)} ${d.description || d.vendor || 'receipt'} — ${d.date}, ${money(d.total)} in “${d.project_name}”`
  : `${d.name} — ${d.purchase_date}${d.price ? ', ' + money(d.price) : ''}`);

/** Create a record; a duplicate warning asks first; offline saves to the queue. -> 'saved' | 'queued' | 'cancelled' */
export async function createRecord(url, data, queueExtra = {}) {
  const client_id = uuid();
  const attempt = (allow) => api('POST', url, { ...data, client_id, ...(allow ? { allow_duplicate: true } : {}) });
  try { await attempt(false); return 'saved'; }
  catch (e) {
    if (e.status === 409 && e.data?.duplicates) {
      const go = await confirmDialog(`This looks like a duplicate of:\n\n${e.data.duplicates.map(dupText).join('\n')}`, { title: 'Possible duplicate', ok: 'Save anyway' });
      if (!go) return 'cancelled';
      await attempt(true); return 'saved';
    }
    if (!isNetworkError(e)) throw e;
    await queuePut({ client_id, url, data, created: Date.now(), ...queueExtra });   // save locally, sync later
    await renderBanner(); toast('Offline — saved on this device, will sync automatically');
    return 'queued';
  }
}

let flushing = false;
/** Send what can be sent. `force` also retries entries that were flagged and are waiting for the user. */
export async function flushQueue(force = false) {
  if (flushing || !navigator.onLine || !state.me) return { sent: 0, flagged: 0 };
  flushing = true;
  let sent = 0, flagged = 0;
  try {
    for (const item of await queueAll()) {
      if (item.hold) continue;                                // quick capture: still being read on this device
      if (item.error && force !== true) continue;             // waits for the user: duplicate / rejected
      try {
        await api('POST', item.url, { ...item.data, client_id: item.client_id });
        await queueDel(item.client_id); sent++;
      } catch (e) {
        if (isNetworkError(e)) break;                         // still offline: try again later
        if (e.status === 401) { await hooks.showAuth(); break; }   // session expired: sign in again, the queue is kept
        if (e.status === 409) { await queuePut({ ...item, error: 'Possible duplicate', duplicate: e.data?.duplicates?.[0] || null }); flagged++; }   // needs a human decision
        else if (e.status === 404 || e.status === 400) { await queuePut({ ...item, error: e.message }); flagged++; }   // can never succeed: flag it
        else break;
      }
    }
  } finally { flushing = false; }
  const capturing = location.hash.startsWith('#/capture');   // that screen tracks its own progress; don't re-render it under the user
  if (sent && !capturing) toast(`Synced ${plural(sent, 'item')}`, 'ok');
  if ((sent || flagged) && !capturing) hooks.route();
  await renderBanner();
  dispatchEvent(new Event('queue-changed'));                  // screens that show queue state (quick capture) refresh themselves
  return { sent, flagged };
}

/** The "waiting to sync" strip under the top bar. */
export async function renderBanner() {
  const q = state.me ? await queueAll() : [];
  const el = $('#sync');
  el.hidden = !q.length;
  if (!q.length) return;
  const failed = q.filter((i) => i.error).length;
  el.innerHTML = `${icon('alert')}<span class="grow">${plural(q.length, 'item')} waiting to sync${failed ? ` — ${failed} need attention` : ''}</span><button class="btn sm" id="syncnow">Sync now</button>`;
  $('#syncnow').onclick = () => flushQueue(true);
}

/** A capture whose reading was interrupted (page closed) is released as a plain draft after a while. */
export async function releaseStaleHolds() {
  for (const it of await queueAll()) if (it.hold && Date.now() - (it.created || 0) > 10 * 60e3) await queuePut({ ...it, hold: false });
}

addEventListener('online', () => flushQueue());
