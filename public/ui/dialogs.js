// Promise-based modals on the native <dialog> element (themed, accessible, trap focus) instead of the browser's confirm()/prompt().
import { esc } from './core.js';

function open({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}
      <div class="actions">${cancel ? `<button class="btn ghost" value="cancel" formnovalidate>${esc(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'danger solid' : 'primary'}" value="ok">${esc(ok)}</button></div></form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const result = dlg.returnValue === 'ok' ? new FormData(dlg.querySelector('form')) : null;
      dlg.remove(); resolve(result);
    });
    dlg.showModal();
    onOpen?.(dlg);
  });
}

/** @returns {Promise<boolean>} */
export async function confirmDialog(message, { title = 'Are you sure?', ok = 'Confirm', danger = false } = {}) {
  return !!(await open({ title, body: `<p class="muted">${esc(message).replace(/\n/g, '<br>')}</p>`, ok, danger }));
}

/** @returns {Promise<string|null>} the typed text, or null when cancelled */
export async function promptDialog(label, { title = label, value = '', ok = 'OK', placeholder = '', type = 'text' } = {}) {
  const fd = await open({
    title, ok,
    body: `<div class="field"><label for="dlg-in">${esc(label)}</label><input id="dlg-in" name="v" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" required></div>`,
    onOpen: (d) => { const i = d.querySelector('input'); i.focus(); i.select(); },
  });
  return fd ? String(fd.get('v')).trim() : null;
}

/** Show custom form markup; resolves with the FormData on OK or null. */
export const formDialog = ({ title, body, ok = 'Save' }) => open({ title, body, ok });
/** Informational message with a single button. */
export const alertDialog = (message, { title = 'Notice', ok = 'OK' } = {}) => open({ title, body: `<p class="muted">${esc(message)}</p>`, ok, cancel: '' });
