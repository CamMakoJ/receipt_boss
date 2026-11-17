// Container health probe: GET /api/meta on the local server (HTTP or HTTPS, any certificate).
import http from 'node:http';
import https from 'node:https';
const secure = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const req = (secure ? https : http).get(
  { host: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/api/meta', timeout: 4000, rejectUnauthorized: false },
  (res) => { res.resume(); process.exit(res.statusCode < 500 ? 0 : 1); });
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
