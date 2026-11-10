'use strict';

/**
 * In-memory rate limiter and duplicate-event suppressor for /api/track.
 *
 * Note on serverless environments:
 * Warm Vercel function instances retain memory across invocations, providing
 * burst rate limiting and duplicate suppression without external state.
 */

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute window
const DEFAULT_MAX_REQUESTS = 10;     // max 10 requests per minute per client key
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes duplicate suppression
const MAX_BUCKETS = 2000;

const rateBuckets = new Map();  // key -> { count, resetAt }
const dedupeStore = new Map();  // key -> { hash, at }

function pruneMap(map, maxEntries) {
  if (map.size <= maxEntries) return;
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) map.delete(oldestKey);
}

function checkRateLimit(key, options = {}) {
  const now = Date.now();
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests || DEFAULT_MAX_REQUESTS;
  const safeKey = String(key || 'anonymous').slice(0, 128);

  let bucket = rateBuckets.get(safeKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 1, resetAt: now + windowMs };
    rateBuckets.set(safeKey, bucket);
    pruneMap(rateBuckets, MAX_BUCKETS);
    return {
      allowed: true,
      remaining: maxRequests - 1,
      retryAfterSec: 0,
    };
  }

  if (bucket.count >= maxRequests) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: maxRequests - bucket.count,
    retryAfterSec: 0,
  };
}

function isDuplicateEvent(clientKey, stateHash, options = {}) {
  const now = Date.now();
  const ttlMs = options.ttlMs || DEFAULT_DEDUPE_TTL_MS;
  const safeKey = String(clientKey || 'default').slice(0, 128);

  const prev = dedupeStore.get(safeKey);
  if (prev && prev.hash === stateHash && now - prev.at < ttlMs) {
    return true;
  }
  return false;
}

function recordEventHash(clientKey, stateHash) {
  const safeKey = String(clientKey || 'default').slice(0, 128);
  dedupeStore.set(safeKey, { hash: stateHash, at: Date.now() });
  pruneMap(dedupeStore, MAX_BUCKETS);
}

function resetRateLimitState() {
  rateBuckets.clear();
  dedupeStore.clear();
}

module.exports = {
  checkRateLimit,
  isDuplicateEvent,
  recordEventHash,
  resetRateLimitState,
};
