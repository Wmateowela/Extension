'use strict';

const { isAllowedRequestOrigin, setCorsHeaders, sendJson, readJsonBody, getClientIp } = require('../lib/http');
const { checkRateLimit } = require('../lib/rate-limit');
const { authorizeAdmin } = require('../lib/admin-auth');
const {
  VERSION_CONFIG_KEY,
  DEFAULT_DISCORD_URL,
  normalizeVersionString,
  getUser,
  getUsers,
  patchUser,
  patchUsersMulti,
  getVersionConfig,
  saveVersionConfig,
} = require('../lib/firebase');

const SENSITIVE_LEGACY_FIELD = ['coo', 'kies'].join('');

function inferUserId(key, user) {
  if (user && Number(user.userId)) return Number(user.userId);
  const m = String(key || '').match(/^(?:roblox_|[a-zA-Z0-9_-]+_)(\d{3,20})$/);
  return m ? Number(m[1]) : 0;
}

async function resolveTargets(key, userId, installationId) {
  const users = await getUsers();
  const direct = (key && users[key]) || null;
  const id = Number(userId) || inferUserId(key, direct) || 0;
  let inst = String(installationId || (direct && direct.installationId) || '').trim();

  const keys = new Set();
  if (key) keys.add(String(key));
  if (id) keys.add('roblox_' + id);
  if (inst) keys.add(inst);
  if (id && inst) keys.add(inst + '_' + id);

  let baseRecord = direct && typeof direct === 'object' ? Object.assign({}, direct) : {};

  for (const [candidateKey, user] of Object.entries(users)) {
    if (!user || typeof user !== 'object') continue;
    const candId = inferUserId(candidateKey, user);
    const candInst = String(user.installationId || '').trim();
    const matched =
      (id && candId === id) ||
      (inst && (candInst === inst || candidateKey === inst || candidateKey.startsWith(inst + '_'))) ||
      (key && (candidateKey === String(key) || String(user.key || '') === String(key)));
    if (matched) {
      keys.add(candidateKey);
      if (!inst && candInst) inst = candInst;
      if (Number(user.lastSeen || 0) >= Number(baseRecord.lastSeen || 0)) {
        baseRecord = Object.assign({}, baseRecord, user);
      } else {
        baseRecord = Object.assign({}, user, baseRecord);
      }
    }
  }

  if (id && inst) keys.add(inst + '_' + id);
  if (id) keys.add('roblox_' + id);

  return {
    keys: Array.from(keys),
    users,
    id: id || inferUserId(key, baseRecord) || 0,
    inst: inst || String(baseRecord.installationId || '').trim(),
    baseRecord,
  };
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

  const rate = checkRateLimit('admin:' + (getClientIp(req) || 'unknown'), {
    maxRequests: 90,
    windowMs: 60 * 1000,
  });
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: 'Too many admin requests' });
  }

  const auth = await authorizeAdmin(req);
  if (!auth.ok) {
    return sendJson(res, auth.status || 401, { ok: false, error: auth.error || 'Admin authentication required' });
  }

  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
  }

  const action = String(body.action || '');
  const key = String(body.key || '');

  if (action === 'list') {
    try {
      const users = await getUsers();
      const safeUsers = {};
      const cleanup = [];
      const now = Date.now();
      const groups = {};

      const rawVersionCfg = users[VERSION_CONFIG_KEY];
      let allowedVersions = ['1.0'];
      let discordUrl = DEFAULT_DISCORD_URL;
      if (rawVersionCfg && typeof rawVersionCfg === 'object' && Array.isArray(rawVersionCfg.allowedVersions)) {
        allowedVersions = Array.from(
          new Set(rawVersionCfg.allowedVersions.map(normalizeVersionString).filter(Boolean))
        );
        discordUrl = String(rawVersionCfg.discordUrl || DEFAULT_DISCORD_URL).trim() || DEFAULT_DISCORD_URL;
      } else {
        cleanup.push(saveVersionConfig(['1.0'], DEFAULT_DISCORD_URL).catch(() => false));
      }

      for (const [userKey, value] of Object.entries(users)) {
        if (userKey === VERSION_CONFIG_KEY) continue;
        if (!value || typeof value !== 'object') continue;
        const uid = inferUserId(userKey, value);
        const identity = uid ? 'roblox_' + uid : userKey;
        if (!groups[identity]) groups[identity] = [];
        groups[identity].push({ userKey, value, uid });
      }

      for (const [identity, entries] of Object.entries(groups)) {
        // Check if deleted more recently than lastSeen
        const isDeleted = entries.some((e) => e.value.deleted && (!e.value.lastSeen || Number(e.value.deletedAt || 0) >= Number(e.value.lastSeen || 0)));
        if (isDeleted) continue;

        // Sort oldest to newest by lastSeen so newest fields win
        entries.sort((a, b) => (Number(a.value.lastSeen) || 0) - (Number(b.value.lastSeen) || 0));

        let merged = {};
        let bestBanEntry = null;
        let bestModTs = -1;

        for (const { userKey, value, uid } of entries) {
          if (value.deleted) continue;
          const copy = Object.assign({}, value);
          if (Object.prototype.hasOwnProperty.call(copy, SENSITIVE_LEGACY_FIELD)) {
            cleanup.push(patchUser(userKey, { [SENSITIVE_LEGACY_FIELD]: null }).catch(() => false));
            delete copy[SENSITIVE_LEGACY_FIELD];
          }
          const exp = Number(copy.banExpiresAt) || 0;
          if (copy.banned && exp && exp <= now) {
            copy.banned = false;
            copy.banReason = '';
            copy.bannedAt = null;
            copy.banExpiresAt = 0;
            cleanup.push(patchUser(userKey, { banned: false, banReason: '', bannedAt: null, banExpiresAt: 0 }).catch(() => false));
          }

          const bannedAt = Number(copy.bannedAt) || (copy.banned ? 1 : 0);
          const unbannedAt = Number(copy.unbannedAt) || 0;
          const modTs = Math.max(bannedAt, unbannedAt);
          if (modTs > bestModTs || (modTs === bestModTs && copy.banned)) {
            bestModTs = modTs;
            bestBanEntry = { banned: Boolean(copy.banned) && !(unbannedAt > bannedAt), banReason: copy.banReason || '', bannedAt: copy.bannedAt || null, banExpiresAt: Number(copy.banExpiresAt) || 0, unbannedAt };
          }

          // Preserve non-empty fields when merging
          for (const [k, v] of Object.entries(copy)) {
            if (v !== undefined && v !== null && v !== '') {
              merged[k] = v;
            } else if (!(k in merged)) {
              merged[k] = v;
            }
          }
          if (uid && !merged.userId) merged.userId = uid;
        }

        if (!Object.keys(merged).length) continue;

        if (bestBanEntry && bestBanEntry.banned) {
          merged.banned = true;
          merged.banReason = bestBanEntry.banReason || '';
          merged.bannedAt = bestBanEntry.bannedAt || null;
          merged.banExpiresAt = bestBanEntry.banExpiresAt || 0;
          merged.unbannedAt = 0;
        } else {
          merged.banned = false;
          merged.banReason = '';
          merged.bannedAt = null;
          merged.banExpiresAt = 0;
        }

        merged._dbKey = identity;
        if (!merged.installationId) {
          merged.installationId = identity;
        }

        // Auto-sync any out-of-sync sibling records in Firebase
        for (const { userKey, value } of entries) {
          if (Boolean(value.banned) !== Boolean(merged.banned)) {
            cleanup.push(patchUser(userKey, {
              banned: merged.banned,
              banReason: merged.banReason,
              bannedAt: merged.bannedAt,
              banExpiresAt: merged.banExpiresAt,
            }).catch(() => false));
          }
        }

        safeUsers[identity] = merged;
      }

      await Promise.all(cleanup);
      return sendJson(res, 200, { ok: true, users: safeUsers, allowedVersions, discordUrl });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
    }
  }

  if (action === 'versions') {
    try {
      const subAction = String(body.subAction || 'set').trim();
      const currentCfg = (await getVersionConfig(true)) || { allowedVersions: ['1.0'], discordUrl: DEFAULT_DISCORD_URL };
      let list = Array.isArray(currentCfg.allowedVersions) ? currentCfg.allowedVersions.slice() : [];
      const version = normalizeVersionString(body.version);
      if (subAction === 'set') {
        if (!version || !/^[0-9a-zA-Z._-]{1,32}$/.test(version)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid version format' });
        }
        list = [version];
      } else if (subAction === 'add') {
        if (!version || !/^[0-9a-zA-Z._-]{1,32}$/.test(version)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid version format' });
        }
        if (!list.includes(version)) list.push(version);
      } else if (subAction === 'remove') {
        list = list.filter((v) => v !== version);
      } else if (Array.isArray(body.versions)) {
        list = Array.from(
          new Set(body.versions.map(normalizeVersionString).filter((v) => v && /^[0-9a-zA-Z._-]{1,32}$/.test(v)))
        );
      }
      const saved = await saveVersionConfig(list, body.discordUrl || currentCfg.discordUrl || DEFAULT_DISCORD_URL);
      try {
        const allUsers = await getUsers();
        const activeKeys = Object.keys(allUsers || {}).filter((k) => k && k !== VERSION_CONFIG_KEY);
        if (activeKeys.length) {
          await patchUsersMulti(activeKeys, { versionCheckAt: saved.updatedAt });
        }
      } catch (_) { /* best effort live broadcast */ }
      return sendJson(res, 200, {
        ok: true,
        action: 'versions',
        allowedVersions: saved.allowedVersions,
        discordUrl: saved.discordUrl,
      });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
    }
  }

  if (!key || typeof key !== 'string' || key.length > 130) {
    return sendJson(res, 400, { ok: false, error: 'Invalid key' });
  }

  if (action === 'delete') {
    let affected = 0;
    try {
      const { keys, id, inst } = await resolveTargets(key, body.userId, body.installationId);
      affected = keys.length;
      const now = Date.now();
      await patchUsersMulti(keys, {
        deleted: true,
        deletedAt: now,
        userId: id || undefined,
        installationId: inst || undefined,
        banned: false,
        banReason: '',
        banExpiresAt: 0,
        [SENSITIVE_LEGACY_FIELD]: null,
      });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
    }
    return sendJson(res, 200, { ok: true, action: 'deleted', affected });
  }

  if (action === 'ban') {
    const reason = String(body.reason || '').slice(0, 200);
    const durationMs = Math.max(0, Math.min(Number(body.durationMs) || 0, 365 * 24 * 60 * 60 * 1000));
    const now = Date.now();
    const expiresAt = durationMs ? now + durationMs : 0;
    let affected = 0;
    try {
      const { keys, id, inst, baseRecord } = await resolveTargets(key, body.userId, body.installationId);
      affected = keys.length;
      await patchUsersMulti(keys, {
        userId: id || baseRecord.userId || undefined,
        installationId: inst || baseRecord.installationId || undefined,
        username: baseRecord.username || undefined,
        displayName: baseRecord.displayName || undefined,
        banned: true,
        banReason: reason,
        bannedAt: now,
        banExpiresAt: expiresAt,
        unbannedAt: 0,
        deleted: false,
      });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
    }
    return sendJson(res, 200, { ok: true, action: 'banned', expiresAt, affected });
  }

  if (action === 'unban') {
    let affected = 0;
    const now = Date.now();
    try {
      const { keys, id, inst, baseRecord } = await resolveTargets(key, body.userId, body.installationId);
      affected = keys.length;
      await patchUsersMulti(keys, {
        userId: id || baseRecord.userId || undefined,
        installationId: inst || baseRecord.installationId || undefined,
        banned: false,
        banReason: '',
        bannedAt: null,
        banExpiresAt: 0,
        unbannedAt: now,
      });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
    }
    return sendJson(res, 200, { ok: true, action: 'unbanned', affected });
  }

  if (action === 'command') {
    const cmdType = String(body.cmdType || '').trim();
    const validCmds = new Set(['set_robux', 'reset_data', 'set_badges', 'toast']);
    if (!validCmds.has(cmdType)) {
      return sendJson(res, 400, { ok: false, error: 'Invalid command type' });
    }
    const now = Date.now();
    const commandObj = {
      id: 'cmd_' + now + '_' + Math.random().toString(36).slice(2, 8),
      type: cmdType,
      at: now,
    };
    if (cmdType === 'set_robux') {
      const amount = body.amount === null || body.amount === '' ? null : Math.max(0, Math.min(999999999, Math.floor(Number(body.amount) || 0)));
      commandObj.amount = amount;
    } else if (cmdType === 'set_badges') {
      commandObj.plus = Boolean(body.plus);
      commandObj.verified = Boolean(body.verified);
    } else if (cmdType === 'toast') {
      commandObj.message = String(body.message || '').slice(0, 250);
    }
    let affected = 0;
    try {
      const { keys } = await resolveTargets(key, body.userId, body.installationId);
      affected = keys.length;
      await patchUsersMulti(keys, {
        remoteCommand: commandObj,
      });
    } catch (_) {
      return sendJson(res, 502, { ok: false, error: 'Storage unavailable' });
    }
    return sendJson(res, 200, { ok: true, action: 'command', command: commandObj, affected });
  }

  if (action === 'check-ban') {
    try {
      const user = await getUser(key);
      return sendJson(res, 200, {
        ok: true,
        banned: Boolean(user && user.banned),
        reason: (user && user.banReason) || '',
        expiresAt: Number(user && user.banExpiresAt) || 0,
      });
    } catch (_) {
      return sendJson(res, 200, { ok: true, banned: false, reason: '' });
    }
  }

  return sendJson(res, 400, { ok: false, error: 'Unknown action' });
}

module.exports = handler;
