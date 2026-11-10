'use strict';

const {
  MAX_BODY_BYTES,
  isAllowedRequestOrigin,
  setCorsHeaders,
  sendJson,
  readJsonBody,
  getGeo,
} = require('../lib/http');
const { validateTrackPayload } = require('../lib/track-validation');
const { checkRateLimit } = require('../lib/rate-limit');
const {
  DEFAULT_DISCORD_URL,
  normalizeVersionString,
  getUser,
  writeUser,
  patchUser,
  getVersionConfig,
} = require('../lib/firebase');

const ACCOUNT_FIELDS = [
  'userId',
  'username',
  'displayName',
  'profileUrl',
  'avatarUrl',
  'realRobuxBalance',
  'robloxPlusStatus',
  'accountCreationDate',
  'accountAge',
];

function dbKey(installationId, userId) {
  return userId ? 'roblox_' + userId : installationId;
}

function mergeRecord(existing, data, geo, req) {
  const now = Date.now();
  const previous = existing || {};

  const previousFirstSeen = Number(previous.firstSeen);
  const firstSeen =
    Number.isFinite(previousFirstSeen) && previousFirstSeen > 0 ? previousFirstSeen : now;

  const record = {
    key: dbKey(data.installationId, data.userId),
    installationId: data.installationId,
    firstSeen,
    firstSeenIso: previous.firstSeenIso || new Date(now).toISOString(),
    lastSeen: now,
    lastSeenIso: new Date(now).toISOString(),
    lastEvent: data.event,
    online: data.event !== 'offline',
    context: data.context,
    hasRoblox: data.context === 'roblox' ? true : Boolean(previous.hasRoblox),
    page: data.page || previous.page || '',
    extensionVersion: data.extensionVersion,
    ip: geo.ip || previous.ip || '',
    countryCode: geo.countryCode || previous.countryCode || '',
    country: geo.country || previous.country || '',
    region: geo.region || previous.region || '',
    city: geo.city || previous.city || '',
    userAgent: String((req.headers && req.headers['user-agent']) || '').slice(0, 300),
    language: data.language || previous.language || '',
    timezone: data.timezone || previous.timezone || '',
    banned: Boolean(previous.banned),
    banReason: previous.banReason || '',
    banExpiresAt: Number(previous.banExpiresAt) || 0,
    remoteCommand: previous.remoteCommand || null,
    deleted: false,
  };

  for (const key of ACCOUNT_FIELDS) {
    if (data[key] !== undefined) {
      record[key] = data[key];
    } else if (previous[key] !== undefined) {
      record[key] = previous[key];
    }
  }

  return record;
}

async function handler(req, res) {
  setCorsHeaders(req, res);

  const origin = req.headers && req.headers.origin;
  if (origin && !isAllowedRequestOrigin(req)) {
    return sendJson(res, 403, { ok: false, error: 'Origin not allowed' });
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (!contentType.startsWith('application/json') && !contentType.startsWith('text/plain')) {
    return sendJson(res, 415, { ok: false, error: 'Unsupported content type' });
  }

  const contentLength = Number((req.headers && req.headers['content-length']) || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return sendJson(res, 413, { ok: false, error: 'Payload too large' });
  }

  const geo = getGeo(req);

  const ipRate = checkRateLimit('track-ip:' + (geo.ip || 'unknown'), {
    maxRequests: 600,
    windowMs: 60 * 1000,
  });
  if (!ipRate.allowed) {
    res.setHeader('Retry-After', String(ipRate.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: 'Too many requests' });
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const code = err && err.statusCode ? err.statusCode : 400;
    return sendJson(res, code, {
      ok: false,
      error: code === 413 ? 'Payload too large' : 'Invalid request body',
    });
  }

  const validation = validateTrackPayload(body);
  if (!validation.ok) {
    return sendJson(res, 400, { ok: false, error: 'Invalid request payload' });
  }

  const data = validation.data;

  const installRate = checkRateLimit('track-inst:' + data.installationId, {
    maxRequests: 240,
    windowMs: 60 * 1000,
  });
  if (!installRate.allowed) {
    res.setHeader('Retry-After', String(ipRate.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: 'Too many requests' });
  }

  const key = dbKey(data.installationId, data.userId);

  // Canonical Roblox key keeps one durable record per account. Fall back to
  // legacy installation keys only to migrate existing profile details.
  let existing = null;
  try {
    existing = await getUser(key);
  } catch (_) {
    existing = null;
  }
  if (!existing && data.userId) {
    try {
      existing = await getUser(data.installationId + '_' + data.userId);
      if (!existing) existing = await getUser(data.installationId);
    } catch (_) {
      existing = null;
    }
  }

  if (existing && existing.deleted) {
    return sendJson(res, 410, { ok: false, error: 'deleted' });
  }

  if (existing && existing.banned) {
    const expiresAt = Number(existing.banExpiresAt) || 0;
    if (!expiresAt || expiresAt > Date.now()) {
      const now = Date.now();
      const isOffline = data.event === 'offline';
      try {
        await patchUser(key, {
          lastSeen: now,
          lastSeenIso: new Date(now).toISOString(),
          lastEvent: data.event,
          online: !isOffline,
          page: data.page || existing.page || '',
          banned: true,
          banReason: existing.banReason || '',
          banExpiresAt: expiresAt,
        });
      } catch (_) { /* best effort presence update while banned */ }
      return sendJson(res, 403, {
        ok: false,
        error: 'banned',
        reason: existing.banReason || '',
        expiresAt,
        command: existing.remoteCommand || null,
      });
    }
    existing.banned = false;
    existing.banReason = '';
    existing.bannedAt = null;
    existing.banExpiresAt = 0;
  }

  const record = mergeRecord(existing, data, geo, req);
  if (data.userId && data.installationId && key !== data.installationId) {
    try {
      const legacy = await getUser(data.installationId);
      if (legacy && typeof legacy === 'object') {
        await patchUser(data.installationId, {
          userId: data.userId,
          lastSeen: record.lastSeen,
          lastSeenIso: record.lastSeenIso,
          lastEvent: record.lastEvent,
          online: record.online,
        });
      }
    } catch (_) { /* best effort sync */ }
  }

  try {
    await writeUser(key, record);
  } catch (_) {
    return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
  }

  const versionCfg = await getVersionConfig();
  if (versionCfg && Array.isArray(versionCfg.allowedVersions)) {
    const extVer = normalizeVersionString(data.extensionVersion);
    if (!versionCfg.allowedVersions.includes(extVer)) {
      return sendJson(res, 426, {
        ok: false,
        error: 'version_expired',
        version: extVer,
        allowedVersions: versionCfg.allowedVersions,
        discordUrl: versionCfg.discordUrl || DEFAULT_DISCORD_URL,
        message: 'Version expire please get it from the discord',
      });
    }
  }

  const responsePayload = { ok: true };
  if (record.remoteCommand && record.remoteCommand.id) {
    responsePayload.command = record.remoteCommand;
  }
  return sendJson(res, 200, responsePayload);
}

module.exports = handler;
