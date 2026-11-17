// Housekeeping that keeps a long-running instance healthy.
import { quickCheck, maintain } from './db.js';
import { purgeSessions } from './auth.js';

export function startMaintenance() {
  const problem = quickCheck();
  if (problem !== 'ok') console.error(`[db] integrity check FAILED: ${problem}\n[db] Restore the latest backup (see README) before continuing.`);
  purgeSessions();
  const hourly = () => { try { purgeSessions(); maintain(); } catch (e) { console.error('[maintenance]', e.message); } };
  setInterval(hourly, 3600e3).unref();
  return problem;
}
