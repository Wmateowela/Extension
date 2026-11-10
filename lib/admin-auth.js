'use strict';

const crypto = require('crypto');

const VERIFY_TIMEOUT_MS = 6000;
const CACHE_MS = 5 * 60 * 1000;
const tokenCache = new Map();

function bearerToken(req) {
  const value = String((req.headers && req.headers.authorization) || '').trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function allowedEmails() {
  return new Set(
    String(process.env.ADMIN_EMAIL || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function tokenKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function lookupFirebaseUser(idToken) {
  const apiKey = String(process.env.FIREBASE_WEB_API_KEY || '').trim();
  if (!apiKey) throw new Error('firebase_auth_not_configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
        cache: 'no-store',
        signal: controller.signal,
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data || !Array.isArray(data.users) || !data.users[0]) {
      throw new Error('invalid_firebase_token');
    }
    return data.users[0];
  } finally {
    clearTimeout(timer);
  }
}

async function authorizeAdmin(req) {
  const token = bearerToken(req);
  if (!token || token.length > 8192) return { ok: false, status: 401, error: 'Google sign-in required' };

  // Explicit opt-in exists only for isolated local regression tests. Production
  // deployments must leave ALLOW_LEGACY_ADMIN_TOKEN unset.
  const legacyEnabled = String(process.env.ALLOW_LEGACY_ADMIN_TOKEN || '').toLowerCase() === 'true';
  const legacyToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (legacyEnabled && legacyToken && token === legacyToken) {
    return { ok: true, email: 'local-regression@test.invalid', uid: 'local-regression', provider: 'test' };
  }

  const key = tokenKey(token);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let user;
  try {
    user = await lookupFirebaseUser(token);
  } catch (_) {
    return { ok: false, status: 401, error: 'Google session is invalid or expired' };
  }

  const email = String(user.email || '').trim().toLowerCase();
  const providers = Array.isArray(user.providerUserInfo) ? user.providerUserInfo : [];
  const googleProvider = providers.some((provider) =>
    provider && provider.providerId === 'google.com' &&
    String(provider.email || email).trim().toLowerCase() === email
  );
  const allowed = allowedEmails();

  if (!email || user.disabled || user.emailVerified !== true || !googleProvider || !allowed.has(email)) {
    return { ok: false, status: 403, error: 'This Google account is not authorized' };
  }

  const result = {
    ok: true,
    email,
    uid: String(user.localId || ''),
    provider: 'google.com',
  };
  tokenCache.set(key, { expiresAt: Date.now() + CACHE_MS, result });
  if (tokenCache.size > 100) tokenCache.delete(tokenCache.keys().next().value);
  return result;
}

module.exports = { authorizeAdmin };
