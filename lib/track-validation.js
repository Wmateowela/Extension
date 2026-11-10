'use strict';

/**
 * Validation for POST /api/track payloads.
 *
 * Strict allowlist: unknown fields are rejected, so a compromised page cannot
 * smuggle session credentials, tokens or headers into the database.
 */

const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_FIELDS = new Set([
  'event',
  'installationId',
  'extensionVersion',
  'timestamp',
  'context',
  'page',
  'userId',
  'username',
  'displayName',
  'profileUrl',
  'avatarUrl',
  'realRobuxBalance',
  'robloxPlusStatus',
  'accountCreationDate',
  'accountAge',
  'language',
  'timezone',
]);

const VALID_EVENTS = new Set(['heartbeat', 'offline', 'install', 'update']);
const VALID_CONTEXTS = new Set(['roblox', 'install']);

const FORBIDDEN_VALUE_PATTERNS = [
  new RegExp('\\.ROBLO' + 'SECURITY', 'i'),
  /discord(?:app)?\.com\/api\/webhooks/i,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  new RegExp('\\bCoo' + 'kie\\s*:', 'i'),
  /\bAuthorization\s*:/i,
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidRobloxProfileUrl(urlStr, expectedUserId) {
  if (typeof urlStr !== 'string' || urlStr.length < 20 || urlStr.length > 200) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'www.roblox.com' && parsed.hostname !== 'roblox.com') return false;
    const match = parsed.pathname.match(/^\/users\/(\d+)\/profile\/?$/);
    if (!match) return false;
    if (expectedUserId && String(match[1]) !== String(expectedUserId)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function isValidAvatarUrl(urlStr) {
  if (urlStr === '') return true;
  if (typeof urlStr !== 'string' || urlStr.length > 500) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'roblox.com' ||
      host.endsWith('.roblox.com') ||
      host === 'rbxcdn.com' ||
      host.endsWith('.rbxcdn.com')
    );
  } catch (_) {
    return false;
  }
}

function containsForbiddenContent(value) {
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
}

function validateTrackPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'Invalid JSON payload' };
  }

  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.length > ALLOWED_FIELDS.size) {
    return { ok: false, error: 'Invalid field count' };
  }

  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, error: 'Unknown field rejected' };
    }
    if (typeof payload[key] === 'string' && containsForbiddenContent(payload[key])) {
      return { ok: false, error: 'Forbidden content rejected' };
    }
  }

  // --- required core fields -------------------------------------------------

  const event = String(payload.event || '').toLowerCase();
  if (!VALID_EVENTS.has(event)) {
    return { ok: false, error: 'Invalid event' };
  }

  const context = String(payload.context || '').toLowerCase();
  if (!VALID_CONTEXTS.has(context)) {
    return { ok: false, error: 'Invalid context' };
  }
  if (context === 'install' && event !== 'install' && event !== 'update') {
    return { ok: false, error: 'Install context requires install/update event' };
  }
  if (context === 'roblox' && event !== 'heartbeat' && event !== 'offline' && event !== 'update') {
    return { ok: false, error: 'Roblox context requires heartbeat/offline/update event' };
  }

  const installationId = payload.installationId;
  if (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{12,64}$/.test(installationId)) {
    return { ok: false, error: 'Invalid installationId' };
  }

  const extensionVersion = payload.extensionVersion;
  if (
    typeof extensionVersion !== 'string' ||
    !/^\d+(?:\.\d+){0,3}(-[a-zA-Z0-9.]+)?$/.test(extensionVersion.trim()) ||
    extensionVersion.length > 24
  ) {
    return { ok: false, error: 'Invalid extensionVersion' };
  }

  const rawTimestamp = payload.timestamp;
  if (typeof rawTimestamp !== 'string' && typeof rawTimestamp !== 'number') {
    return { ok: false, error: 'Invalid timestamp' };
  }
  if (typeof rawTimestamp === 'string' && rawTimestamp.length > 64) {
    return { ok: false, error: 'Invalid timestamp length' };
  }
  const parsedTime = new Date(rawTimestamp).getTime();
  if (!Number.isFinite(parsedTime) || parsedTime <= 0) {
    return { ok: false, error: 'Invalid timestamp value' };
  }

  // --- optional page --------------------------------------------------------

  let page = '';
  if (payload.page !== undefined) {
    if (typeof payload.page !== 'string' || payload.page.length > 200) {
      return { ok: false, error: 'Invalid page' };
    }
    page = payload.page.trim();
    if (page && (!page.startsWith('/') || /[\u0000-\u001F\u007F]/.test(page))) {
      return { ok: false, error: 'Invalid page path' };
    }
  }

  // --- optional account fields ---------------------------------------------

  const data = {
    event,
    context,
    installationId,
    extensionVersion: extensionVersion.trim(),
    timestamp: new Date(parsedTime).toISOString(),
    page,
  };

  if (payload.userId !== undefined) {
    const userId = Number(payload.userId);
    if (!Number.isInteger(userId) || userId < 1 || userId > 999999999999999) {
      return { ok: false, error: 'Invalid userId' };
    }
    data.userId = userId;
  }

  if (payload.username !== undefined) {
    const username = payload.username;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{2,50}$/.test(username.trim())) {
      return { ok: false, error: 'Invalid username' };
    }
    data.username = username.trim();
  }

  if (payload.displayName !== undefined) {
    const displayName = payload.displayName;
    if (typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.trim().length > 50) {
      return { ok: false, error: 'Invalid displayName' };
    }
    data.displayName = displayName.trim();
  }

  if (payload.profileUrl !== undefined) {
    if (!isValidRobloxProfileUrl(payload.profileUrl, data.userId)) {
      return { ok: false, error: 'Invalid profileUrl' };
    }
    data.profileUrl = String(payload.profileUrl).trim();
  }

  if (payload.avatarUrl !== undefined) {
    if (typeof payload.avatarUrl !== 'string' || !isValidAvatarUrl(payload.avatarUrl)) {
      return { ok: false, error: 'Invalid avatarUrl' };
    }
    data.avatarUrl = payload.avatarUrl.trim();
  }

  if (payload.realRobuxBalance !== undefined) {
    const balance = payload.realRobuxBalance;
    if (!Number.isInteger(balance) || balance < 0 || balance > 1000000000000) {
      return { ok: false, error: 'Invalid realRobuxBalance' };
    }
    data.realRobuxBalance = balance;
  }

  if (payload.robloxPlusStatus !== undefined) {
    if (typeof payload.robloxPlusStatus !== 'boolean') {
      return { ok: false, error: 'Invalid robloxPlusStatus' };
    }
    data.robloxPlusStatus = payload.robloxPlusStatus;
  }

  if (payload.accountCreationDate !== undefined) {
    if (
      typeof payload.accountCreationDate !== 'string' ||
      payload.accountCreationDate.trim().length < 1 ||
      payload.accountCreationDate.trim().length > 64
    ) {
      return { ok: false, error: 'Invalid accountCreationDate' };
    }
    data.accountCreationDate = payload.accountCreationDate.trim();
  }

  if (payload.accountAge !== undefined) {
    if (
      typeof payload.accountAge !== 'string' ||
      payload.accountAge.trim().length < 1 ||
      payload.accountAge.trim().length > 64
    ) {
      return { ok: false, error: 'Invalid accountAge' };
    }
    data.accountAge = payload.accountAge.trim();
  }

  if (payload.language !== undefined) {
    if (typeof payload.language !== 'string' || payload.language.trim().length > 20) {
      return { ok: false, error: 'Invalid language' };
    }
    data.language = payload.language.trim();
  }

  if (payload.timezone !== undefined) {
    if (typeof payload.timezone !== 'string' || payload.timezone.trim().length > 64) {
      return { ok: false, error: 'Invalid timezone' };
    }
    data.timezone = payload.timezone.trim();
  }

  return { ok: true, data };
}

module.exports = {
  MAX_BODY_BYTES,
  ALLOWED_FIELDS,
  validateTrackPayload,
};
