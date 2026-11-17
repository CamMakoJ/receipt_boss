// Entry point: HTTPS-capable server, background jobs, graceful shutdown.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, closeDb } from './db.js';
import { createApp } from './app.js';
import { startBackupScheduler } from './backup.js';
import { resumePendingChecks } from './ai.js';
import { startMaintenance } from './maintenance.js';

export { createApp };

function startServer() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const { TLS_CERT, TLS_KEY } = process.env;
  const app = createApp();
  let server, scheme = 'http';

  if (TLS_CERT && TLS_KEY) {
    const load = () => ({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' });
    server = https.createServer(load(), app);
    scheme = 'https';
    // pick up renewed certificates (e.g. `tailscale cert`, Let's Encrypt) without a restart
    setInterval(() => { try { server.setSecureContext(load()); } catch (e) { console.error('TLS reload failed:', e.message); } }, 12 * 3600e3).unref();
  } else {
    server = http.createServer(app);
  }
  server.requestTimeout = 5 * 60e3;            // large exports/uploads on slow links, but not forever
  server.headersTimeout = 30e3;

  server.listen(port, host, () => {
    console.log(`Receipt Boss on ${scheme}://${host}:${port}   (data: ${DATA_DIR})`);
    if (scheme === 'http' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      console.warn('WARNING: serving plain HTTP on the network. Phone camera, offline mode and "install app" need HTTPS,');
      console.warn('and passwords/sessions travel unencrypted. Set TLS_CERT and TLS_KEY (see README).');
    }
  });
  startMaintenance();
  startBackupScheduler();
  resumePendingChecks();

  // finish in-flight requests, flush the write-ahead log, then exit (systemd/docker stop send SIGTERM)
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down…`);
    const force = setTimeout(() => { closeDb(); process.exit(1); }, 10e3); force.unref();
    server.close(() => { closeDb(); process.exit(0); });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
