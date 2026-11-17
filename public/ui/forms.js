// Small helpers for building forms.
import { state, esc } from './core.js';

const provLabel = (code) => `${code} — ${state.meta.provinces[code].name}`;
export const provOptions = (sel) => Object.keys(state.meta.provinces)
  .map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${esc(provLabel(c))} (${esc(state.meta.provinces[c].note)})</option>`).join('');
export const catOptions = (list, used = []) => [...new Set([...list, ...used])].map((c) => `<option value="${esc(c)}">`).join('');
/** Province taxes in cents for a subtotal in cents (same rule the server applies). */
export const calcTax = (sub, prov) => {
  const p = state.meta.provinces[prov] || state.meta.provinces[state.meta.default_province];
  return { gst: Math.round((sub * p.gst) / 100000), pst: Math.round((sub * p.pst) / 100000) };
};
/** <div class="field"> wrapper: label + control markup. */
export const field = (label, control, { id = '', hint = '', cls = '' } = {}) =>
  `<div class="field ${cls}"><label ${id ? `for="${id}"` : ''}>${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label>${control}</div>`;
