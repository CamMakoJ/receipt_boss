// Light / dark / follow-the-system. The choice is remembered on this device only.
const KEY = 'theme';
const media = matchMedia('(prefers-color-scheme: dark)');

export const getTheme = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
export const isDark = () => (getTheme() === 'auto' ? media.matches : getTheme() === 'dark');

export function applyTheme() {
  const t = getTheme(), root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  // keep the browser/PWA chrome colour in step (the static <meta> tags only follow the system setting)
  let meta = document.querySelector('meta[name="theme-color"][data-live]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; meta.dataset.live = '1'; document.head.appendChild(meta); }
  meta.content = isDark() ? '#0c1117' : '#f4f6f9';
  if (t === 'auto') meta.remove();                     // let the media-queried tags win again
}
export function setTheme(t) {
  try { if (t === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* private mode: lasts for this visit only */ }
  applyTheme();
  dispatchEvent(new Event('theme-changed'));
}
export const toggleTheme = () => setTheme(isDark() ? 'light' : 'dark');
media.addEventListener('change', () => { if (getTheme() === 'auto') { applyTheme(); dispatchEvent(new Event('theme-changed')); } });
