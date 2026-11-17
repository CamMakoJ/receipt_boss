// HTTP hardening: security headers + CSP, request-size limits, rate limiting, CSRF guard.
import express from 'express';
import { err } from './http.js';

/**
 * Content-Security-Policy. The app is one origin: scripts/styles/workers all come from 'self'.
 *  - 'wasm-unsafe-eval' lets the OCR engine (WebAssembly) compile; it does NOT allow eval() of strings.
 *  - blob: workers/images: the OCR worker and cropped-photo previews.
 *  - style-src has no 'unsafe-inline': the UI uses classes, and JS sets individual styles through the CSSOM (which CSP allows).
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  if (req.secure || req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 180 days, HTTPS only
  next();
}

/** Private data: never reuse a response without asking the server (photo routes override this with their own rules). */
export function apiDefaults(req, res, next) {
  res.setHeader('Cache-Control', 'private, no-cache');
  next();
}

// ---- request bodies: 100 KB everywhere, except the routes that carry photos (base64 JPEGs, up to 12 per record)
const small = express.json({ limit: '100kb' });
const big = express.json({ limit: '48mb' });
const PHOTO_ROUTE = /^\/api\/(projects\/[^/]+\/receipts|receipts\/[^/]+|items(\/[^/]+)?)$/;
export function jsonBody(req, res, next) {
  const carriesPhotos = (req.method === 'POST' || req.method === 'PATCH') && PHOTO_ROUTE.test(req.path);
  return (carriesPhotos ? big : small)(req, res, next);
}

/**
 * CSRF defence in depth (cookies are also SameSite=Lax): state-changing calls must carry a custom header,
 * which a cross-site page cannot send without a CORS preflight that this server never grants.
 */
export function csrfGuard(req, res, next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-rb') !== '1') return next(err(403, 'missing X-RB header'));
  next();
}

/** Fixed-window limiter, in memory (this is a single-process app). */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests — slow down a little' }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(), k = key(req);
    let h = hits.get(k);
    if (!h || h.reset <= now) {
      if (hits.size > 20000) hits.clear();                       // hard memory bound
      h = { n: 0, reset: now + windowMs }; hits.set(k, h);
    }
    if (++h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return next(err(429, message));
    }
    next();
  };
}

// Paths are relative to /api. Exports/backups/AI calls are the expensive ones.
const HEAVY = /^\/(projects\/[^/]+\/(export\.zip|report\.pdf|report\.csv)|backup\/(download|run|verify)|ai\/(search|test))$/;
const general = rateLimit({ windowMs: 60e3, max: 1500 });
const heavy = rateLimit({ windowMs: 60e3, max: 30, message: 'Too many exports/backups in a minute — wait a moment' });
const authAttempts = rateLimit({ windowMs: 60e3, max: 30, message: 'Too many sign-in attempts — wait a minute' });
export function apiRateLimits(req, res, next) {
  if (req.path === '/auth/login' || req.path === '/auth/setup') return authAttempts(req, res, (e) => (e ? next(e) : general(req, res, next)));
  if (HEAVY.test(req.path)) return heavy(req, res, (e) => (e ? next(e) : general(req, res, next)));
  return general(req, res, next);
}
