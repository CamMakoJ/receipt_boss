// Receipt Boss front end — entry point: auth screens, navigation chrome, router, boot. Screens live in ./ui/*.js.
import { $, state, hooks, esc, api, toast, icon, mount, getMeta, isNetworkError, refreshInbox } from './ui/core.js';
import { applyTheme, toggleTheme, isDark } from './ui/theme.js';
import { renderBanner, flushQueue, releaseStaleHolds } from './ui/queue.js';
import { viewProjects, viewProject } from './ui/projects.js';
import { viewReceiptForm } from './ui/receipt.js';
import { viewItems, viewItemForm, viewSearch } from './ui/household.js';
import { viewCapture, viewInbox } from './ui/capture.js';
import { viewSettings } from './ui/settings.js';

// ---------------------------------------------------------------- chrome: top bar + tab bar
const NAV = [['projects', '#/', 'Projects', 'folder'], ['capture', '#/capture', 'Capture', 'zap'], ['household', '#/household', 'Household', 'home'], ['settings', '#/settings', 'Settings', 'sliders']];
let section = 'projects';

function renderNav() {
  const nav = $('#nav');
  nav.hidden = !state.me;
  if (!state.me) return;
  nav.innerHTML = NAV.map(([k, href, label, ic]) =>
    `<a href="${href}" class="${k === section ? 'on' : ''}" ${k === section ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${k === 'capture' && state.inbox ? `<span class="badge" aria-label="${state.inbox} in Inbox">${state.inbox}</span>` : ''}</a>`).join('');
}
const renderNet = () => { $('#net').hidden = navigator.onLine; };
function renderThemeButton() {
  $('#themebtn').innerHTML = icon(isDark() ? 'sun' : 'moon');
  $('#themebtn').setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
}
hooks.refreshChrome = renderNav;
hooks.route = () => route();
hooks.showAuth = () => showAuth();

// ---------------------------------------------------------------- auth screens
async function showAuth() {
  state.me = null; state.inbox = 0; renderNav(); $('#sync').hidden = true;
  let st;
  try { st = await api('GET', '/auth/status'); }
  catch (e) {
    mount(`<div class="page auth"><div class="card pad stack center"><div class="logo">${icon('wifi-off')}</div><b>${isNetworkError(e) ? 'The server is not reachable and you are signed out.' : esc(e.message)}</b><p class="muted small">Reconnect to sign in.</p><button class="btn primary" id="retry">Retry</button></div></div>`);
    $('#retry').onclick = () => location.reload();
    return;
  }
  if (st.user) { state.me = st.user; return start(); }
  const setup = st.needsSetup;
  mount(`<div class="page auth stack"><div class="logo">${icon('receipt')}</div>
    <div class="stack tight center"><h1>${setup ? 'Welcome to Receipt Boss' : 'Sign in'}</h1>
      <p class="muted small">${setup ? 'Create the administrator account. You can add family members afterwards in Settings.' : 'Your receipts, on your own server.'}</p></div>
    <form id="auth" class="card pad stack">
      <div class="field"><label for="a-user">Username</label><input id="a-user" name="username" autocomplete="username" autocapitalize="none" required></div>
      <div class="field"><label for="a-pass">Password ${setup ? '<span class="hint">(8+ characters)</span>' : ''}</label><input id="a-pass" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required></div>
      <button class="btn primary block big">${setup ? 'Create account' : 'Sign in'}</button>
    </form></div>`);
  $('#auth').onsubmit = async (ev) => {
    ev.preventDefault();
    try { state.me = (await api('POST', setup ? '/auth/setup' : '/auth/login', Object.fromEntries(new FormData(ev.target)))).user; start(); }
    catch (e) { toast(isNetworkError(e) ? 'Cannot reach the server' : e.message, true); }
  };
}

// ---------------------------------------------------------------- router
async function route() {
  if (!state.me) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [a, b, c] = parts;
  section = a === 'capture' ? 'capture' : a === 'household' ? 'household' : a === 'settings' ? 'settings' : 'projects';
  renderNav();
  try {
    await getMeta();
    if (a === 'household') return b === 'new' ? await viewItemForm({}) : b ? await viewItemForm({ itemId: b }) : await viewItems();
    if (a === 'settings') return await viewSettings(b || '');
    if (a === 'search') return await viewSearch();
    if (a === 'capture') return await viewCapture();
    if (a === 'inbox') return await viewInbox();
    if (a === 'p' && c === 'new') return await viewReceiptForm({ projectId: b });
    if (a === 'p') return await viewProject(b, c === 'export' || c === 'settings' ? c : 'receipts');
    if (a === 'r') return await viewReceiptForm({ receiptId: b });
    return await viewProjects();
  } catch (e) {
    if (e.status === 401) return showAuth();
    mount(`<div class="page"><div class="card pad stack center"><div class="logo">${icon(isNetworkError(e) ? 'wifi-off' : 'alert')}</div><b>${isNetworkError(e) ? 'You are offline and this page was not saved for offline use yet.' : esc(e.message)}</b><div><a class="btn" href="#/">Back to projects</a></div></div></div>`);
  }
}
addEventListener('hashchange', () => { state.pollTries = 0; route(); });

// ---------------------------------------------------------------- boot
async function start() {
  await releaseStaleHolds();
  renderNav();
  await renderBanner();
  route();
  flushQueue();
  refreshInbox();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
applyTheme(); renderThemeButton(); renderNet();
$('#themebtn').onclick = toggleTheme;
addEventListener('theme-changed', renderThemeButton);
addEventListener('online', renderNet);
addEventListener('offline', renderNet);
(async () => {
  try {
    const st = await api('GET', '/auth/status');   // served from cache when offline
    if (st.user) { state.me = st.user; return start(); }
  } catch (e) { if (!isNetworkError(e)) console.error(e); }
  showAuth();
})();
