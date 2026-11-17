import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err } from './http.js';
import { securityHeaders, apiDefaults, apiRateLimits, jsonBody, csrfGuard } from './security.js';
import { registerAuth, sessionMiddleware } from './auth.js';
import { registerMeta } from './routes/meta.js';
import { registerProjects } from './routes/projects.js';
import { registerReceipts } from './routes/receipts.js';
import { registerExports } from './routes/exports.js';
import { registerItems } from './items.js';
import { registerBackup } from './backup.js';
import { registerAi } from './ai.js';
import { getReceipt } from './domain.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);

  app.use(securityHeaders);
  app.use(compression({ threshold: 1024 }));        // JSON/JS/CSS; photos, PDFs and zips are already compressed and are skipped by type
  app.use('/api', apiDefaults, apiRateLimits);
  app.use(jsonBody);
  app.use(sessionMiddleware);
  app.use('/api', csrfGuard);

  registerAuth(app);                                 // public /api/auth/*; everything registered after this requires a session
  registerMeta(app);
  registerProjects(app);
  registerReceipts(app);
  registerExports(app);
  registerItems(app);
  registerBackup(app);
  registerAi(app, { getReceipt });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---- the PWA. HTML/JS/CSS revalidate (cheap 304s via ETag); the big OCR assets are cached for a week.
  app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=604800' : 'no-cache');
    },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    // body-parser errors carry their own status; anything without one is a bug and must not leak details
    const status = e.status || e.statusCode || 500;
    if (status >= 500) console.error(e);
    const message = e.type === 'entity.too.large' ? 'request too large' : e.type === 'entity.parse.failed' ? 'invalid JSON' : status >= 500 ? 'internal error' : e.message;
    res.status(status).json({ error: message, ...(status < 500 && e.extra ? e.extra : {}) });
  });
  return app;
}
