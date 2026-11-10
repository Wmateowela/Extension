'use strict';

const crypto = require('crypto');

const DEFAULT_DB_URL =
  'https://aies-server-side-default-rtdb.asia-southeast1.firebasedatabase.app';

const REQUEST_TIMEOUT_MS = 6000;
let serviceTokenCache = { token: '', expiresAt: 0 };

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function serviceAccountConfig() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.client_email && parsed.private_key ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function getServiceAccessToken() {
  const account = serviceAccountConfig();
  if (!account) return '';
  if (serviceTokenCache.token && serviceTokenCache.expiresAt > Date.now() + 60 * 1000) {
    return serviceTokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = String(account.token_uri || 'https://oauth2.googleapis.com/token');
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = header + '.' + claims;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature,
    }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('Firebase service account authentication failed');
  serviceTokenCache = {
    token: String(data.access_token),
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  return serviceTokenCache.token;
}

function getDatabaseUrl() {
  const raw = String(process.env.FIREBASE_DB_URL || DEFAULT_DB_URL).trim();
  return raw.replace(/\/+$/, '');
}

function authQuery() {
  if (serviceAccountConfig()) return '';
  const secret = String(process.env.FIREBASE_DB_SECRET || '').trim();
  return secret ? '?auth=' + encodeURIComponent(secret) : '';
}

function userUrl(key) {
  return (
    getDatabaseUrl() +
    '/users/' +
    encodeURIComponent(String(key)) +
    '.json' +
    authQuery()
  );
}

function usersUrl() {
  return getDatabaseUrl() + '/users.json' + authQuery();
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const accessToken = await getServiceAccessToken();
    const requestOptions = Object.assign({ cache: 'no-store' }, options || {});
    requestOptions.headers = Object.assign({}, (options && options.headers) || {});
    if (accessToken) requestOptions.headers.Authorization = 'Bearer ' + accessToken;
    const res = await fetch(url, Object.assign(requestOptions, {
      signal: controller.signal,
    }));
    clearTimeout(timer);

    if (!res.ok) {
      const error = new Error(
        res.status === 401 || res.status === 403
          ? 'firebase_permission_denied'
          : 'firebase_request_failed'
      );
      error.statusCode = res.status;
      throw error;
    }

    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function getUser(key) {
  const data = await requestJson(userUrl(key), { method: 'GET' });
  return data && typeof data === 'object' ? data : null;
}

async function getUsers() {
  const data = await requestJson(usersUrl(), { method: 'GET' });
  return data && typeof data === 'object' ? data : {};
}

async function writeUser(key, record) {
  await requestJson(userUrl(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  return true;
}

async function deleteUser(key) {
  await requestJson(userUrl(key), { method: 'DELETE' });
  return true;
}

async function patchUser(key, partial) {
  await requestJson(userUrl(key), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  return true;
}

async function patchUsersMulti(keys, partial) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (!list.length) return true;
  const multi = {};
  for (const k of list) {
    for (const [field, val] of Object.entries(partial || {})) {
      if (val === undefined) continue;
      multi[String(k) + '/' + field] = val;
    }
  }
  await requestJson(usersUrl(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(multi),
  });
  return true;
}

const VERSION_CONFIG_KEY = '__erx_versions__';
const DEFAULT_DISCORD_URL = 'https://discord.gg/479vyZRYA';
let versionCache = { at: 0, data: null };

function normalizeVersionString(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/^v+/i, '')
    .slice(0, 32);
}

async function getVersionConfig(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && versionCache.data && now - versionCache.at < 1500) {
    return versionCache.data;
  }
  try {
    const raw = await getUser(VERSION_CONFIG_KEY);
    if (raw && typeof raw === 'object' && Array.isArray(raw.allowedVersions)) {
      const cleaned = Array.from(
        new Set(raw.allowedVersions.map(normalizeVersionString).filter(Boolean))
      );
      const cfg = {
        allowedVersions: cleaned,
        discordUrl: String(raw.discordUrl || DEFAULT_DISCORD_URL).trim() || DEFAULT_DISCORD_URL,
        updatedAt: Number(raw.updatedAt) || 0,
      };
      versionCache = { at: now, data: cfg };
      return cfg;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

async function saveVersionConfig(allowedVersions, discordUrl) {
  const cleaned = Array.from(
    new Set((Array.isArray(allowedVersions) ? allowedVersions : []).map(normalizeVersionString).filter(Boolean))
  );
  const record = {
    allowedVersions: cleaned,
    discordUrl: String(discordUrl || DEFAULT_DISCORD_URL).trim() || DEFAULT_DISCORD_URL,
    updatedAt: Date.now(),
  };
  await writeUser(VERSION_CONFIG_KEY, record);
  versionCache = { at: Date.now(), data: record };
  return record;
}

module.exports = {
  DEFAULT_DB_URL,
  VERSION_CONFIG_KEY,
  DEFAULT_DISCORD_URL,
  normalizeVersionString,
  getDatabaseUrl,
  userUrl,
  usersUrl,
  getUser,
  getUsers,
  writeUser,
  deleteUser,
  patchUser,
  patchUsersMulti,
  getVersionConfig,
  saveVersionConfig,
};
