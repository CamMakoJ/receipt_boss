// Shared state, DOM/format helpers, API client. Imported by every UI module; imports nothing from them
// (views are wired together through `hooks`, set once by app.js, so there are no import cycles).

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const app = $('#app');

export const state = { me: null, meta: null, ai: null, inbox: 0, pollTries: 0 };
export const hooks = { route: async () => {}, showAuth: async () => {}, refreshChrome: () => {} };

// ---------------------------------------------------------------- formatting
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const toCents = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0; };
export const fromCents = (c) => (c ? (c / 100).toFixed(2) : '');
export const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
export const pad = (n) => String(n).padStart(3, '0');
export const debounce = (fn, ms = 120) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- icons (sprite lives in index.html)
export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ---------------------------------------------------------------- toast
export function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast ${kind === true ? 'bad' : kind}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3800);
}

// ---------------------------------------------------------------- API
export async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: { 'x-rb': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, offline: res.status === 503, data });
  return data;
}
export const isNetworkError = (e) => e.offline || e instanceof TypeError;

export const getMeta = async () => (state.meta ||= await api('GET', '/meta'));
/** Is a local AI model configured? (cached; reset to null after the settings change) */
export const getAi = async () => {
  try { return (state.ai ||= await api('GET', '/ai/status')); } catch { return { enabled: false, vision: false, auto_check: false }; }
};
export async function refreshInbox() {
  state.inbox = (await api('GET', '/inbox').catch(() => [])).length;
  hooks.refreshChrome();
  return state.inbox;
}

// ---------------------------------------------------------------- page helpers
export const skeleton = (n = 4) => `<div class="page"><div class="skel"></div>${'<div class="skel"></div>'.repeat(n - 1)}</div>`;
export const emptyState = (iconName, title, text = '') =>
  `<div class="empty">${icon(iconName)}<div><b>${esc(title)}</b></div>${text ? `<div class="small">${esc(text)}</div>` : ''}</div>`;
/** Render a page. Scrolls to the top unless it is a refresh of the page the user is already on. */
export function mount(html, { keepScroll = false } = {}) {
  const y = scrollY;
  app.innerHTML = html;
  scrollTo(0, keepScroll ? y : 0);
}
/** Wrap a click/submit handler: run it, toast any error. */
export const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(isNetworkError(e) ? 'No connection to the server' : e.message, true); } };

/** Sign out: tell the server, forget cached private data on this device, reload. */
export async function logout() {
  try { await api('POST', '/auth/logout', {}); } catch { /* offline: the cookie stays, but local caches are still cleared below */ }
  try { for (const k of await caches.keys()) if (k.startsWith('data-')) await caches.delete(k); } catch { /* ignore */ }
  Object.keys(localStorage).filter((k) => k.startsWith('project-')).forEach((k) => localStorage.removeItem(k));
  state.meta = null; state.ai = null; location.hash = '#/'; location.reload();
}
