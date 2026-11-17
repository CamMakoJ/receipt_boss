// Settings: appearance, account, users, local AI, backup. Sections are native <details> panels (no JS needed to open/close).
import { $, $$, state, hooks, esc, when, plural, api, toast, icon, mount, guard, logout, isNetworkError } from './core.js';
import { field } from './forms.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import { getTheme, setTheme } from './theme.js';

const HEALTH_CLS = { ok: 'ok', warning: '', error: 'bad', off: '' };

export async function viewSettings(section = '') {
  const admin = state.me.role === 'admin';
  const [users, bk, aiCfg] = admin ? await Promise.all([api('GET', '/users'), api('GET', '/backup'), api('GET', '/ai')]) : [[], null, null];
  const panel = (id, title, ic, body, { open = false } = {}) =>
    `<details class="panel" id="sec-${id}" ${open || section === id ? 'open' : ''}><summary>${icon(ic)} ${title}</summary><div class="panel-body">${body}</div></details>`;
  const theme = getTheme();

  const appearance = `<div class="field"><span class="lbl">Theme</span>
      <div class="seg" role="group" aria-label="Theme">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-set-theme="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="hint">Auto follows your device. This choice is remembered on this device only.</div></div>`;

  const account = `<form id="pw" class="stack">
      ${field('Current password', '<input id="pw-cur" type="password" name="current" autocomplete="current-password" required>', { id: 'pw-cur' })}
      ${field('New password', '<input id="pw-new" type="password" name="password" autocomplete="new-password" required minlength="8">', { id: 'pw-new', hint: '(8+ characters; signs out your other devices)' })}
      <div class="row"><button class="btn primary">Change password</button><button type="button" class="btn" id="out">${icon('x')} Sign out</button></div></form>`;

  const usersHtml = admin ? `<div class="card list">${users.map((u) => `<div class="item"><div class="iconsq">${icon('user')}</div>
        <div class="body"><div class="name">${esc(u.username)} <span class="pill ${u.role === 'admin' ? 'accent' : ''}">${u.role}</span></div><div class="meta">${plural(u.projects, 'project')}</div></div>
        <div class="row"><button class="btn sm" data-reset="${u.id}" data-name="${esc(u.username)}">Reset password</button>
        ${u.id === state.me.id ? '' : `<button class="btn sm" data-role="${u.id}" data-to="${u.role === 'admin' ? 'user' : 'admin'}">Make ${u.role === 'admin' ? 'user' : 'admin'}</button><button class="iconbtn" data-rm="${u.id}" data-name="${esc(u.username)}" aria-label="Delete ${esc(u.username)}">${icon('trash')}</button>`}</div></div>`).join('')}</div>
      <form id="newu" class="stack"><h3>Add a family member</h3>
        <div class="grid2">${field('Username', '<input id="nu-name" name="username" required autocapitalize="none" autocomplete="off">', { id: 'nu-name' })}${field('Temporary password', '<input id="nu-pw" name="password" type="password" required autocomplete="new-password">', { id: 'nu-pw' })}</div>
        <label class="check"><input type="checkbox" name="admin"> Administrator</label>
        <div><button class="btn primary">Add user</button></div></form>` : '';

  const aiHtml = admin ? `<p class="muted small">Connect any OpenAI-compatible server on your network (Ollama, LM Studio, llama.cpp, vLLM…). It double-checks new work receipts against the receipt and powers “Ask” search. Requests go only to the address below.</p>
      <form id="aiform" class="stack">
        <label class="check"><input type="checkbox" name="enabled" ${aiCfg.enabled ? 'checked' : ''}> Turn on AI features</label>
        ${field('Server address', `<input id="ai-url" name="base_url" value="${esc(aiCfg.base_url)}" autocapitalize="none">`, { id: 'ai-url', hint: 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1' })}
        ${field('Model name', `<input id="ai-model" name="model" list="aimodels" value="${esc(aiCfg.model)}" autocapitalize="none" placeholder="e.g. qwen2.5vl:7b"><datalist id="aimodels"></datalist>`, { id: 'ai-model' })}
        ${field('API key', `<input id="ai-key" name="api_key" type="password" autocomplete="off" placeholder="${aiCfg.has_key ? 'saved — leave blank to keep it' : ''}">`, { id: 'ai-key', hint: '(only if your server needs one)' })}
        ${aiCfg.has_key ? '<label class="check"><input type="checkbox" name="clear_key"> Remove the saved key</label>' : ''}
        <label class="check"><input type="checkbox" name="vision" ${aiCfg.vision ? 'checked' : ''}><span>This model can look at images <span class="hint">(a vision model such as llava, qwen2.5-vl, gemma3). Off = it reads the text scanned from the photo instead.</span></span></label>
        <label class="check"><input type="checkbox" name="auto_check" ${aiCfg.auto_check ? 'checked' : ''}> Check new work receipts automatically after they are saved</label>
        ${field('Wait up to (seconds)', `<input id="ai-timeout" name="timeout_s" inputmode="numeric" value="${aiCfg.timeout_s}">`, { id: 'ai-timeout', hint: '(local models can be slow)' })}
        <div class="row"><button class="btn primary">Save AI settings</button><button type="button" class="btn" id="aitest">Test connection</button></div>
        <div id="aiout" class="small"></div></form>` : '';

  let backupHtml = '';
  if (admin) {
    const h = bk.health, st = bk.status;
    backupHtml = `<div class="banner ${HEALTH_CLS[h.state] === 'bad' ? 'bad' : HEALTH_CLS[h.state] === 'ok' ? 'ok' : ''}">${icon(h.state === 'ok' ? 'check' : 'alert')}<span class="grow">${esc(h.message)}</span></div>
      <div class="small muted">Last attempt: ${esc(when(st.last_at))} · last success: ${esc(when(st.last_ok))}</div>
      ${st.last_message ? `<div class="small ${/FAILED/.test(st.last_message) ? 'err' : 'muted'}">${esc(st.last_message)}</div>` : ''}
      <form id="bk" class="stack">
        <label class="check"><input type="checkbox" name="enabled" ${bk.config.enabled ? 'checked' : ''}> Back up automatically</label>
        <div class="grid2">${field('Every (hours)', `<input id="bk-hours" name="interval_hours" inputmode="numeric" value="${bk.config.interval_hours}">`, { id: 'bk-hours' })}${field('Copies to keep', `<input id="bk-keep" name="keep" inputmode="numeric" value="${bk.config.keep}">`, { id: 'bk-keep' })}</div>
        ${field('Google Drive (or any rclone remote)', `<input id="bk-remote" name="remote" value="${esc(bk.config.remote)}" placeholder="gdrive:ReceiptBoss" autocapitalize="none">`, { id: 'bk-remote', hint: 'set up once with “rclone config” — see the README' })}
        ${field('Also copy to a folder on the server', `<input id="bk-copy" name="copy_dir" value="${esc(bk.config.copy_dir)}" placeholder="/mnt/nas/receipt-boss-backups" autocapitalize="none">`, { id: 'bk-copy', hint: '(optional — e.g. a NAS)' })}
        <label class="check"><input type="checkbox" name="encrypt" ${bk.config.encrypt ? 'checked' : ''}><span>${icon('lock')} Encrypt backups with a passphrase <span class="hint">(AES-256, before anything is saved or uploaded)</span></span></label>
        ${field('Passphrase', `<input id="bk-pass" name="passphrase" type="password" autocomplete="new-password" placeholder="${bk.config.has_passphrase ? 'saved — leave blank to keep it' : ''}">`, { id: 'bk-pass', hint: '10+ characters. If you lose it, encrypted backups cannot be opened — keep it in your password manager.' })}
        ${bk.config.has_passphrase ? '<label class="check"><input type="checkbox" name="clear_passphrase"> Remove the saved passphrase (turns encryption off)</label>' : ''}
        <div class="row"><button class="btn primary">Save backup settings</button><button type="button" class="btn" id="bkrun">Back up now</button><a class="btn" href="/api/backup/download">${icon('download')} Download</a></div></form>
      ${bk.files.some((f) => f.encrypted) ? `<div class="stack tight"><span class="lbl">Prove you can still open an encrypted backup</span><div class="row nowrap"><input id="vpass" type="password" placeholder="Passphrase" autocomplete="off" class="grow"><button type="button" class="btn" id="vbtn">Verify</button></div><div id="vout" class="small"></div></div>` : ''}
      ${st.history.length ? `<div class="stack tight"><span class="lbl">Recent backups</span><div class="card list">${st.history.slice(0, 6).map((x) => `<div class="item"><div class="body"><div class="name">${esc(when(x.at))}</div><div class="meta">${x.ok ? `${x.counts ? plural(x.counts.receipts, 'receipt') + ' · ' : ''}${(x.size / 1048576).toFixed(1)} MB · ${x.seconds}s` : esc((x.message || '').slice(0, 90))}</div></div>
        <span class="pill ${x.ok ? 'ok' : 'bad'}">${x.verified ? icon('check') + 'verified' : x.ok ? 'ok' : 'failed'}</span></div>`).join('')}</div></div>` : ''}
      ${bk.files.length ? `<div class="small muted">On this server: ${bk.files.map((f) => `<a href="/api/backup/files/${f.name}">${f.encrypted ? '🔒 ' : ''}${esc(f.name.replace('receipt-boss-backup-', '').replace('.zip.enc', '').replace('.zip', ''))}</a> (${(f.size / 1048576).toFixed(1)} MB)`).join(' · ')}</div>` : ''}`;
  }

  mount(`<div class="page"><h1>Settings</h1>
    ${panel('appearance', 'Appearance', 'sun', appearance, { open: true })}
    ${panel('account', `Account — ${esc(state.me.username)}${admin ? ' · admin' : ''}`, 'user', account)}
    ${admin ? panel('users', 'Users', 'user', usersHtml) + panel('ai', 'Local AI (optional)', 'sparkles', aiHtml) + panel('backup', 'Backup', 'lock', backupHtml) : ''}
  </div>`);
  if (section && $(`#sec-${section}`)) $(`#sec-${section}`).scrollIntoView({ block: 'start' });

  // (not [data-theme]: the <html> element carries that attribute itself)
  $$('[data-set-theme]').forEach((b) => (b.onclick = () => { setTheme(b.dataset.setTheme); $$('[data-set-theme]').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#out').onclick = logout;
  $('#pw').onsubmit = guard(async (ev) => {
    ev.preventDefault();
    await api('POST', '/auth/password', Object.fromEntries(new FormData(ev.target))); ev.target.reset(); toast('Password changed; other devices were signed out', 'ok');
  });
  if (!admin) return;

  const refresh = (fn) => guard(async (...a) => { await fn(...a); hooks.route(); });
  $('#newu').onsubmit = refresh(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('POST', '/users', { username: f.get('username'), password: f.get('password'), role: f.get('admin') ? 'admin' : 'user' }); toast('User added', 'ok');
  });
  $$('[data-reset]').forEach((b) => (b.onclick = guard(async () => {
    const pw = await promptDialog(`New password for ${b.dataset.name} (8+ characters). They will be signed out everywhere.`, { title: 'Reset password', type: 'password', ok: 'Reset' });
    if (pw) { await api('PATCH', `/users/${b.dataset.reset}`, { password: pw }); toast('Password reset', 'ok'); }
  })));
  $$('[data-role]').forEach((b) => (b.onclick = refresh(() => api('PATCH', `/users/${b.dataset.role}`, { role: b.dataset.to }))));
  $$('[data-rm]').forEach((b) => (b.onclick = refresh(async () => {
    if (await confirmDialog(`Delete ${b.dataset.name} and ALL of their projects and receipts? This cannot be undone.`, { title: 'Delete user?', ok: 'Delete', danger: true })) await api('DELETE', `/users/${b.dataset.rm}`);
  })));

  const aiBody = () => {
    const f = new FormData($('#aiform'));
    return { enabled: !!f.get('enabled'), base_url: f.get('base_url'), model: f.get('model'), api_key: f.get('api_key'), clear_key: !!f.get('clear_key'),
      vision: !!f.get('vision'), auto_check: !!f.get('auto_check'), timeout_s: Number(f.get('timeout_s')) };
  };
  $('#aiform').onsubmit = refresh(async (ev) => { ev.preventDefault(); await api('PUT', '/ai', aiBody()); state.ai = null; toast('AI settings saved', 'ok'); });
  $('#aitest').onclick = async () => {
    const out = $('#aiout'); out.className = 'small muted'; out.textContent = 'Testing…';
    try {
      await api('PUT', '/ai', aiBody()); state.ai = null;                   // test what is on screen
      const r = await api('POST', '/ai/test', {});
      out.className = 'small good';
      out.textContent = `Connected in ${(r.ms / 1000).toFixed(1)}s — the model replied “${r.reply}”.` + (r.model_listed ? '' : ' (That model name is not in the server’s list — check the spelling.)') + (r.models.length ? ` Models available: ${r.models.join(', ')}` : '');
      $('#aimodels').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
    } catch (e) { out.className = 'small err'; out.textContent = e.message; }
  };

  $('#bk').onsubmit = refresh(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('PUT', '/backup', { enabled: !!f.get('enabled'), interval_hours: Number(f.get('interval_hours')), keep: Number(f.get('keep')), remote: f.get('remote'), copy_dir: f.get('copy_dir'),
      encrypt: !!f.get('encrypt'), passphrase: f.get('passphrase'), clear_passphrase: !!f.get('clear_passphrase') });
    toast('Backup settings saved', 'ok');
  });
  if ($('#vbtn')) $('#vbtn').onclick = async () => {
    const out = $('#vout'); out.className = 'small muted'; out.textContent = 'Checking… (large backups take a moment)';
    try { const r = await api('POST', '/backup/verify', { passphrase: $('#vpass').value }); out.className = 'small good'; out.textContent = `That passphrase opens ${r.name} — ${r.info.counts.receipts} receipts, ${r.info.images} photos, all checksums good.`; }
    catch (e) { out.className = 'small err'; out.textContent = isNetworkError(e) ? 'No connection to the server' : e.message; }
  };
  $('#bkrun').onclick = guard(async () => {
    const b = $('#bkrun'); b.disabled = true; toast('Backing up and verifying…');
    try { const r = await api('POST', '/backup/run', {}); toast(r.message, 'ok'); } catch (e) { toast(e.message, true); }
    hooks.route();
  });
}
