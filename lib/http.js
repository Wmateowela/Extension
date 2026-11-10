'use strict';

/**
 * Small HTTP helpers shared by the Vercel tracking endpoint.
 */

const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?roblox\.com$/i,
  /^chrome-extension:\/\/[a-z]{32}$/i,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server / same-origin / tests
  return ALLOWED_ORIGINS.some((pattern) => pattern.test(String(origin)));
}

function isAllowedRequestOrigin(req) {
  const headers = (req && req.headers) || {};
  const origin = String(headers.origin || '').trim();
  if (!origin || isAllowedOrigin(origin)) return true;
  try {
    const forwardedHost = String(headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHost = forwardedHost || String(headers.host || '').trim();
    const parsed = new URL(origin);
    return Boolean(requestHost) && parsed.host.toLowerCase() === requestHost.toLowerCase();
  } catch (_) {
    return false;
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers && req.headers.origin;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  if (origin && isAllowedRequestOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        if (Buffer.byteLength(req.body, 'utf8') > maxBytes) {
          return reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        }
        try {
          return resolve(JSON.parse(req.body));
        } catch (_) {
          return reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
        }
      }
      if (Buffer.isBuffer(req.body)) {
        if (req.body.length > maxBytes) {
          return reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        }
        try {
          return resolve(JSON.parse(req.body.toString('utf8')));
        } catch (_) {
          return reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
        }
      }
      if (typeof req.body === 'object') {
        const serialized = JSON.stringify(req.body);
        if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
          return reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        }
        return resolve(req.body);
      }
    }

    let totalBytes = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        try { req.destroy(); } catch (_) { /* noop */ }
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        return reject(Object.assign(new Error('Empty body'), { statusCode: 400 }));
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });

    req.on('error', () => {
      reject(Object.assign(new Error('Read error'), { statusCode: 400 }));
    });
  });
}

function getClientIp(req) {
  const headers = req.headers || {};

  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }

  const realIp = headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim().slice(0, 64);
  }

  const vercelForwarded = headers['x-vercel-forwarded-for'];
  if (typeof vercelForwarded === 'string' && vercelForwarded.trim()) {
    return vercelForwarded.split(',')[0].trim().slice(0, 64);
  }

  return String((req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

function decodeHeaderValue(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

let regionDisplayNames = null;
try {
  regionDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch (_) {
  regionDisplayNames = null;
}

function countryName(code) {
  if (!code) return '';
  try {
    if (regionDisplayNames) {
      const name = regionDisplayNames.of(code);
      if (name && name !== code) return name;
    }
  } catch (_) { /* noop */ }
  return code;
}

/**
 * Vercel adds geo headers to every request:
 *   x-vercel-ip-country, x-vercel-ip-country-region, x-vercel-ip-city
 * The exact IP is read from x-forwarded-for (first entry).
 */
function getGeo(req) {
  const headers = req.headers || {};
  const ip = getClientIp(req);
  const countryCode = String(headers['x-vercel-ip-country'] || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);

  return {
    ip,
    countryCode,
    country: countryName(countryCode),
    region: decodeHeaderValue(headers['x-vercel-ip-country-region']).slice(0, 80),
    city: decodeHeaderValue(headers['x-vercel-ip-city']).slice(0, 80),
  };
}

module.exports = {
  MAX_BODY_BYTES,
  isAllowedOrigin,
  isAllowedRequestOrigin,
  setCorsHeaders,
  sendJson,
  readJsonBody,
  getClientIp,
  getGeo,
};
