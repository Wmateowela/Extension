'use strict';

const { sendJson } = require('../lib/http');

function clean(value, max) {
  return String(value || '').trim().slice(0, max || 300);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const firebaseConfig = {
    apiKey: clean(process.env.FIREBASE_WEB_API_KEY),
    authDomain: clean(process.env.FIREBASE_AUTH_DOMAIN),
    projectId: clean(process.env.FIREBASE_PROJECT_ID),
    appId: clean(process.env.FIREBASE_APP_ID),
  };
  if (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId) {
    return sendJson(res, 503, { ok: false, error: 'Firebase Auth is not configured' });
  }

  return sendJson(res, 200, {
    ok: true,
    firebaseConfig,
  });
}

module.exports = handler;
