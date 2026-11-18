// The app's time zone (Settings → General). Decides what "today" means on the server (default dates, invoiced-on dates,
// report headers). Defaults to the container's TZ variable, else UTC.
import { getSetting, setSetting } from './db.js';

const BOOT_TZ = process.env.TZ || 'UTC';
export const isValidTz = (tz) => { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return typeof tz === 'string' && tz.length < 64; } catch { return false; } };
export const getTz = () => { const t = getSetting('app.tz', ''); return t && isValidTz(t) ? t : (isValidTz(BOOT_TZ) ? BOOT_TZ : 'UTC'); };
export const setTz = (tz) => setSetting('app.tz', tz);
export const timezones = () => (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []);

/** YYYY-MM-DD in the app's time zone. */
export const todayStr = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: getTz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
