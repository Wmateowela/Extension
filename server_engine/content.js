/*
 * E.Roblox — content script (isolated world)
 *
 * 1) Swaps every visible Robux balance for the amount set in the popup:
 *    - navbar            #nav-robux-amount
 *    - /upgrades/robux   both big + small balance spans
 *    - /transactions     "My Balance: 678"
 * 2) Kills the browser "Open Roblox?" prompt on friend rows / the profile
 *    "Send" button and opens a custom "Send Robux" modal instead.
 * 3) On a successful (preview) send it injects a native-looking transaction
 *    row into the /transactions table — with the recipient's avatar + name,
 *    the logged-in user's avatar + username, the current date and the amount.
 */
(() => {
  'use strict';

  /* ================================ config ============================ */

  const MODAL_ID = 'erx-modal-host';
  const TOAST_ID = 'erx-toast-host';
  const MARK = 'data-erx-real';
  const MAX_TX = 60;
  const BAN_OVERLAY_ID = 'erx-ban-screen';
  const BAN_NOTICE_ID = 'erx-ban-notice';
  let banTimer = 0;
  let isBanned = false;

  function formatBanCountdown(expiresAt) {
    if (!expiresAt) return 'Permanent Ban';
    const sec = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (d ? d + 'd ' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function renderBanNoticeOnPage(reason, expiresAt) {
    let host = document.getElementById(BAN_NOTICE_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = BAN_NOTICE_ID;
      host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;width:320px;padding:14px 16px;border-radius:14px;background:linear-gradient(145deg,rgba(24,8,12,0.96),rgba(12,13,19,0.98));border:1.5px solid rgba(255,64,87,0.65);box-shadow:0 18px 42px rgba(0,0,0,0.65),0 0 24px rgba(255,64,87,0.22);color:#f8fafc;font-family:"Builder Sans","Segoe UI",system-ui,sans-serif;pointer-events:none;backdrop-filter:blur(12px);';
      (document.body || document.documentElement).appendChild(host);
    }
    const safeReason = String(reason || 'Restricted by administrator.');
    const timerStr = formatBanCountdown(expiresAt);
    host.innerHTML = '';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
    const badge = document.createElement('span');
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#ff4d6d;background:rgba(255,77,109,0.14);border:1px solid rgba(255,77,109,0.35);padding:3px 8px;border-radius:999px;';
    badge.textContent = '🚫 EXTENSION BANNED';
    const timerEl = document.createElement('span');
    timerEl.setAttribute('data-erx-ban-timer', '1');
    timerEl.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:11.5px;font-weight:700;color:#fda4af;';
    timerEl.textContent = timerStr;
    top.appendChild(badge);
    top.appendChild(timerEl);

    const rBox = document.createElement('div');
    rBox.style.cssText = 'font-size:12.5px;font-weight:600;color:#ffe4e6;line-height:1.4;margin-bottom:6px;word-break:break-word;';
    rBox.textContent = 'Reason: ' + safeReason;

    const foot = document.createElement('div');
    foot.style.cssText = 'font-size:10.5px;color:#94a3b8;line-height:1.35;';
    foot.textContent = 'All NMC_PATHAN features & customizations have been reset and disabled.';

    host.appendChild(top);
    host.appendChild(rBox);
    host.appendChild(foot);
  }

  function removeBanNoticeFromPage() {
    const host = document.getElementById(BAN_NOTICE_ID);
    if (host) host.remove();
  }

  function resetAllUiAndDataOnBan() {
    try {
      state.fake = null;
      state.txs = [];
      state.purchasedItems = [];
      state.purchasedDetails = [];
      state.equippedCatalogItem = null;
      state.robloxPlusEnabled = false;
      state.verifiedBadgeEnabled = false;
      state.robloxPlusConfigured = true;
      state.verifiedBadgeConfigured = true;

      setCachedPurchasedItems([]);
      setCachedPurchasedDetails([]);
      setCachedEquippedCatalogItem(null);

      restoreAmounts();
      try {
        closeInjectedTransfersView(true);
        document.querySelectorAll('[' + ERX_TRANSFER_OPTION + ']').forEach((n) => n.remove());
        document.querySelectorAll('tr[data-erx-tx]').forEach((n) => n.remove());
      } catch (_) { /* noop */ }
      try {
        cancelLiveTryOnRefresh();
        restoreAvatarPreview();
        document.querySelectorAll('[data-erx-inventory-item]').forEach((n) => n.remove());
      } catch (_) { /* noop */ }
      try {
        restoreCatalogOwnershipDOM();
      } catch (_) { /* noop */ }
      try {
        document.querySelectorAll(BADGE_SLOT_SELECTOR).forEach((n) => n.remove());
        document.querySelectorAll('.' + NATIVE_BADGE_HIDDEN_CLASS).forEach((n) => n.classList.remove(NATIVE_BADGE_HIDDEN_CLASS));
      } catch (_) { /* noop */ }
      try { closeModal(); } catch (_) { /* noop */ }
      try { closePayoutModal(); } catch (_) { /* noop */ }
      try { closeCatalogBuyModal(); } catch (_) { /* noop */ }
      try { closeCatalogSuccessModal(); } catch (_) { /* noop */ }
      try { closeInsufficientRobuxModal(); } catch (_) { /* noop */ }
    } catch (_) { /* noop */ }
  }

  // Version enforcement is deliberately non-destructive. It removes only the
  // extension's current DOM changes while preserving the owner's saved data so
  // a legitimate update can resume without losing settings or history.
  function suspendExtensionUiForVersion() {
    try {
      restoreAmounts();
      closeInjectedTransfersView(true);
      document.querySelectorAll('[' + ERX_TRANSFER_OPTION + ']').forEach((node) => node.remove());
      document.querySelectorAll('tr[data-erx-tx]').forEach((node) => node.remove());
      cancelLiveTryOnRefresh();
      restoreAvatarPreview();
      document.querySelectorAll('[data-erx-inventory-item]').forEach((node) => node.remove());
      restoreCatalogOwnershipDOM();
      document.querySelectorAll(BADGE_SLOT_SELECTOR).forEach((node) => node.remove());
      document.querySelectorAll('.' + NATIVE_BADGE_HIDDEN_CLASS).forEach((node) => node.classList.remove(NATIVE_BADGE_HIDDEN_CLASS));
      closeModal();
      closePayoutModal();
      closeCatalogBuyModal();
      closeCatalogSuccessModal();
      closeInsufficientRobuxModal();
    } catch (_) { /* UI cleanup is best effort */ }
  }

  function renderVersionExpiredNoticeOnPage(expiredVer, discordUrl) {
    removeBanNoticeFromPage();
    let host = document.getElementById('erx-version-notice');
    if (!host) {
      host = document.createElement('div');
      host.id = 'erx-version-notice';
      host.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483646;width:min(430px,calc(100vw - 32px));padding:24px;border-radius:18px;background:linear-gradient(145deg,rgba(14,16,34,0.985),rgba(10,12,24,0.99));border:1.5px solid rgba(88,101,242,0.8);box-shadow:0 28px 90px rgba(0,0,0,0.78),0 0 36px rgba(88,101,242,0.3);color:#f8fafc;font-family:"Builder Sans","Segoe UI",system-ui,sans-serif;pointer-events:auto;backdrop-filter:blur(16px);';
      (document.body || document.documentElement).appendChild(host);
    }
    const safeUrl = String(discordUrl || 'https://discord.gg/479vyZRYA');
    const verLabel = expiredVer ? 'v' + String(expiredVer).replace(/^v+/i, '') : 'Outdated';
    host.innerHTML = '';

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
    const badge = document.createElement('span');
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#a5b4fc;background:rgba(88,101,242,0.2);border:1px solid rgba(88,101,242,0.45);padding:3px 9px;border-radius:999px;';
    badge.textContent = '⚠️ VERSION EXPIRE';
    const verEl = document.createElement('span');
    verEl.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:11.5px;font-weight:700;color:#fbbf24;';
    verEl.textContent = verLabel;
    top.appendChild(badge);
    top.appendChild(verEl);

    const msgBox = document.createElement('div');
    msgBox.style.cssText = 'font-size:12.5px;font-weight:600;color:#f1f5f9;line-height:1.45;margin-bottom:10px;';
    msgBox.textContent = 'This extension version is outdated. Join the official server to download the latest verified version.';

    const link = document.createElement('a');
    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:9px 12px;border-radius:10px;background:linear-gradient(135deg,#5865F2,#4752C4);color:#ffffff;font-size:12px;font-weight:800;text-decoration:none;box-shadow:0 6px 18px rgba(88,101,242,0.4);';
    link.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg><span>Get Latest Version on Discord</span>';

    host.appendChild(top);
    host.appendChild(msgBox);
    host.appendChild(link);
  }

  function removeVersionNoticeFromPage() {
    const vHost = document.getElementById('erx-version-notice');
    if (vHost) vHost.remove();
  }

  function applyBanScreen(data) {
    const versionExpired = Boolean(data && data._erxVersionExpired);
    if (versionExpired) {
      if (banTimer) clearInterval(banTimer);
      banTimer = 0;
      isBanned = true;
      document.documentElement.setAttribute('data-erx-banned', 'true');
      suspendExtensionUiForVersion();
      renderVersionExpiredNoticeOnPage(data._erxExpiredVersion, data._erxDiscordUrl);
      return;
    }
    removeVersionNoticeFromPage();

    const banned = Boolean(data && data._erxBanned);
    const expiresAt = Number(data && data._erxBanExpiresAt) || 0;
    if (banned && expiresAt && expiresAt <= Date.now()) {
      try { chrome.storage.local.set({ _erxBanned: false, _erxBanReason: '', _erxBanExpiresAt: 0 }); } catch (_) { /* noop */ }
      return applyBanScreen({ _erxBanned: false });
    }

    const overlay = document.getElementById(BAN_OVERLAY_ID);
    if (overlay) overlay.remove();

    if (!banned) {
      const wasBanned = isBanned;
      isBanned = false;
      if (banTimer) clearInterval(banTimer);
      banTimer = 0;
      document.documentElement.removeAttribute('data-erx-banned');
      removeBanNoticeFromPage();
      if (wasBanned) {
        state.robloxPlusConfigured = false;
        state.verifiedBadgeConfigured = false;
        loadStorage();
      }
      return;
    }

    const reasonText = String((data && data._erxBanReason) || 'Restricted by administrator.');
    isBanned = true;
    document.documentElement.setAttribute('data-erx-banned', 'true');
    resetAllUiAndDataOnBan();
    renderBanNoticeOnPage(reasonText, expiresAt);
    try {
      chrome.storage.local.remove(['robuxAmount', 'robloxPlusEnabled', 'verifiedBadgeEnabled', 'equippedCatalogItem'], () => {
        try {
          chrome.storage.local.set({
            transactions: [],
            purchasedCatalogItems: [],
            purchasedCatalogDetails: [],
          });
        } catch (_) { /* noop */ }
      });
    } catch (_) { /* noop */ }

    if (banTimer) clearInterval(banTimer);
    banTimer = setInterval(() => {
      if (expiresAt > 0 && expiresAt <= Date.now()) {
        try { chrome.storage.local.set({ _erxBanned: false, _erxBanReason: '', _erxBanExpiresAt: 0 }); } catch (_) { /* noop */ }
        applyBanScreen({ _erxBanned: false });
        return;
      }
      const timerNode = document.querySelector('#' + BAN_NOTICE_ID + ' [data-erx-ban-timer]');
      if (timerNode) timerNode.textContent = formatBanCountdown(expiresAt);
      else if (isBanned) renderBanNoticeOnPage(reasonText, expiresAt);
    }, 1000);
  }

  try {
    chrome.storage.local.get(['_erxBanned', '_erxBanReason', '_erxBanExpiresAt', '_erxVersionExpired', '_erxExpiredVersion', '_erxDiscordUrl'], applyBanScreen);
  } catch (_) { /* noop */ }

  /* ============================ instant cache ========================== */

  function getCachedPurchasedItems() {
    try {
      const raw = localStorage.getItem('erx_purchased_items');
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function setCachedPurchasedItems(list) {
    try {
      localStorage.setItem('erx_purchased_items', JSON.stringify(list || []));
    } catch (_) { /* noop */ }
  }

  function getCachedPurchasedDetails() {
    try {
      const raw = localStorage.getItem('erx_purchased_catalog_details');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function setCachedPurchasedDetails(list) {
    try {
      localStorage.setItem('erx_purchased_catalog_details', JSON.stringify(list || []));
    } catch (_) { /* noop */ }
  }

  function getCachedEquippedCatalogItem() {
    try {
      return localStorage.getItem('erx_equipped_catalog_item') || null;
    } catch (_) {
      return null;
    }
  }

  function setCachedEquippedCatalogItem(itemId) {
    try {
      if (itemId) localStorage.setItem('erx_equipped_catalog_item', String(itemId));
      else localStorage.removeItem('erx_equipped_catalog_item');
    } catch (_) { /* noop */ }
  }

  const state = {
    fake: null,        // number | null  (what the user typed in the popup)
    realDigits: null,  // "678"          (real balance digits, learned from the page)
    realText: null,    // "678"          (raw text of the real balance)
    me: null,          // { id, name, displayName, avatar }
    txs: [],           // saved "sent robux" rows
    purchasedItems: getCachedPurchasedItems(), // Synchronously loaded from local cache!
    purchasedDetails: getCachedPurchasedDetails(),
    equippedCatalogItem: getCachedEquippedCatalogItem(),
    robloxPlusEnabled: false,
    // Real account status is intentionally separate from the cosmetic toggle.
    // It becomes true only when Roblox itself renders a native Plus badge for
    // the authenticated account; extension-injected badges are excluded.
    realRobloxPlusStatus: false,
    verifiedBadgeEnabled: false,
    robloxPlusConfigured: false,
    verifiedBadgeConfigured: false,
  };

  // Instant pre-paint attribute to eliminate any 0.5s visual flash
  try {
    const earlyId = (location.pathname.match(/\/(?:catalog|bundles|items)\/(\d+)/i) || [])[1];
    if (earlyId && state.purchasedItems.includes(String(earlyId))) {
      document.documentElement.setAttribute('data-erx-owned', 'true');
    }
  } catch (_) { /* noop */ }

  /* ================================ utils ============================= */

  const digitsOf = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
  const fmt = (n) => Number(n).toLocaleString('en-US');

  function toAmount(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  function isNumericText(v) {
    const s = String(v == null ? '' : v).trim();
    return s.length > 0 && s.length <= 18 && /^[\d,\s]+$/.test(s) && /\d/.test(s);
  }

  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const val = attrs[key];
        if (val === null || val === undefined || val === false) continue;
        if (key === 'text') node.textContent = val;
        else if (key === 'class') node.className = val;
        else node.setAttribute(key, val);
      }
    }
    const kids = children === null || children === undefined ? [] : Array.isArray(children) ? children : [children];
    kids.forEach((child) => {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    });
    return node;
  }

  function writeText(el, text) {
    if (el.textContent === text) return;
    // keep React's own text node alive so later React updates still apply
    if (el.childNodes.length === 1 && el.firstChild.nodeType === Node.TEXT_NODE) {
      el.firstChild.nodeValue = text;
    } else {
      el.textContent = text;
    }
  }

  const profileUrl = (u) =>
    u && u.id ? 'https://www.roblox.com/users/' + u.id + '/profile' : 'https://www.roblox.com/home';

  /* ============================ page styling ========================== */

  const PAGE_CSS = `
    tr[data-erx-tx] { font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; }
    tr[data-erx-tx] .item-card-image img { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; }
    tr[data-erx-tx] .item-description,
    tr[data-erx-tx] .amount-display {
      font-family: inherit;
      font-size: 16px;
      font-weight: 400;
      line-height: normal;
      letter-spacing: normal;
    }
    tr[data-erx-tx] .amount-display {
      display: inline-flex;
      align-items: center;
      gap: 0;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    tr[data-erx-tx] .amount-display > span {
      margin: 0 !important;
      padding: 0 !important;
      letter-spacing: normal;
    }
    tr[data-erx-tx] .thumbnail-2d-container {
      position: relative;
      display: inline-block;
      overflow: hidden;
      background: rgba(27, 37, 75, 0.08);
    }
    .avatar-headshot tr[data-erx-tx] .thumbnail-2d-container,
    tr[data-erx-tx] .avatar-headshot .thumbnail-2d-container {
      border-radius: 50%;
    }
    tr[data-erx-tx] .thumbnail-2d-container.erx-loading {
      background: linear-gradient(90deg, rgba(27, 37, 75, 0.08) 0%, rgba(27, 37, 75, 0.2) 50%, rgba(27, 37, 75, 0.08) 100%) !important;
      background-size: 200% 100% !important;
      animation: erx-thumbnail-shimmer 1.2s infinite linear !important;
    }
    html.dark-mode tr[data-erx-tx] .thumbnail-2d-container,
    [data-theme="dark"] tr[data-erx-tx] .thumbnail-2d-container {
      background: #232527;
    }
    html.dark-mode tr[data-erx-tx] .thumbnail-2d-container.erx-loading,
    [data-theme="dark"] tr[data-erx-tx] .thumbnail-2d-container.erx-loading {
      background: linear-gradient(90deg, #25282e 0%, #3d424e 50%, #25282e 100%) !important;
      background-size: 200% 100% !important;
    }
    @keyframes erx-thumbnail-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    tr[data-erx-tx] .thumbnail-2d-container img {
      opacity: 1;
      transition: opacity 0.3s ease;
    }
    tr[data-erx-tx] .thumbnail-2d-container img.loading {
      opacity: 0 !important;
    }

    /* ---------------- catalog buy & purchased state ---------------- */
    /* Instantly hide unowned price row and buy buttons to eliminate any 0.5s load flash */
    html[data-erx-owned="true"] .price-row-container .item-info-row-container,
    html[data-erx-owned="true"] .price-row-container .price-info,
    html[data-erx-owned="true"] .price-row-container .item-price-value,
    html[data-erx-owned="true"] .price-row-container .shopping-cart-buy-button,
    html[data-erx-owned="true"] .price-row-container .item-purchase-btns-container,
    html[data-erx-owned="true"] .price-row-container .shopping-cart-add-remove-btn-container,
    html[data-erx-owned="true"] .price-row-container button,
    html[data-erx-owned="true"] .shopping-cart-buy-button,
    html[data-erx-owned="true"] .item-purchase-btns-container,
    html[data-erx-owned="true"] [data-testid*="buy-button"],
    html[data-erx-owned="true"] [data-testid*="purchase-button"],
    html[data-erx-owned="true"] [data-testid="item-details-buy-button"],
    html[data-erx-owned="true"] button.PurchaseButton {
      display: none !important;
    }

    /* Instant owned appearance via CSS before JS mutation */
    html[data-erx-owned="true"] .price-row-container:not(:has(#edit-avatar-button)) {
      min-height: 48px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
    }
    html[data-erx-owned="true"] .price-row-container:not(:has(#edit-avatar-button))::before {
      content: "This item is available in your inventory." !important;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 16px !important;
      font-weight: 500 !important;
      color: inherit !important;
      display: block !important;
      line-height: 40px !important;
    }

    html[data-erx-owned="true"] .item-details-creator-container:not(:has(.item-owned))::after {
      content: "✓ Item Owned" !important;
      display: inline-flex !important;
      align-items: center !important;
      margin-left: 12px !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      color: #00b06f !important;
      vertical-align: middle !important;
    }

    .erx-buy-btn-clicked,
    button.erx-buy-btn-clicked,
    .PurchaseButton.erx-buy-btn-clicked {
      background-color: #e7e9ec !important;
      background-image: none !important;
      border-color: #e7e9ec !important;
      color: #8b8d91 !important;
      opacity: 1 !important;
      pointer-events: none !important;
      cursor: default !important;
      box-shadow: none !important;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease !important;
    }
    .erx-buy-btn-clicked [data-testid="foundation-web-state-layer"] {
      background-color: transparent !important;
    }

    #erx-buy-item-modal,
    #erx-catalog-success-modal,
    #erx-insufficient-robux-modal {
      --color-common-backdrop: rgba(10, 10, 14, .5);
      --size-0: 0px;
      --size-50: 2px;
      --size-100: 4px;
      --alpha-color-shadow-subtle: rgba(0, 0, 0, .08);
      --size-250: 10px;
      --size-500: 20px;
      --size-400: 16px;
      --size-800: 32px;
      --size-1200: 48px;
      --size-1400: 56px;
      --size-300: 12px;
      position: fixed !important;
      inset: 0px !important;
      display: grid !important;
      overflow-y: auto !important;
      place-items: center !important;
      z-index: 10050 !important;
      background-color: var(--color-common-backdrop) !important;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      padding: 16px !important;
      box-sizing: border-box !important;
    }
    #erx-buy-item-modal .foundation-web-dialog-content,
    #erx-catalog-success-modal .foundation-web-dialog-content,
    #erx-insufficient-robux-modal .foundation-web-dialog-content {
      position: relative !important;
      width: 100% !important;
      box-sizing: border-box !important;
      border-radius: 16px !important;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18) !important;
    }
    #erx-buy-item-modal .foundation-web-dialog-content[data-size="Large"] {
      max-width: 640px !important;
      min-width: 300px !important;
      background-color: var(--color-surface-100, #f7f7f8) !important;
      border: 1px solid var(--color-stroke-muted, rgba(0, 0, 0, .12)) !important;
    }
    #erx-insufficient-robux-modal .foundation-web-dialog-content[data-size="Large"] {
      max-width: 640px !important;
      min-width: 300px !important;
      background-color: var(--color-surface-100, #f7f7f8) !important;
      border: 1px solid var(--color-stroke-muted, rgba(0, 0, 0, .12)) !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-body {
      display: flex !important;
      flex-direction: column !important;
      gap: 16px !important;
      padding: 20px 20px 12px !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-title {
      margin: 0 !important;
      padding-right: 42px !important;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 24px !important;
      font-weight: 700 !important;
      line-height: 32px !important;
      letter-spacing: -0.24px !important;
      text-transform: none !important;
      color: var(--color-content-emphasis, #202227) !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-item-row {
      display: flex !important;
      min-height: 145px !important;
      align-items: center !important;
      gap: 20px !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-thumbnail {
      display: flex !important;
      width: 145px !important;
      height: 145px !important;
      flex: 0 0 145px !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-thumbnail > img {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
      object-position: center !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-details {
      display: flex !important;
      min-width: 0 !important;
      flex-direction: column !important;
      gap: 8px !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-name {
      overflow-wrap: anywhere !important;
      font-size: 16px !important;
      font-weight: 500 !important;
      line-height: 22px !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-price {
      display: flex !important;
      align-items: center !important;
      font-size: 16px !important;
      font-weight: 400 !important;
      line-height: 22px !important;
    }
    #erx-insufficient-robux-modal .erx-insufficient-footer {
      padding: 0 20px 20px !important;
    }
    #erx-insufficient-robux-modal #erx-buy-robux-btn {
      display: flex !important;
      width: 100% !important;
      height: 48px !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 8px !important;
      box-sizing: border-box !important;
      border: 0 !important;
      border-radius: 8px !important;
      background: #335fff !important;
      color: #fff !important;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 16px !important;
      font-weight: 600 !important;
      line-height: 20px !important;
      text-decoration: none !important;
      cursor: pointer !important;
    }
    #erx-insufficient-robux-modal #erx-buy-robux-btn:hover {
      background: #2f58eb !important;
    }
    #erx-buy-item-modal .erx-buy-modal-body {
      display: flex !important;
      flex-direction: column !important;
      gap: 20px !important;
      padding: 20px !important;
    }
    #erx-buy-item-modal .erx-buy-modal-heading {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding-right: 42px !important;
    }
    #erx-buy-item-modal .erx-buy-modal-heading > .text-heading-medium {
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 24px !important;
      font-weight: 700 !important;
      line-height: 32px !important;
      letter-spacing: -0.24px !important;
    }
    #erx-buy-item-modal .erx-buy-balance {
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      line-height: 20px !important;
    }
    #erx-buy-item-modal .erx-buy-item-row {
      display: flex !important;
      align-items: center !important;
      gap: 16px !important;
    }
    #erx-buy-item-modal .erx-buy-details {
      display: flex !important;
      min-width: 0 !important;
      flex-direction: column !important;
      gap: 8px !important;
    }
    #erx-buy-item-modal .erx-buy-item-name {
      overflow-wrap: anywhere !important;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 16px !important;
      font-weight: 500 !important;
      line-height: 22px !important;
    }
    #erx-buy-item-modal .erx-buy-price {
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 16px !important;
      font-weight: 400 !important;
    }
    #erx-buy-item-modal .erx-buy-modal-footer {
      display: flex !important;
      flex-direction: column !important;
      padding: 0 20px 20px !important;
    }
    #erx-buy-item-modal .erx-buy-confirm-row {
      display: flex !important;
      flex-direction: row-reverse !important;
    }
    #erx-buy-item-modal #erx-buy-item-confirm-btn {
      flex: 1 1 0% !important;
      width: 100% !important;
      height: 48px !important;
      padding: 0 12px !important;
      border: 0 !important;
      border-radius: 8px !important;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif !important;
      font-size: 16px !important;
      font-weight: 600 !important;
      line-height: 16px !important;
    }
    #erx-catalog-success-modal .foundation-web-dialog-content[data-size="Medium"] {
      max-width: 480px !important;
      min-width: 300px !important;
    }
    #erx-buy-item-modal .foundation-web-dialog-close-container,
    #erx-catalog-success-modal .foundation-web-dialog-close-container,
    #erx-insufficient-robux-modal .foundation-web-dialog-close-container {
      right: 12px !important;
      top: 12px !important;
      position: absolute !important;
      z-index: 1 !important;
    }
    #erx-buy-item-modal .erx-modal-x-fallback:empty::before,
    #erx-catalog-success-modal .erx-modal-x-fallback:empty::before,
    #erx-insufficient-robux-modal .erx-modal-x-fallback:empty::before {
      content: "✕";
      font-size: 16px;
      line-height: 1;
    }
    #erx-catalog-success-modal .erx-check-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #erx-catalog-success-modal .icon-regular-circle-check::before {
      display: none !important;
    }
    #erx-buy-item-modal .erx-robux-icon,
    #erx-catalog-success-modal .erx-robux-icon,
    #erx-insufficient-robux-modal .erx-robux-icon {
      display: inline-block;
      width: 16px;
      height: 16px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='16' height='16'%3E%3Cpath d='M15.0762 7.29574C15.6479 6.96571 16.3521 6.96571 16.9238 7.29574L23.0762 10.8479C23.6479 11.1779 24 11.7878 24 12.4479V19.5521C24 20.2122 23.6479 20.8221 23.0762 21.1521L16.9238 24.7043C16.3521 25.0343 15.6479 25.0343 15.0762 24.7043L8.92376 21.1521C8.35214 20.8221 8 20.2122 8 19.5521V12.4479C8 11.7878 8.35214 11.1779 8.92376 10.8479L15.0762 7.29574ZM11.9998 13V19C11.9998 19.5523 12.4475 20 12.9998 20H18.9998C19.5521 20 19.9998 19.5523 19.9998 19V13C19.9998 12.4477 19.5521 12 18.9998 12H12.9998C12.4475 12 11.9998 12.4477 11.9998 13Z' fill='%23000'/%3E %3Cpath d='M13.8556 2.56068C15.1825 1.81311 16.8175 1.81311 18.1444 2.56068L26.8556 7.46819C28.1825 8.21577 29 9.59734 29 11.0925V20.9075C29 22.4027 28.1825 23.7842 26.8556 24.5318L18.1444 29.4393C16.8175 30.1869 15.1825 30.1869 13.8556 29.4393L5.14444 24.5318C3.81746 23.7842 3 22.4027 3 20.9075V11.0925C3 9.59734 3.81746 8.21577 5.14444 7.46819L13.8556 2.56068ZM17.1628 4.30319C16.4452 3.89894 15.5548 3.89894 14.8372 4.30319L6.12611 9.2107C5.41362 9.61209 5 10.336 5 11.0925V20.9075C5 21.664 5.41362 22.3879 6.12611 22.7893L14.8372 27.6968C15.5548 28.1011 16.4452 28.1011 17.1628 27.6968L25.8739 22.7893C26.5864 22.3879 27 21.664 27 20.9075V11.0925C27 10.336 26.5864 9.61209 25.8739 9.2107L17.1628 4.30319Z' fill='%23000'/%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
    }
    .dark #erx-buy-item-modal .erx-robux-icon,
    [data-theme="dark"] #erx-buy-item-modal .erx-robux-icon,
    .dark-theme #erx-buy-item-modal .erx-robux-icon,
    .dark #erx-catalog-success-modal .erx-robux-icon,
    [data-theme="dark"] #erx-catalog-success-modal .erx-robux-icon,
    .dark-theme #erx-catalog-success-modal .erx-robux-icon,
    .dark #erx-insufficient-robux-modal .erx-robux-icon,
    [data-theme="dark"] #erx-insufficient-robux-modal .erx-robux-icon,
    .dark-theme #erx-insufficient-robux-modal .erx-robux-icon {
      filter: invert(1);
    }
    @media (max-width: 480px) {
      #erx-insufficient-robux-modal .erx-insufficient-item-row {
        min-height: 112px !important;
        gap: 16px !important;
      }
      #erx-insufficient-robux-modal .erx-insufficient-thumbnail {
        width: 112px !important;
        height: 112px !important;
        flex-basis: 112px !important;
      }
    }

    /* Owned badge and inventory message fallback styling */
    .item-owned {
      display: inline-flex !important;
      align-items: center !important;
      margin-left: 12px !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      vertical-align: middle !important;
    }
    .item-owned .label-checkmark {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 16px !important;
      height: 16px !important;
      border-radius: 50% !important;
      background-color: #00b06f !important;
      margin-right: 6px !important;
    }
    .item-owned .icon-checkmark-white-bold {
      display: inline-block !important;
      width: 9px !important;
      height: 5px !important;
      border-left: 2px solid #fff !important;
      border-bottom: 2px solid #fff !important;
      transform: rotate(-45deg) !important;
      margin-top: -2px !important;
    }
    .price-row-container .item-first-line {
      font-size: 16px;
      font-weight: 500;
      color: inherit;
    }

    /* Purchased catalog items injected into Avatar > Recent. The native class
       names do most of the styling; these rules are only safe fallbacks. */
    [data-erx-inventory-item] .item-card-thumb-container { cursor: pointer; }
    [data-erx-inventory-item] .item-card-equipped {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    [data-erx-inventory-item] .thumbnail-2d-container.erx-loading,
    .erx-avatar-preview-loading {
      background: linear-gradient(90deg, rgba(27, 37, 75, 0.08) 0%, rgba(27, 37, 75, 0.2) 50%, rgba(27, 37, 75, 0.08) 100%) !important;
      background-size: 200% 100% !important;
      animation: erx-thumbnail-shimmer 1.2s infinite linear !important;
    }
    [data-erx-inventory-item] .thumbnail-2d-container img.loading,
    .erx-avatar-preview-loading img {
      opacity: 0 !important;
    }
    .erx-avatar-preview-loading img {
      visibility: hidden !important;
      transition: none !important;
    }
    [data-erx-inventory-item] .erx-equipped-check-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: transparent !important;
      color: inherit !important;
      filter: none !important;
      text-shadow: none !important;
      overflow: visible;
    }
    [data-erx-inventory-item] .erx-equipped-check-fallback > svg {
      display: block;
      width: 20px;
      height: 20px;
      overflow: visible;
    }
  `;

  function injectPageStyle() {
    if (document.getElementById('erx-page-style')) return;
    const style = document.createElement('style');
    style.id = 'erx-page-style';
    style.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  injectPageStyle();

  /* ============================== storage ============================= */

  // Cached account info is refreshed every few minutes so the avatar in the
  // transaction history follows the latest profile picture.
  const ME_TTL = 6 * 60 * 1000;

  function loadStorage() {
    try {
      chrome.storage.local.get(['robuxAmount', 'transactions', 'me', 'meAt', 'purchasedCatalogItems', 'purchasedCatalogDetails', 'equippedCatalogItem', 'robloxPlusEnabled', 'verifiedBadgeEnabled'], (res) => {
        const data = res || {};
        state.fake = toAmount(data.robuxAmount);
        state.txs = Array.isArray(data.transactions) ? data.transactions : [];
        if (Array.isArray(data.purchasedCatalogItems)) {
          state.purchasedItems = data.purchasedCatalogItems;
          setCachedPurchasedItems(state.purchasedItems);
          checkCatalogPageNav();
        }
        if (Array.isArray(data.purchasedCatalogDetails)) {
          state.purchasedDetails = data.purchasedCatalogDetails;
          setCachedPurchasedDetails(state.purchasedDetails);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'equippedCatalogItem')) {
          state.equippedCatalogItem = data.equippedCatalogItem ? String(data.equippedCatalogItem) : null;
          setCachedEquippedCatalogItem(state.equippedCatalogItem);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'robloxPlusEnabled')) {
          state.robloxPlusConfigured = true;
          state.robloxPlusEnabled = !!data.robloxPlusEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'verifiedBadgeEnabled')) {
          state.verifiedBadgeConfigured = true;
          state.verifiedBadgeEnabled = !!data.verifiedBadgeEnabled;
        }
        if (data.me && (data.me.id || data.me.name)) {
          state.me = data.me;
        }
        schedule();
        scheduleTx();
        applyCatalogOwnership();
        scheduleCatalogPreviewCapture();
        scheduleAvatarInventory();
        scheduleBadges();
        // Always confirm the active Roblox identity on page load. Extension
        // storage is shared by browser profile, so a cached account must never
        // be reported after the user switches to another Roblox account.
        resolveMe(true);
        if (state.me) notifyTracker();
      });
    } catch (_) { /* storage unavailable — extension still works with defaults */ }
  }

  function showAdminToast(message) {
    if (!message) return;
    let host = document.getElementById('erx-admin-toast');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'erx-admin-toast';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:360px;padding:12px 16px;border-radius:12px;background:#0f131a;border:1px solid rgba(52,199,89,0.5);color:#eef1f7;font:600 13px/1.4 "Builder Sans","Segoe UI",system-ui,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,0.55);display:flex;align-items:center;gap:10px;';
    const badge = document.createElement('span');
    badge.textContent = 'R$';
    badge.style.cssText = 'width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-weight:800;font-size:11px;color:#06110c;background:linear-gradient(135deg,hsl(152,72%,48%),hsl(186,80%,52%));flex-shrink:0;';
    const text = document.createElement('span');
    text.textContent = String(message);
    host.appendChild(badge);
    host.appendChild(text);
    (document.body || document.documentElement).appendChild(host);
    setTimeout(() => { if (host && host.parentNode) host.remove(); }, 6000);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes._erxAdminToast && changes._erxAdminToast.newValue && changes._erxAdminToast.newValue.message) {
        showAdminToast(changes._erxAdminToast.newValue.message);
      }
      if (changes._erxBanned || changes._erxBanReason || changes._erxBanExpiresAt || changes._erxVersionExpired || changes._erxExpiredVersion || changes._erxDiscordUrl) {
        try {
          chrome.storage.local.get(['_erxBanned', '_erxBanReason', '_erxBanExpiresAt', '_erxVersionExpired', '_erxExpiredVersion', '_erxDiscordUrl'], applyBanScreen);
        } catch (_) { /* noop */ }
      }
      if (changes.robuxAmount) {
        state.fake = toAmount(changes.robuxAmount.newValue);
        if (state.fake === null) restoreAmounts();
        schedule();
      }
      if (changes.transactions) {
        state.txs = Array.isArray(changes.transactions.newValue) ? changes.transactions.newValue : [];
        scheduleTx();
      }
      if (changes.purchasedCatalogItems) {
        state.purchasedItems = Array.isArray(changes.purchasedCatalogItems.newValue) ? changes.purchasedCatalogItems.newValue : [];
        setCachedPurchasedItems(state.purchasedItems);
        checkCatalogPageNav();
      }
      if (changes.purchasedCatalogDetails) {
        state.purchasedDetails = Array.isArray(changes.purchasedCatalogDetails.newValue) ? changes.purchasedCatalogDetails.newValue : [];
        setCachedPurchasedDetails(state.purchasedDetails);
        scheduleAvatarInventory();
      }
      if (changes.equippedCatalogItem) {
        state.equippedCatalogItem = changes.equippedCatalogItem.newValue ? String(changes.equippedCatalogItem.newValue) : null;
        setCachedEquippedCatalogItem(state.equippedCatalogItem);
        scheduleAvatarInventory();
      }
      if (changes.robloxPlusEnabled) {
        state.robloxPlusConfigured = changes.robloxPlusEnabled.newValue !== undefined;
        state.robloxPlusEnabled = !!changes.robloxPlusEnabled.newValue;
        scheduleBadges();
        notifyTracker();
      }
      if (changes.verifiedBadgeEnabled) {
        state.verifiedBadgeConfigured = changes.verifiedBadgeEnabled.newValue !== undefined;
        state.verifiedBadgeEnabled = !!changes.verifiedBadgeEnabled.newValue;
        scheduleBadges();
      }
      if (changes.me && changes.me.newValue) {
        const previousId = Number(state.me && state.me.id) || 0;
        const nextId = Number(changes.me.newValue && changes.me.newValue.id) || 0;
        if (previousId && nextId && previousId !== nextId) state.realRobloxPlusStatus = false;
        state.me = changes.me.newValue;
        scheduleTx();
        scheduleBadges();
        notifyTracker();
      }
    });
  } catch (_) { /* noop */ }

  /* ========================= robux amount swap ======================== */

  const inlineNodes = new Set();
  const BALANCE_VALUE_SELECTOR = [
    '#nav-robux-amount',
    '[data-testid="robux-balance"]',
    '[data-testid="nav-robux-amount"]',
    '[data-testid*="robux"][data-testid*="balance"]',
    '[id*="robux"][id*="amount"]',
    '[id*="robux"][id*="balance"]',
    '.rbx-text-navbar-right',
  ].join(',');

  function hasRobuxBalanceSignal(el) {
    let node = el;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const signal = [
        node.id,
        node.className,
        node.getAttribute && node.getAttribute('data-testid'),
        node.getAttribute && node.getAttribute('aria-label'),
        node.getAttribute && node.getAttribute('href'),
      ].filter(Boolean).join(' ').toLowerCase();
      if (/robux/.test(signal) && /(balance|amount|wallet|currency|upgrade|navbar|nav-)/.test(signal)) return true;
    }
    return false;
  }

  // Phone widths use a different Roblox navbar tree. Only accept numeric
  // leaves inside explicit Robux balance/navigation controls, never prices.
  function robuxBalanceCandidates() {
    const found = new Set();
    const add = (el) => {
      if (!el || found.has(el) || el.closest('#' + MODAL_ID)) return;
      if (el.childElementCount > 0 || !isNumericText((el.textContent || '').trim())) return;
      if (el.matches(BALANCE_VALUE_SELECTOR) || hasRobuxBalanceSignal(el)) found.add(el);
    };

    document.querySelectorAll(BALANCE_VALUE_SELECTOR).forEach(add);
    document.querySelectorAll('nav, header, [role="navigation"]').forEach((zone) => {
      zone.querySelectorAll('span, div, p, strong, b').forEach(add);
    });
    return Array.from(found);
  }

  function learnRealBalance(candidates) {
    for (const el of candidates) {
      const marked = el.getAttribute(MARK);
      const visible = (el.textContent || '').trim();
      const raw = marked != null ? marked : visible;
      if (!isNumericText(raw)) continue;
      if (marked == null && visible === lastAppliedText && state.realDigits) continue;
      const digits = digitsOf(raw);
      if (!digits) continue;
      const prevDigits = state.realDigits;
      state.realDigits = digits;
      state.realText = raw;
      if (prevDigits !== digits) notifyTracker();
      return el;
    }
    return null;
  }

  function swapSimple(el, fakeText, requireReal) {
    const current = el.textContent;
    if (current === fakeText) return false;
    if (!isNumericText(current)) return false;
    const raw = current.trim();
    // Once we own an element (MARK set) it may already show an older fake value,
    // so the "must equal the real balance" check only applies to fresh elements.
    const owns = el.hasAttribute(MARK);
    if (requireReal && !owns && state.realDigits && digitsOf(raw) !== state.realDigits) return false;
    if (!owns) el.setAttribute(MARK, raw);
    writeText(el, fakeText);
    return true;
  }

  function patchGenericLeaves(fakeText) {
    if (!state.realDigits) return;
    const zones = document.querySelectorAll(
      'nav, header, [role="navigation"], [class*="navbar"], [class*="mobile-nav"], [class*="mobile-header"], [class*="balance"]'
    );
    if (!zones.length) return;
    let budget = 1200;
    zones.forEach((zone) => {
      if (budget <= 0 || zone.closest('#' + MODAL_ID)) return;
      const nodes = zone.querySelectorAll('span, div, p, strong, b');
      for (const el of nodes) {
        if (budget <= 0) break;
        budget -= 1;
        if (el.childElementCount || el.closest('#' + MODAL_ID)) continue;
        const text = (el.textContent || '').trim();
        if (!isNumericText(text)) continue;
        if (digitsOf(text) !== state.realDigits) continue;
        swapSimple(el, fakeText, true);
      }
    });
  }

  // "My Balance: [R$] 678" — the number sits next to a robux icon
  function patchInlineBalance(fakeText) {
    document.querySelectorAll('.icon-robux-16x16, .icon-robux, .icon-robux-white').forEach((icon) => {
      const wrap = icon.parentElement;
      if (!wrap || wrap.closest('#' + MODAL_ID)) return;
      const label = (wrap.textContent || '').toLowerCase();
      if (!/balance|wallet/.test(label)) return;
      wrap.childNodes.forEach((node) => {
        if (node.nodeType !== Node.TEXT_NODE) return;
        if (!/\d/.test(node.nodeValue)) return;
        if (node.__erxReal == null) node.__erxReal = node.nodeValue;
        inlineNodes.add(node);
        const next = node.nodeValue.replace(/\d[\d,]*/, fakeText);
        if (next !== node.nodeValue) node.nodeValue = next;
      });
    });
  }

  // Text we last wrote into the navbar. Used so we never mistake our own fake
  // number for the real balance (e.g. after a fake-amount change or a send).
  let lastAppliedText = null;

  function applyAmounts() {
    const fake = isBanned ? null : state.fake;
    const fakeText = fake == null ? null : fmt(fake);

    // 1. navbar — also the source of truth for the real balance
    const balances = robuxBalanceCandidates();
    const source = learnRealBalance(balances);
    if (fakeText === null) lastAppliedText = null;

    if (fakeText === null) return;

    balances.forEach((el) => swapSimple(el, fakeText, el !== source));
    if (balances.length) lastAppliedText = fakeText;

    // 2. other known balance spots
    document
      .querySelectorAll(
        'span.font-builder-extended.content-action-standard,' +
        'span.text-label-medium.content-emphasis,' +
        '.rbx-text-navbar-right,' +
        '[data-testid="robux-balance"]'
      )
      .forEach((el) => {
        if (balances.includes(el) || el.closest('#' + MODAL_ID)) return;
        swapSimple(el, fakeText, true);
      });

    // 3. safety net for markup we have not seen yet
    patchGenericLeaves(fakeText);

    // 4. "My Balance: 678" on /transactions
    patchInlineBalance(fakeText);
  }

  function restoreAmounts() {
    lastAppliedText = null;
    document.querySelectorAll('[' + MARK + ']').forEach((el) => {
      const real = el.getAttribute(MARK);
      el.removeAttribute(MARK);
      if (real != null) writeText(el, real);
    });
    inlineNodes.forEach((node) => {
      if (node.__erxReal != null) node.nodeValue = node.__erxReal;
      delete node.__erxReal;
    });
    inlineNodes.clear();
  }

  // Balance currently shown to the user (fake amount if set, else the real one).
  function currentBalance() {
    if (state.fake != null) return state.fake;
    return toAmount(state.realDigits);
  }

  let amountTimer = 0;
  function schedule() {
    if (amountTimer) return;
    amountTimer = setTimeout(() => {
      amountTimer = 0;
      try { applyAmounts(); } catch (err) { console.warn('[E.Roblox] amount patch failed', err); }
    }, 50);
  }

  /* ============================ transactions ========================== */

  let txTimer = 0;
  let txSig = null;

  function scheduleTx() {
    if (txTimer) return;
    txTimer = setTimeout(() => {
      txTimer = 0;
      try { renderTxs(); } catch (err) { console.warn('[E.Roblox] transaction render failed', err); }
    }, 50);
  }

  function txTableBody() {
    if (injectedTransfersActive) {
      const injected = document.querySelector('[' + ERX_TRANSFER_VIEW + '] table.transactions tbody');
      if (injected) return injected;
    }
    return (
      Array.from(document.querySelectorAll('.transactions-container table.transactions tbody')).find((tbody) => !tbody.closest('[' + ERX_TRANSFER_VIEW + ']')) ||
      document.querySelector('table.transactions tbody')
    );
  }

  function dateLabel(ts) {
    return new Date(ts).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
  }
  function timeLabel(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function attachThumbnailLoading(container, img) {
    if (!container || !img) return;
    container.classList.add('erx-loading');
    img.classList.add('loading');

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      // Brief authentic delay so the loading shimmer inside the profile picture is visible like Roblox
      setTimeout(() => {
        img.classList.remove('loading');
        container.classList.remove('erx-loading');
      }, 400 + Math.floor(Math.random() * 250));
    };

    if (img.complete && img.naturalWidth > 0) {
      finish();
    } else {
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', () => {
        img.src = FALLBACK_AVATAR;
        finish();
      }, { once: true });
    }
  }

  function avatarCard(user) {
    const url = profileUrl(user);
    const img = h('img', { class: 'loading', src: user.avatar || FALLBACK_AVATAR, alt: '' });
    img.addEventListener('error', () => { img.src = FALLBACK_AVATAR; });
    const thumbSpan = h('span', { class: 'thumbnail-2d-container avatar-card-image erx-loading' }, [img]);
    attachThumbnailLoading(thumbSpan, img);

    return h('div', { class: 'avatar-card' }, [
      h('div', { class: 'avatar avatar-headshot-xs avatar-headshot' }, [
        h('a', { class: 'avatar-card-link', href: url }, [thumbSpan]),
      ]),
      h('div', { class: 'avatar-card-caption' }, [
        h('a', { class: 'avatar-card-name text-name text-overflow', href: url }, user.name || 'You'),
      ]),
    ]);
  }

  function buildTxRow(tx) {
    // The live account wins over the snapshot so the avatar/username always
    // follow the latest profile image.
    const me = state.me || tx.me || { id: null, name: 'You', displayName: 'You', avatar: '' };
    const target = tx.target || { id: null, name: 'Player', displayName: 'Player', avatar: '' };
    const when = tx.ts || Date.now();

    const tr = h('tr', { class: '', 'data-erx-tx': String(tx.id) });

    tr.appendChild(h('td', { class: 'date' }, [h('div', { text: dateLabel(when) }), h('div', { text: timeLabel(when) })]));

    tr.appendChild(h('td', { class: 'user' }, [avatarCard(me)]));

    const itemImg = target.avatar ? h('img', { class: 'loading', src: target.avatar, alt: '' }) : null;
    if (itemImg) itemImg.addEventListener('error', () => { itemImg.src = FALLBACK_AVATAR; });
    const itemThumbSpan = h('span', { class: 'thumbnail-2d-container' + (itemImg ? ' erx-loading' : '') }, itemImg ? [itemImg] : []);
    if (itemImg) attachThumbnailLoading(itemThumbSpan, itemImg);

    tr.appendChild(
      h('td', { class: 'item' }, [
        h('div', { class: 'item-format item-sale-format' }, [
          h('span', { class: 'item-card-image' }, [itemThumbSpan]),
          h('div', {
            class: 'item-description',
            text: 'Sent Robux to ' + (target.displayName || target.name) + '.',
          }),
        ]),
      ])
    );

    tr.appendChild(
      h('td', { class: 'amount icon-robux-container' }, [
        h('span', { class: 'amount-display' }, [
          h('span', { text: '-' }),
          h('span', { class: 'icon-robux-16x16' }),
          h('span', { class: '', text: fmt(tx.amount) }),
        ]),
      ])
    );

    tr.appendChild(h('td', { class: 'row-actions' }, []));
    return tr;
  }

  function txTypeLabel() {
    const label = document.querySelector('#type-selection .rbx-selection-label');
    if (label) return (label.textContent || '').replace(/\s+/g, ' ').trim();
    const btn = document.querySelector('#type-selection');
    return btn ? (btn.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function txTransfersSelected() {
    return /^robux\s+transfers?$/i.test(txTypeLabel());
  }

  const ERX_TRANSFER_OPTION = 'data-erx-transfer-option';
  const ERX_TRANSFER_VIEW = 'data-erx-transfer-view';
  let injectedTransfersActive = false;
  let previousTxLabel = '';
  let previousActiveTxOption = null;
  let hiddenNativeTxHolder = null;
  const hiddenInjectedTxContext = new Set();
  let injectedTxPage = 1;
  let injectedTxPageSize = 10;

  function transactionTypeMenu() {
    return document.querySelector(
      'ul[role="menu"][aria-labelledby="type-selection"], ul.dropdown-menu[aria-labelledby="type-selection"]'
    );
  }

  function transactionMenuItems() {
    const menu = transactionTypeMenu();
    return menu ? Array.from(menu.querySelectorAll('a[role="menuitem"], [role="menuitem"]')) : [];
  }

  function isTransfersMenuItem(item) {
    return !!item && /^robux\s+transfers?$/i.test((item.textContent || '').replace(/\s+/g, ' ').trim());
  }

  function nativeTransfersMenuItem() {
    return transactionMenuItems().find((item) => isTransfersMenuItem(item) && !item.closest('[' + ERX_TRANSFER_OPTION + ']')) || null;
  }

  function nativeTransactionsContainer() {
    return Array.from(document.querySelectorAll('.transactions-container')).find((container) => !container.closest('[' + ERX_TRANSFER_VIEW + ']')) || null;
  }

  function closeInjectedTransfersView(restoreSelection) {
    document.querySelectorAll('[' + ERX_TRANSFER_VIEW + ']').forEach((view) => view.remove());
    document.querySelectorAll('[data-erx-num-items-control]').forEach((control) => control.remove());
    if (hiddenNativeTxHolder) hiddenNativeTxHolder.classList.remove('erx-native-transactions-hidden');
    hiddenNativeTxHolder = null;
    hiddenInjectedTxContext.forEach((node) => node.classList.remove('erx-native-transactions-hidden'));
    hiddenInjectedTxContext.clear();

    const injectedOption = document.querySelector('[' + ERX_TRANSFER_OPTION + ']');
    if (injectedOption) injectedOption.classList.remove('active');

    if (restoreSelection) {
      const label = document.querySelector('#type-selection .rbx-selection-label');
      if (label && previousTxLabel) writeText(label, previousTxLabel);
      if (previousActiveTxOption && previousActiveTxOption.isConnected) previousActiveTxOption.classList.add('active');
    }

    previousTxLabel = '';
    previousActiveTxOption = null;
    injectedTransfersActive = false;
    injectedTxPage = 1;
    txSig = null;
  }

  function hideDuringInjectedTransfers(node) {
    if (!node) return;
    node.classList.add('erx-native-transactions-hidden');
    hiddenInjectedTxContext.add(node);
  }

  function ensureInjectedNumItemsControl(dropdownContainer) {
    if (!dropdownContainer) return null;
    let control = dropdownContainer.querySelector('[data-erx-num-items-control]');
    if (control) return control;

    control = document.createElement('div');
    control.className = 'transaction-num-items-dropdown dropdown-btn';
    control.setAttribute('data-erx-num-items-control', 'true');
    control.innerHTML = `
      <label id="erx-num-items-selection-label" for="erx-num-items-selection" class="font-caption-header text">Number of Items</label>
      <div labelledby="erx-num-items-selection-label" class="input-group-btn dropdown btn-group">
        <button id="erx-num-items-selection" role="button" aria-haspopup="true" aria-expanded="false" type="button" class="input-dropdown-btn dropdown-toggle btn btn-default">
          <span class="rbx-selection-label">${injectedTxPageSize} per page</span><span class="icon-down-16x16"></span>
        </button>
        <ul role="menu" class="dropdown-menu" aria-labelledby="erx-num-items-selection">
          ${[10, 25, 50, 100].map((size) => `<li role="presentation"${size === injectedTxPageSize ? ' class="active"' : ''}><a role="menuitem" tabindex="-1" href="#" data-erx-page-size="${size}">${size} per page</a></li>`).join('')}
        </ul>
      </div>`;

    const button = control.querySelector('#erx-num-items-selection');
    const group = button.closest('.btn-group');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = !group.classList.contains('open');
      group.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
    });
    control.querySelectorAll('[data-erx-page-size]').forEach((item) => {
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        injectedTxPageSize = Number(item.getAttribute('data-erx-page-size')) || 10;
        injectedTxPage = 1;
        control.querySelectorAll('li').forEach((row) => row.classList.toggle('active', row.contains(item)));
        writeText(button.querySelector('.rbx-selection-label'), injectedTxPageSize + ' per page');
        group.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        txSig = null;
        scheduleTx();
      });
    });

    dropdownContainer.appendChild(control);
    return control;
  }

  function syncInjectedPager(totalItems) {
    const view = document.querySelector('[' + ERX_TRANSFER_VIEW + ']');
    if (!view) return;
    const pages = Math.max(1, Math.ceil(totalItems / injectedTxPageSize));
    injectedTxPage = Math.min(Math.max(1, injectedTxPage), pages);
    const current = view.querySelector('#erx-current-page');
    const prev = view.querySelector('[data-erx-page="prev"]');
    const next = view.querySelector('[data-erx-page="next"]');
    if (current) writeText(current, String(injectedTxPage));
    if (prev) prev.disabled = injectedTxPage <= 1;
    if (next) next.disabled = injectedTxPage >= pages;
  }

  function ensureInjectedTransfersView() {
    let view = document.querySelector('[' + ERX_TRANSFER_VIEW + ']');
    const nativeContainer = nativeTransactionsContainer();
    const nativeHolder = nativeContainer && (nativeContainer.closest('.section') || nativeContainer);
    const typeButton = document.getElementById('type-selection');
    const dropdownContainer = typeButton && typeButton.closest('.dropdown-container');
    const transactionRoot = typeButton && typeButton.closest('.user-transactions-container');

    if (dropdownContainer) {
      dropdownContainer.querySelectorAll('.transaction-date-dropdown').forEach(hideDuringInjectedTransfers);
      ensureInjectedNumItemsControl(dropdownContainer);
    }
    if (transactionRoot) {
      Array.from(transactionRoot.children).forEach((child) => {
        if (child.classList && child.classList.contains('summary')) hideDuringInjectedTransfers(child);
      });
    }

    if (hiddenNativeTxHolder && hiddenNativeTxHolder !== nativeHolder) {
      hiddenNativeTxHolder.classList.remove('erx-native-transactions-hidden');
    }
    hiddenNativeTxHolder = nativeHolder || null;
    if (hiddenNativeTxHolder) hiddenNativeTxHolder.classList.add('erx-native-transactions-hidden');

    if (!view) {
      view = document.createElement('div');
      view.className = 'section erx-transfers-section';
      view.setAttribute(ERX_TRANSFER_VIEW, 'true');
      view.innerHTML = `
        <div class="transactions-container">
          <table class="table table-striped transactions transactions--has-row-actions">
            <colgroup><col><col><col><col><col class="transactions-col-row-actions"></colgroup>
            <tbody>
              <tr>
                <th class="date">Date</th>
                <th class="user">Source</th>
                <th class="item">Description</th>
                <th class="amount">Amount</th>
                <th class="row-actions" scope="col" aria-label="Row actions"></th>
              </tr>
            </tbody>
          </table>
          <div class="pager-holder erx-transfers-pager">
            <ul class="pager">
              <li class="pager-prev"><button type="button" class="btn-generic-left-sm" data-erx-page="prev" disabled title="left"><span class="icon-left"></span></button></li>
              <li class="pager-cur"><span id="erx-current-page">1</span></li>
              <li class="pager-next"><button type="button" class="btn-generic-right-sm" data-erx-page="next" disabled title="right"><span class="icon-right"></span></button></li>
            </ul>
          </div>
        </div>`;

      view.querySelector('[data-erx-page="prev"]').addEventListener('click', () => {
        if (injectedTxPage <= 1) return;
        injectedTxPage -= 1;
        txSig = null;
        scheduleTx();
      });
      view.querySelector('[data-erx-page="next"]').addEventListener('click', () => {
        const pages = Math.max(1, Math.ceil(state.txs.length / injectedTxPageSize));
        if (injectedTxPage >= pages) return;
        injectedTxPage += 1;
        txSig = null;
        scheduleTx();
      });

      const insertionAnchor = dropdownContainer || nativeHolder || typeButton?.closest('.section') || typeButton;
      if (insertionAnchor && insertionAnchor.parentElement) insertionAnchor.insertAdjacentElement('afterend', view);
      else (document.body || document.documentElement).appendChild(view);
    } else if (dropdownContainer && view.previousElementSibling !== dropdownContainer) {
      dropdownContainer.insertAdjacentElement('afterend', view);
    }

    const label = document.querySelector('#type-selection .rbx-selection-label');
    if (label && !txTransfersSelected()) writeText(label, 'Robux Transfers');
    return view;
  }

  function openInjectedTransfersView(option) {
    if (!state.txs.length || nativeTransfersMenuItem()) return;
    const menu = transactionTypeMenu();
    if (!injectedTransfersActive) {
      previousTxLabel = txTypeLabel() || 'Summary';
      previousActiveTxOption = menu && Array.from(menu.children).find((item) => item.classList.contains('active'));
    }

    if (menu) {
      Array.from(menu.children).forEach((item) => item.classList.remove('active'));
    }
    const optionRow = option && option.closest('li, [role="presentation"]');
    if (optionRow) optionRow.classList.add('active');

    injectedTransfersActive = true;
    ensureInjectedTransfersView();
    txSig = null;
    scheduleTx();
  }

  function syncInjectedTransferOption() {
    const existing = document.querySelector('[' + ERX_TRANSFER_OPTION + ']');

    // Accounts that already have Roblox's native option must stay completely native.
    if (nativeTransfersMenuItem()) {
      if (existing) existing.remove();
      if (injectedTransfersActive) closeInjectedTransfersView(true);
      return;
    }

    if (!state.txs.length) {
      if (existing) existing.remove();
      if (injectedTransfersActive) closeInjectedTransfersView(true);
      return;
    }

    const menu = transactionTypeMenu();
    if (!menu || existing) return;

    const row = document.createElement('li');
    row.setAttribute('role', 'presentation');
    row.setAttribute(ERX_TRANSFER_OPTION, 'true');
    const link = document.createElement('a');
    link.setAttribute('role', 'menuitem');
    link.setAttribute('tabindex', '-1');
    link.setAttribute('href', '#');
    link.textContent = 'Robux Transfers';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = document.getElementById('type-selection');
      if (button) button.setAttribute('aria-expanded', 'false');
      menu.classList.remove('show');
      let dropdownParent = menu.parentElement;
      for (let depth = 0; dropdownParent && depth < 3; depth += 1, dropdownParent = dropdownParent.parentElement) {
        dropdownParent.classList.remove('open', 'show');
      }
      openInjectedTransfersView(row);
    });
    row.appendChild(link);

    const creatorRewards = Array.from(menu.children).find((item) => /creator\s+rewards/i.test(item.textContent || ''));
    menu.insertBefore(row, creatorRewards || null);
  }

  function renderTxs() {
    if (isBanned) {
      closeInjectedTransfersView(true);
      document.querySelectorAll('[' + ERX_TRANSFER_OPTION + ']').forEach((n) => n.remove());
      document.querySelectorAll('tr[data-erx-tx]').forEach((n) => n.remove());
      return;
    }
    syncInjectedTransferOption();
    if (injectedTransfersActive) ensureInjectedTransfersView();

    const tbody = txTableBody();
    if (!tbody) { txSig = null; return; }

    // The fake transfers only belong in the "Robux Transfers" view; Summary and
    // every other transaction type stay untouched.
    if (!txTransfersSelected()) {
      txSig = null;
      tbody.querySelectorAll('tr[data-erx-tx]').forEach((row) => row.remove());
      return;
    }

    const sortedTxs = state.txs.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (injectedTransfersActive) {
      const pages = Math.max(1, Math.ceil(sortedTxs.length / injectedTxPageSize));
      injectedTxPage = Math.min(Math.max(1, injectedTxPage), pages);
    }
    const visibleTxs = injectedTransfersActive
      ? sortedTxs.slice((injectedTxPage - 1) * injectedTxPageSize, injectedTxPage * injectedTxPageSize)
      : sortedTxs;

    const sig = JSON.stringify({
      v: injectedTransfersActive ? 'injected' : 'native',
      p: injectedTransfersActive ? [injectedTxPage, injectedTxPageSize] : null,
      t: state.txs.map((t) => [t.id, t.ts, t.amount, t.target && t.target.name, t.target && t.target.avatar]),
      m: state.me ? [state.me.id, state.me.name, state.me.avatar] : null,
    });

    const existing = tbody.querySelectorAll('tr[data-erx-tx]');
    if (sig === txSig && existing.length === visibleTxs.length) {
      if (injectedTransfersActive) syncInjectedPager(sortedTxs.length);
      return;
    }

    txSig = sig;
    existing.forEach((row) => row.remove());
    if (!state.txs.length) {
      if (injectedTransfersActive) syncInjectedPager(0);
      return;
    }

    const firstRow = tbody.querySelector('tr');
    const headerRow = firstRow && firstRow.querySelector('th') ? firstRow : null;
    const anchor = headerRow ? headerRow.nextElementSibling : firstRow;

    visibleTxs.forEach((tx) => tbody.insertBefore(buildTxRow(tx), anchor || null));
    if (injectedTransfersActive) syncInjectedPager(sortedTxs.length);
  }

  // Leaving the injected option for any normal/native type restores the page's
  // own transaction card before Roblox handles that menu click.
  document.addEventListener('click', (event) => {
    if (!injectedTransfersActive || !(event.target instanceof Element)) return;
    const numItemsControl = document.querySelector('[data-erx-num-items-control]');
    if (numItemsControl && !event.target.closest('[data-erx-num-items-control]')) {
      const group = numItemsControl.querySelector('.btn-group');
      const button = numItemsControl.querySelector('#erx-num-items-selection');
      if (group) group.classList.remove('open');
      if (button) button.setAttribute('aria-expanded', 'false');
    }
    const item = event.target.closest('a[role="menuitem"], [role="menuitem"]');
    if (!item || item.closest('[' + ERX_TRANSFER_OPTION + '], [data-erx-num-items-control]') || isTransfersMenuItem(item)) return;
    closeInjectedTransfersView(false);
    setTimeout(scheduleTx, 0);
  }, true);

  /* ============================== toast =============================== */

  const TOAST_CSS = `
    :host { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; pointer-events: none; }
    * { box-sizing: border-box; }
    .toast {
      display: flex; align-items: center; gap: 10px;
      margin-top: 8px; padding: 12px 16px;
      border-radius: 12px;
      color: #eef1f7;
      font: 600 13px/1.3 "Builder Sans", "Segoe UI", Inter, system-ui, sans-serif;
      background: linear-gradient(180deg, #1d2130, #14161e);
      border: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 16px 40px rgba(0,0,0,.45);
      animation: in .22s cubic-bezier(.2,.9,.3,1.1) both;
    }
    .toast.out { animation: out .25s ease-in both; }
    .ico {
      display: grid; place-items: center; width: 22px; height: 22px; flex-shrink: 0;
      border-radius: 50%; font-size: 12px; color: #06110c;
      background: linear-gradient(135deg, hsl(152,72%,50%), hsl(186,80%,52%));
    }
    @keyframes in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
    @keyframes out { to { opacity: 0; transform: translateY(6px) } }
  `;

  function toast(message) {
    let host = document.getElementById(TOAST_ID);
    if (!host) {
      host = h('div', { id: TOAST_ID });
      host.attachShadow({ mode: 'open' }).appendChild(h('style', { text: TOAST_CSS }));
      document.documentElement.appendChild(host);
    }
    const root = host.shadowRoot;
    const item = h('div', { class: 'toast' }, [h('span', { class: 'ico', text: '\u2713' }), h('span', { text: message })]);
    root.appendChild(item);
    setTimeout(() => {
      item.classList.add('out');
      setTimeout(() => item.remove(), 300);
    }, 3200);
  }

  /* ========================= background bridge ======================== */

  function bg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* Roblox web APIs. First try from the signed-in page context,
     then fall back to the service worker proxy. Everything is best effort:
     the extension still works fully offline, just without real avatars. */
  const API = {
    me: 'https://users.roblox.com/v1/users/authenticated',
    user: (id) => 'https://users.roblox.com/v1/users/' + encodeURIComponent(id),
    search: (name) =>
      'https://users.roblox.com/v1/users/search?keyword=' + encodeURIComponent(name) + '&limit=10',
    headshot: (id) =>
      'https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' +
      encodeURIComponent(id) + '&size=150x150&format=Png&isCircular=false',
    assetThumbnail: (id) =>
      'https://thumbnails.roblox.com/v1/assets?assetIds=' +
      encodeURIComponent(id) + '&size=150x150&format=Webp&isCircular=false',
  };

  async function apiJson(url) {
    try {
      const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (res.ok) return await res.json();
    } catch (_) { /* CORS / offline — try the worker */ }
    const proxied = await bg({ type: 'ERX_API', url });
    if (proxied && proxied.ok) return proxied.data;
    return null;
  }

  async function avatarFor(id) {
    if (!id) return '';
    const data = await apiJson(API.headshot(id));
    const item = data && data.data && data.data[0];
    return (item && item.imageUrl) || '';
  }

  async function fetchMe() {
    const me = await apiJson(API.me);
    if (!me || !me.id) return null;
    const profile = await apiJson(API.user(me.id));
    return {
      id: me.id,
      name: me.name || 'You',
      displayName: me.displayName || me.name || 'You',
      created: (profile && profile.created) || me.created || null,
      avatar: await avatarFor(me.id),
    };
  }

  async function fetchUser(id, force) {
    if (!id) return null;
    if (!force) {
      const hit = recallProfile({ id }, true);
      if (hit) return hit;
    }
    const user = await apiJson(API.user(id));
    if (!user || !user.id) return null;
    const out = {
      id: user.id,
      name: user.name || 'Player',
      displayName: user.displayName || user.name || 'Player',
      created: user.created || null,
      avatar: await avatarFor(user.id),
    };
    rememberProfile(out);
    return out;
  }

  async function lookupUser(username) {
    if (!username) return null;
    const hit = recallProfile({ name: username }, true);
    if (hit) return hit;
    const data = await apiJson(API.search(username));
    const list = (data && (data.data || data.users)) || [];
    if (!list.length) return null;
    const wanted = String(username).toLowerCase();
    const match =
      list.find((u) => String(u.name || '').toLowerCase() === wanted) ||
      list.find((u) => String(u.displayName || '').toLowerCase() === wanted) ||
      list[0];
    const id = match.id || match.userId;
    const full = id ? await apiJson(API.user(id)) : null;
    const out = {
      id,
      name: (full && full.name) || match.name || username,
      displayName: (full && full.displayName) || match.displayName || match.name || username,
      created: (full && full.created) || null,
      avatar: await avatarFor(id),
    };
    rememberProfile(out);
    profileCache.set(cacheKey('name', username), { u: out, at: Date.now(), partial: false });
    return out;
  }

  /* ---- profile prefetch cache ----------------------------------------
     Profile pages and the send-robux friend cards are preloaded (data +
     avatar warm-up) so the Send modal paints instantly when clicked.    */

  const PROFILE_TTL = 10 * 60 * 1000;
  const FALLBACK_AVATAR =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'%3E%3Cpath d='M11.7142 2.56785C12.0165 1.43977 13.176 0.770309 14.3041 1.07258L20.4318 2.7145C21.5599 3.01678 22.2294 4.17631 21.9271 5.3044L20.2852 11.4321C19.9829 12.5602 18.8234 13.2297 17.6953 12.9274L11.5676 11.2855C10.4395 10.9832 9.77001 9.82369 10.0723 8.6956L11.7142 2.56785Z' fill='black'/%3E %3Cpath d='M6.83768 18.9378C7.33735 16.6394 9.37144 15 11.7236 15H20.2758C22.628 15 24.6621 16.6394 25.1617 18.9379L26.8927 26.9004C26.9975 27.3824 26.9375 28.0411 26.4234 28.5242C25.4616 29.4282 22.8109 31 15.9997 31C9.18851 31 6.53782 29.4282 5.57598 28.5242C5.06195 28.0411 5.00192 27.3824 5.1067 26.9004L6.83768 18.9378Z' fill='black'/%3E%3C/svg%3E";

  const profileCache = new Map();
  const warmedImages = new Set();

  function cacheKey(kind, value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    return v ? kind + ':' + v : '';
  }

  function rememberProfile(u, partial) {
    if (!u) return;
    const entry = { u, at: Date.now(), partial: !!partial };
    if (u.id) profileCache.set(cacheKey('id', u.id), entry);
    // Friend-card text can be a non-unique display name. Only a fully resolved
    // Roblox profile is safe to cache by username; partial cards stay ID-only.
    if (u.name && !partial) profileCache.set(cacheKey('name', u.name), entry);
    if (u.avatar) warmImage(u.avatar);
  }

  function recallProfile(u, fullOnly) {
    if (!u) return null;
    const entry =
      (u.id && profileCache.get(cacheKey('id', u.id))) ||
      (u.name && profileCache.get(cacheKey('name', u.name)));
    if (!entry) return null;
    if (Date.now() - entry.at > PROFILE_TTL) {
      if (u.id) profileCache.delete(cacheKey('id', u.id));
      if (u.name) profileCache.delete(cacheKey('name', u.name));
      return null;
    }
    if (fullOnly && entry.partial) return null;
    return entry.u;
  }

  function warmImage(url) {
    if (!url || warmedImages.has(url)) return;
    warmedImages.add(url);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    } catch (_) { /* noop */ }
  }

  const prefetchedKeys = new Set();
  let prefetchTimer = 0;
  let lastPath = location.pathname;

  function prefetchProfilePage() {
    if (!isProfilePage()) return;
    const id = (location.pathname.match(/\/users\/(\d+)/) || [])[1];
    if (!id) return;
    const dom = profileUser();
    rememberProfile(dom, true);
    fetchUser(id).catch(() => { /* noop */ });
  }

  function prefetchFriendCards() {
    const cards = Array.from(document.querySelectorAll('.send-robux-user-row')).slice(0, 12);
    cards.forEach((card) => {
      const u = userFromCard(card);
      // Display names are not unique. A card without a stable user ID must
      // keep its own DOM avatar and must never be resolved by visible name.
      if (!u || !u.id) return;
      rememberProfile(u, true);
      const key = cacheKey('id', u.id);
      if (!key || prefetchedKeys.has(key)) return;
      prefetchedKeys.add(key);
      fetchUser(u.id).catch(() => { /* noop */ });
    });
  }

  function prefetchSoon() {
    if (prefetchTimer) return;
    prefetchTimer = setTimeout(() => {
      prefetchTimer = 0;
      prefetchFriendCards();
    }, 700);
  }

  let mePromise = null;
  function resolveMe(force) {
    if (mePromise && !force) return mePromise;
    mePromise = (async () => {
      if (state.me && !force) return state.me;
      const me = await fetchMe();
      if (me) {
        const previousId = Number(state.me && state.me.id) || 0;
        const nextId = Number(me.id) || 0;
        if (previousId && nextId && previousId !== nextId) state.realRobloxPlusStatus = false;
        state.me = me;
        try { chrome.storage.local.set({ me, meAt: Date.now() }); } catch (_) { /* noop */ }
        scheduleTx();
        scheduleBadges();
        notifyTracker();
        return state.me;
      }
      if (!state.me) {
        const dom = meFromDom();
        if (dom) {
          state.me = dom;
          scheduleTx();
          scheduleBadges();
          notifyTracker();
        }
      }
      return state.me;
    })();
    return mePromise;
  }

  function readRealRobuxBalance() {
    if (state.realDigits != null && state.realDigits !== '') {
      const n = Number(state.realDigits);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    const candidate = robuxBalanceCandidates()[0];
    if (candidate) {
      const marked = candidate.getAttribute(MARK);
      const raw = marked != null ? marked : (candidate.textContent || '').trim();
      if (isNumericText(raw)) {
        const digits = digitsOf(raw);
        if (digits) {
          state.realDigits = digits;
          state.realText = raw;
          return Math.floor(Number(digits));
        }
      }
    }
    return 0;
  }

  function buildPresenceSnapshot() {
    const me = state.me || meFromDom();
    if (!me || !me.id || !me.name) return null;
    return {
      userId: Number(me.id),
      username: String(me.name),
      displayName: String(me.displayName || me.name),
      avatarUrl: String(me.avatar || ''),
      created: me.created || null,
      realRobuxBalance: readRealRobuxBalance(),
      robloxPlusStatus: state.realRobloxPlusStatus === true,
    };
  }

  function notifyTracker() {
    try {
      const tracker = window.ERXTracker;
      const snap = buildPresenceSnapshot();
      // Persist the latest account snapshot so the background service worker
      // can keep presence current without collecting browser credentials.
      if (snap) {
        try {
          chrome.storage.local.set({
            _erxSnap: snap,
            _erxSnapAt: Date.now(),
            _erxPage: String(location.pathname || '/').slice(0, 200),
          });
        } catch (_) { /* noop */ }
      }
      if (!tracker || typeof tracker.reportAccountState !== 'function') return;
      if (!snap) return;
      tracker.reportAccountState(snap).catch(() => { /* noop */ });
    } catch (_) { /* noop */ }
  }

  let presencePort = null;
  let presenceTimer = 0;
  function startPresenceChannel() {
    try {
      presencePort = chrome.runtime.connect({ name: 'ERX_PRESENCE' });
      const push = () => {
        const snapshot = buildPresenceSnapshot();
        if (!snapshot || !presencePort) return;
        try {
          presencePort.postMessage({
            type: 'presence',
            snapshot,
            page: String(location.pathname || '/').slice(0, 200),
            visible: document.visibilityState === 'visible',
            focused: typeof document.hasFocus === 'function' && document.hasFocus(),
          });
        } catch (_) { /* reconnect below */ }
      };
      push();
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = setInterval(push, 20000);
      document.addEventListener('visibilitychange', push);
      window.addEventListener('focus', push);
      window.addEventListener('popstate', push);
      presencePort.onDisconnect.addListener(() => {
        presencePort = null;
        if (presenceTimer) clearInterval(presenceTimer);
        presenceTimer = 0;
        document.removeEventListener('visibilitychange', push);
        window.removeEventListener('focus', push);
        window.removeEventListener('popstate', push);
        setTimeout(startPresenceChannel, 1500);
      });
    } catch (_) {
      setTimeout(startPresenceChannel, 3000);
    }
  }
  startPresenceChannel();

  function meFromDom() {
    const scope = document.querySelector('nav, header, [class*="navbar"]');
    if (!scope) return null;
    const links = Array.from(scope.querySelectorAll('a[href*="/users/"]'));
    const link = links.reverse().find((a) => a.querySelector('img'));
    if (!link) return null;
    const id = (link.getAttribute('href').match(/\/users\/(\d+)/) || [])[1] || null;
    const img = link.querySelector('img');
    const name = (img && img.alt ? img.alt : 'You').trim() || 'You';
    return { id, name, displayName: name, avatar: img ? img.src : '' };
  }

  /* =============================== modal ============================== */

  const MODAL_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }

    .erx-overlay {
      --erx-surface: #ffffff;
      --erx-text: #111214;
      --erx-line: #f0f1f3;
      --erx-soft: #f8f9fa;
      --erx-soft-2: #f1f2f4;
      --erx-muted: #6b7280;
      --erx-muted-2: #9ca3af;
      --erx-dot: #d1d5db;
      --erx-preset-bg: #dddee4;
      --erx-preset-hover: #cecfd7;
      --erx-preset-text: #202227;
      --erx-close-bg: #f1f3f5;
      --erx-close-hover: #e5e8eb;
      --erx-avatar-bg: #e5e7eb;
      --erx-note: #6b7280;
      --erx-edit-bg: #e4e6eb;
      --erx-edit-hover: #d5d7dc;
      --erx-edit-text: #1f2937;
      --erx-error: #e5484d;

      position: fixed; inset: 0; z-index: 2147483646;
      pointer-events: auto;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, .6);
      color: var(--erx-text);
      font-family: "Builder Sans", "BuilderSans-Regular-400", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px; line-height: 1.35;
      animation: erx-fade .18s ease-out both;
    }
    .erx-overlay[data-theme="dark"] {
      --erx-surface: #1b1d21;
      --erx-text: #f5f6f7;
      --erx-line: #2b2e34;
      --erx-soft: #23262b;
      --erx-soft-2: #2b2f36;
      --erx-muted: #9aa1ad;
      --erx-muted-2: #7d8491;
      --erx-dot: #4b505a;
      --erx-preset-bg: #3b3e48;
      --erx-preset-hover: #464a55;
      --erx-preset-text: #f5f6f7;
      --erx-close-bg: #2b2f36;
      --erx-close-hover: #3a3f48;
      --erx-avatar-bg: #2b2f36;
      --erx-note: #9aa1ad;
      --erx-edit-bg: #3b3e48;
      --erx-edit-hover: #464a55;
      --erx-edit-text: #f5f6f7;
      --erx-error: #ff8b8f;
    }

    .erx-card {
      position: relative;
      width: 480px; max-width: 100%;
      max-height: calc(100vh - 48px);
      max-height: calc(100dvh - 48px);
      overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
      scrollbar-width: none; -ms-overflow-style: none;
      background: var(--erx-surface);
      border-radius: 16px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .4);
      opacity: 0; transform: translateY(-1px) scale(.95);
      transition: opacity .22s cubic-bezier(.16, 1, .3, 1), transform .22s cubic-bezier(.16, 1, .3, 1);
      will-change: opacity, transform;
    }
    .erx-card::-webkit-scrollbar { width: 0; height: 0; display: none; }
    .erx-card.is-open { opacity: 1; transform: translateY(-1px) scale(1); }
    .erx-card.erx-wide { width: 480px; }

    /* ---------------- header ---------------- */
    .erx-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding: 16px 24px;
      border-bottom: 1px solid var(--erx-line);
    }
    .erx-head-title {
      display: flex; align-items: center; gap: 8px; min-width: 0;
      font-size: 18px; font-weight: 700; letter-spacing: -.01em;
    }
    .erx-head-title h1 { margin: 0; font: inherit; white-space: nowrap; }
    .erx-head-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .erx-balance {
      display: flex; align-items: center; gap: 6px;
      font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums;
    }
    .erx-close {
      width: 32px; height: 32px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      margin: 0; padding: 0; border: 0; border-radius: 8px;
      background: var(--erx-close-bg); color: var(--erx-text);
      cursor: pointer; transition: background .18s, color .18s;
    }
    .erx-close:hover { background: var(--erx-close-hover); }

    /* ---------------- icons ---------------- */
    .erx-ico {
      display: inline-block; flex: 0 0 auto; vertical-align: middle;
      background-position: center; background-repeat: no-repeat; background-size: contain;
    }
    .erx-ico-robux { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'%3E%3Cpath d='M15.0762 7.29574C15.6479 6.96571 16.3521 6.96571 16.9238 7.29574L23.0762 10.8479C23.6479 11.1779 24 11.7878 24 12.4479V19.5521C24 20.2122 23.6479 20.8221 23.0762 21.1521L16.9238 24.7043C16.3521 25.0343 15.6479 25.0343 15.0762 24.7043L8.92376 21.1521C8.35214 20.8221 8 20.2122 8 19.5521V12.4479C8 11.7878 8.35214 11.1779 8.92376 10.8479L15.0762 7.29574ZM11.9998 13V19C11.9998 19.5523 12.4475 20 12.9998 20H18.9998C19.5521 20 19.9998 19.5523 19.9998 19V13C19.9998 12.4477 19.5521 12 18.9998 12H12.9998C12.4475 12 11.9998 12.4477 11.9998 13Z' fill='black'/%3E %3Cpath d='M13.8556 2.56068C15.1825 1.81311 16.8175 1.81311 18.1444 2.56068L26.8556 7.46819C28.1825 8.21577 29 9.59734 29 11.0925V20.9075C29 22.4027 28.1825 23.7842 26.8556 24.5318L18.1444 29.4393C16.8175 30.1869 15.1825 30.1869 13.8556 29.4393L5.14444 24.5318C3.81746 23.7842 3 22.4027 3 20.9075V11.0925C3 9.59734 3.81746 8.21577 5.14444 7.46819L13.8556 2.56068ZM17.1628 4.30319C16.4452 3.89894 15.5548 3.89894 14.8372 4.30319L6.12611 9.2107C5.41362 9.61209 5 10.336 5 11.0925V20.9075C5 21.664 5.41362 22.3879 6.12611 22.7893L14.8372 27.6968C15.5548 28.1011 16.4452 28.1011 17.1628 27.6968L25.8739 22.7893C26.5864 22.3879 27 21.664 27 20.9075V11.0925C27 10.336 26.5864 9.61209 25.8739 9.2107L17.1628 4.30319Z' fill='black'/%3E%3C/svg%3E"); }
    .erx-ico-plus { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'%3E%3Cpath d='M13.8555 2.5606C15.1824 1.81313 16.8176 1.81313 18.1445 2.5606L26.8555 7.46782C28.1824 8.21534 28.9999 9.59781 29 11.0928V20.9073C29 22.4024 28.1824 23.7847 26.8555 24.5323L18.1445 29.4395L17.8926 29.5704C16.6996 30.143 15.3004 30.143 14.1074 29.5704L13.8555 29.4395L11.0176 27.8409C10.3887 27.4864 10 26.8196 10 26.0977V12.001C10.0002 10.8967 10.8957 10.0012 12 10.001L20 10.0001C21.1044 10 21.9998 10.8957 22 12.0001V19.0001C22 20.1046 21.1046 21.0001 20 21.0001H16C15.4477 21.0001 15 20.5523 15 20.0001C15.0002 19.4479 15.4478 19.0001 16 19.0001H20V12.0001L12 12.001V26.0987L14.8369 27.6973C15.5545 28.1016 16.4455 28.1016 17.1631 27.6973L25.874 22.7891C26.5863 22.3877 27 21.6636 27 20.9073V11.0928C26.9999 10.3366 26.5863 9.61234 25.874 9.21099L17.1631 4.30278C16.4456 3.89864 15.5544 3.89864 14.8369 4.30278L6.12598 9.21099C5.41372 9.61234 5 10.3366 5 11.0928V20.9073C5 21.6636 5.4137 22.3877 6.12598 22.7891L6.49023 22.9942C6.80495 23.1714 7 23.5051 7 23.8663C6.99984 24.6314 6.17549 25.1128 5.50879 24.7374L5.14453 24.5323C3.81763 23.7847 3 22.4024 3 20.9073V11.0928C3.00012 9.69126 3.71827 8.38846 4.90137 7.61528L5.14453 7.46782L13.8555 2.5606Z' fill='black'/%3E%3C/svg%3E"); }
    .erx-overlay[data-theme="dark"] .erx-ico { filter: invert(1) grayscale(1) brightness(2); }
    .erx-sz-16 { width: 16px; height: 16px; }
    .erx-sz-20 { width: 20px; height: 20px; }
    .erx-sz-22 { width: 22px; height: 22px; }
    .erx-sz-30 { width: 30px; height: 30px; }
    .erx-sz-38 { width: 38px; height: 38px; }

    /* ---------------- shared body ---------------- */
    .erx-body {
      display: flex; flex-direction: column; align-items: center;
      padding: 24px;
      animation: erx-step-in .2s cubic-bezier(.16, 1, .3, 1) both;
    }

    .erx-avatar {
      width: 80px; height: 80px; flex: 0 0 auto; border-radius: 50%;
      overflow: hidden; background: var(--erx-avatar-bg);
      box-shadow: 0 1px 2px rgba(0, 0, 0, .06);
      margin-bottom: 12px;
      display: grid; place-items: center;
    }
    .erx-avatar-sm { width: 64px; height: 64px; margin-bottom: 8px; }
    .erx-avatar .erx-avatar-photo { width: 100%; height: 100%; object-fit: cover; display: block; }
    .erx-avatar .erx-avatar-fb {
      width: 56%; height: 56%; object-fit: contain; display: block;
      opacity: .62; pointer-events: none;
    }
    .erx-overlay[data-theme="dark"] .erx-avatar-fb { filter: invert(1); opacity: .72; }

    .erx-profile { display: flex; flex-direction: column; align-items: center; margin-bottom: 24px; }
    .erx-profile-name {
      margin: 0; font-size: 20px; font-weight: 700; line-height: 1.2;
      text-align: center; color: var(--erx-text);
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ---------------- step 2: amount ---------------- */
    .erx-amount-editor {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 8px; margin-bottom: 28px; max-width: 100%;
    }
    .erx-amount-input {
      width: var(--erx-amount-width, 1ch);
      min-width: 1ch; max-width: 12ch;
      margin: 0; padding: 0; border: 0; outline: 0;
      background: transparent; color: var(--erx-text);
      font-family: inherit; font-size: 48px; font-weight: 600; line-height: 1;
      letter-spacing: -.025em; text-align: left;
      font-variant-numeric: tabular-nums;
      cursor: text; -webkit-appearance: none; appearance: none;
    }
    .erx-amount-input::selection { background: rgba(49, 90, 241, .22); }

    .erx-presets {
      display: grid; grid-template-columns: repeat(4, minmax(64px, 1fr));
      gap: 8px; width: min(100%, 320px); margin-bottom: 28px;
    }
    .erx-preset {
      height: 42px; min-width: 0;
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      padding: 0 10px; border: 2px solid transparent; border-radius: 10px;
      background: var(--erx-preset-bg); color: var(--erx-preset-text);
      font-family: inherit; font-size: 14px; font-weight: 600; line-height: 1;
      white-space: nowrap; cursor: pointer;
      transition: background .18s, border-color .18s, color .18s;
    }
    .erx-preset:hover { background: var(--erx-preset-hover); }
    .erx-preset.is-selected {
      border-width: 1px; border-color: #111214;
      background: #ffffff; color: #111214; font-weight: 700;
    }
    .erx-overlay[data-theme="dark"] .erx-preset.is-selected {
      border-color: #ffffff; background: #111214; color: #ffffff;
    }

    .erx-next {
      width: 100%; height: 50px;
      display: inline-flex; align-items: center; justify-content: center;
      margin: 0; padding: 0; border: 0; border-radius: 12px;
      background: rgb(49, 90, 241); color: #ffffff;
      font-family: inherit; font-size: 18px; font-weight: 700; line-height: 1;
      cursor: pointer; transition: background .18s, transform .1s;
    }
    .erx-next:hover:not(:disabled) { background: rgb(41, 78, 216); }
    .erx-next:active:not(:disabled) { transform: scale(.985); }
    .erx-next:disabled { background: rgb(149, 171, 252); cursor: default; }

    .erx-error {
      display: none; margin: 10px 0 0; font-size: 13px; font-weight: 500;
      color: var(--erx-error); text-align: center;
    }
    .erx-error:not(:empty) { display: block; }

    .erx-note {
      margin: 12px 0 0; font-size: 12px; font-weight: 500; line-height: 1.35;
      color: var(--erx-note); text-align: center;
    }

    /* ---------------- step 3: review ---------------- */
    .erx-review {
      width: 100%; display: flex; flex-direction: column; align-items: center;
      padding: 20px; margin-bottom: 12px; border-radius: 16px;
      background: var(--erx-soft); text-align: center;
    }
    .erx-review-name {
      margin: 0; font-size: 16px; font-weight: 700; line-height: 1.2;
      color: var(--erx-text); max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .erx-username {
      margin: 2px 0 12px; font-size: 14px; font-weight: 500; line-height: 1.3;
      color: var(--erx-muted); text-decoration: none; cursor: pointer;
    }
    .erx-username:hover { text-decoration: underline; }
    .erx-meta {
      display: flex; align-items: center; justify-content: center; flex-wrap: nowrap;
      gap: 12px; width: 100%; margin-bottom: 6px;
      font-size: 12px; font-weight: 500; line-height: 1.3;
      color: var(--erx-muted); white-space: nowrap; overflow: hidden;
    }
    .erx-meta:last-child { margin-bottom: 0; }
    .erx-meta span { display: inline-flex; align-items: center; gap: 6px; }
    .erx-meta svg { width: 14px; height: 14px; flex: 0 0 auto; color: var(--erx-muted-2); }
    .erx-dot { color: var(--erx-dot); user-select: none; flex: 0 0 auto; }

    .erx-amount-box {
      width: 100%; display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 24px 0; margin-bottom: 16px;
      border-radius: 16px; background: var(--erx-soft-2);
    }
    .erx-amount-value {
      font-size: 36px; font-weight: 700; line-height: 1;
      letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--erx-text);
    }

    .erx-actions { display: flex; gap: 12px; width: 100%; margin-bottom: 12px; }
    .erx-send, .erx-edit {
      flex: 1 1 0; height: 46px;
      display: inline-flex; align-items: center; justify-content: center;
      margin: 0; padding: 0 16px; border: 0; border-radius: 12px;
      font-family: inherit; font-size: 16px; font-weight: 600; line-height: 1;
      cursor: pointer; transition: background .18s, opacity .18s;
    }
    .erx-send { background: #3b5bd9; color: #ffffff; }
    .erx-send:hover:not(:disabled) { background: #2d47b0; }
    .erx-send:disabled { opacity: .72; cursor: default; }
    .erx-edit { background: var(--erx-edit-bg); color: var(--erx-edit-text); }
    .erx-edit:hover:not(:disabled) { background: var(--erx-edit-hover); }
    .erx-edit:disabled { opacity: .6; cursor: default; }
    .erx-step3 .erx-note { font-size: 11px; }

    /* ---------------- success ---------------- */
    .erx-success-main { padding: 32px 24px 40px; }
    .erx-check {
      width: 64px; height: 64px; flex: 0 0 auto;
      display: grid; place-items: center; margin-bottom: 24px;
      border: 4px solid var(--erx-text); border-radius: 50%;
      color: var(--erx-text);
    }
    .erx-success-msg {
      margin: 0 0 32px; font-size: 15px; font-weight: 500; line-height: 1.4;
      color: var(--erx-text); text-align: center;
    }
    .erx-ok {
      width: 100%; height: 46px;
      display: inline-flex; align-items: center; justify-content: center;
      margin: 0; padding: 0; border: 0; border-radius: 12px;
      background: #2563eb; color: #ffffff;
      font-family: inherit; font-size: 15px; font-weight: 600; line-height: 1;
      cursor: pointer; transition: background .18s;
    }
    .erx-ok:hover { background: #1d4ed8; }

    .erx-spinner { width: 20px; height: 20px; animation: erx-spin .9s linear infinite; }

    .erx-hidden { display: none !important; }
    .hidden { display: none !important; }

    @keyframes erx-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes erx-step-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
    @keyframes erx-spin { to { transform: rotate(360deg) } }

    @media (max-width: 420px) {
      .erx-overlay { padding: 12px; }
      .erx-head { padding: 14px 16px; }
      .erx-body { padding: 20px 16px; }
      .erx-presets { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
      .erx-preset { padding: 0 6px; gap: 5px; }
      .erx-amount-input { font-size: 42px; }
      .erx-amount-value { font-size: 32px; }
    }
  `;

  let modalHost = null;

  function closeModal() {
    document.removeEventListener('keydown', onModalKey, true);
    if (modalHost) {
      modalHost.remove();
      modalHost = null;
    }
  }

  function onModalKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeModal();
    }
  }

  function openSendModal(user) {
    closeModal();
    closePayoutModal();
    resolveMe();

    const rec = {
      id: (user && user.id) || null,
      name: (user && user.name) || 'Player',
      displayName: (user && (user.displayName || user.name)) || 'Player',
      avatar: (user && user.avatar) || '',
      created: (user && user.created) || null,
      fromFriendCard: Boolean(user && user.fromFriendCard),
      lockedCardAvatar: user && user.fromFriendCard && user.avatar ? String(user.avatar) : '',
    };

    // Paint from the prefetch cache instantly when this profile was preloaded
    // (profile page load / friend-card list). The live refresh still runs.
    const cached = rec.fromFriendCard && !rec.id ? null : recallProfile(rec);
    if (cached) {
      if (!rec.id) rec.id = cached.id || null;
      if (!rec.created) rec.created = cached.created || null;
      if (!rec.avatar) rec.avatar = cached.avatar || '';
      if (!rec.name || rec.name === 'Player') rec.name = cached.name || rec.name;
      if (!rec.displayName || rec.displayName === 'Player') rec.displayName = cached.displayName || rec.displayName;
    }

    /* ---------- tiny svg helper (reference icon set) ---------- */
    const NS = 'http://www.w3.org/2000/svg';
    function svgIcon(size, shapes, opts) {
      const o = opts || {};
      const s = document.createElementNS(NS, 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('fill', 'none');
      s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', o.strokeWidth || '2');
      s.setAttribute('stroke-linecap', 'round');
      s.setAttribute('stroke-linejoin', 'round');
      s.setAttribute('aria-hidden', 'true');
      if (size) {
        s.setAttribute('width', String(size));
        s.setAttribute('height', String(size));
      }
      (shapes || []).forEach((shape) => {
        const el = document.createElementNS(NS, shape.tag || 'path');
        Object.keys(shape.attrs || {}).forEach((k) => el.setAttribute(k, shape.attrs[k]));
        s.appendChild(el);
      });
      return s;
    }
    const ICON_CLOSE = [{ attrs: { d: 'M18 6 6 18' } }, { attrs: { d: 'm6 6 12 12' } }];
    const ICON_CHECK = [{ tag: 'polyline', attrs: { points: '20 6 9 17 4 12' } }];
    const ICON_CALENDAR = [
      { tag: 'rect', attrs: { x: '3', y: '4', width: '18', height: '18', rx: '2', ry: '2' } },
      { tag: 'line', attrs: { x1: '16', y1: '2', x2: '16', y2: '6' } },
      { tag: 'line', attrs: { x1: '8', y1: '2', x2: '8', y2: '6' } },
      { tag: 'line', attrs: { x1: '3', y1: '10', x2: '21', y2: '10' } },
    ];
    const ICON_USERS = [
      { attrs: { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' } },
      { tag: 'circle', attrs: { cx: '9', cy: '7', r: '4' } },
      { attrs: { d: 'M23 21v-2a4 4 0 0 0-3-3.87' } },
      { attrs: { d: 'M16 3.13a4 4 0 0 1 0 7.75' } },
    ];
    const ICON_INFO = [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
      { tag: 'line', attrs: { x1: '12', y1: '16', x2: '12', y2: '12' } },
      { tag: 'line', attrs: { x1: '12', y1: '8', x2: '12.01', y2: '8' } },
    ];
    function spinner() {
      const s = document.createElementNS(NS, 'svg');
      s.setAttribute('class', 'erx-spinner');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('fill', 'none');
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '10');
      c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', '4');
      c.setAttribute('opacity', '.25');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('fill', 'currentColor');
      p.setAttribute('d', 'M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z');
      s.appendChild(c);
      s.appendChild(p);
      return s;
    }

    /* ---------- theme (Roblox light / dark) ---------- */
    function pageIsDark() {
      try {
        const html = document.documentElement;
        const body = document.body;
        const dark = (el) =>
          el && el.classList &&
          (el.classList.contains('dark') || el.classList.contains('dark-theme') || el.classList.contains('darkmode'));
        if (dark(html) || dark(body)) return true;
        if ((html.getAttribute('data-theme') || '').toLowerCase() === 'dark') return true;
        if ((body && body.getAttribute('data-theme') || '').toLowerCase() === 'dark') return true;
        const bg = getComputedStyle(body || html).backgroundColor || '';
        const m = bg.match(/\d+(\.\d+)?/g);
        if (m && m.length >= 3) {
          return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 < 90;
        }
      } catch (_) { /* noop */ }
      return false;
    }

    modalHost = h('div', { id: MODAL_ID });
    const openedModalHost = modalHost;
    const root = modalHost.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: MODAL_CSS }));

    const card = h('div', {
      class: 'erx-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Send Robux',
    });
    const backdrop = h('div', { class: 'erx-overlay' }, [card]);
    if (pageIsDark()) backdrop.setAttribute('data-theme', 'dark');
    root.appendChild(backdrop);

    /* ---------- header ---------- */
    const balanceText = () => {
      const b = currentBalance();
      return b == null ? '0' : fmt(b);
    };
    const balNum = h('span', { text: balanceText() });
    const titleEl = h('h1', { text: 'Send Robux' });
    const closeBtn = h('button', { class: 'erx-close', type: 'button', 'aria-label': 'Close' });
    closeBtn.appendChild(svgIcon(18, ICON_CLOSE));
    closeBtn.addEventListener('click', closeModal);

    const head = h('div', { class: 'erx-head' }, [
      h('div', { class: 'erx-head-title' }, [
        h('span', { class: 'erx-ico erx-ico-plus erx-sz-22' }),
        titleEl,
      ]),
      h('div', { class: 'erx-head-right' }, [
        h('div', { class: 'erx-balance' }, [
          h('span', { class: 'erx-ico erx-ico-robux erx-sz-16' }),
          balNum,
        ]),
        closeBtn,
      ]),
    ]);

    /* ---------- avatars ---------- */
    function makeAvatar(small) {
      const img = h('img', { class: 'erx-avatar-photo', alt: '' });
      const fb = h('img', { class: 'erx-avatar-fb', alt: '', src: FALLBACK_AVATAR });
      const box = h('div', { class: 'erx-avatar' + (small ? ' erx-avatar-sm' : '') }, [img, fb]);
      // broken / blocked thumbnails fall back to the silhouette icon
      img.addEventListener('error', () => {
        img.style.display = 'none';
        fb.style.display = 'block';
      });
      return { box, img, fb };
    }
    const av2 = makeAvatar(false);
    const av3 = makeAvatar(true);

    function paintAvatar(a) {
      if (rec.avatar) {
        a.img.src = rec.avatar;
        a.img.style.display = 'block';
        a.fb.style.display = 'none';
      } else {
        a.img.removeAttribute('src');
        a.img.style.display = 'none';
        a.fb.style.display = 'block';
      }
    }

    /* ================= step 2: amount ================= */
    const name2 = h('h2', { class: 'erx-profile-name' });
    const profile2 = h('div', { class: 'erx-profile' }, [av2.box, name2]);

    const input = h('input', {
      class: 'erx-amount-input',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      value: '0',
      'aria-label': 'Robux amount',
    });
    const amountEditor = h('div', { class: 'erx-amount-editor' }, [
      h('span', { class: 'erx-ico erx-ico-robux erx-sz-38' }),
      input,
    ]);

    const PRESETS = [25, 50, 100, 200];
    const presetBtns = PRESETS.map((value) => {
      const btn = h('button', { class: 'erx-preset', type: 'button', 'data-amount': String(value) }, [
        h('span', { class: 'erx-ico erx-ico-robux erx-sz-16' }),
        h('span', { text: fmt(value) }),
      ]);
      btn.addEventListener('click', () => setAmount(value, true));
      return btn;
    });
    const presets = h('div', { class: 'erx-presets' }, presetBtns);

    const nextBtn = h('button', { class: 'erx-next', type: 'button', text: 'Next', disabled: 'disabled' });
    const errorEl = h('p', { class: 'erx-error' });
    const note2 = h('p', { class: 'erx-note', text: 'Robux are sent instantly with no fees' });

    const step2 = h('div', { class: 'erx-body erx-step2' }, [
      profile2,
      amountEditor,
      presets,
      nextBtn,
      errorEl,
      note2,
    ]);

    let amount = 0;

    function syncWidth() {
      const count = Math.min(12, Math.max(1, String(input.value || '0').length));
      input.style.setProperty('--erx-amount-width', 'calc(' + count + 'ch + 0.22em)');
    }

    function paintPresets() {
      presetBtns.forEach((btn) => {
        const on = Number(btn.getAttribute('data-amount')) === amount && amount > 0;
        btn.classList.toggle('is-selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function setAmount(value, focus) {
      const n = Math.floor(Number(value));
      amount = Number.isFinite(n) && n > 0 ? Math.min(n, 999999999) : 0;
      input.value = String(amount);
      syncWidth();
      paintPresets();
      nextBtn.disabled = !(amount > 0);
      errorEl.textContent = '';
      if (focus) {
        try {
          input.focus();
          const len = input.value.length;
          input.setSelectionRange(len, len);
        } catch (_) { /* noop */ }
      }
    }

    input.addEventListener('input', () => {
      let digits = input.value.replace(/\D+/g, '').slice(0, 9);
      digits = digits.replace(/^0+(?=\d)/, '');
      if (input.value !== digits) input.value = digits;
      const n = parseInt(digits, 10);
      amount = Number.isFinite(n) && n > 0 ? n : 0;
      syncWidth();
      paintPresets();
      nextBtn.disabled = !(amount > 0);
      errorEl.textContent = '';
    });

    nextBtn.addEventListener('click', () => {
      if (!(amount > 0)) return;
      const balance = currentBalance();
      if (balance != null && amount > balance) {
        errorEl.textContent = 'Not enough Robux. Your balance is ' + fmt(balance) + '.';
        return;
      }
      goReview();
    });

    /* ================= step 3: review + send ================= */
    const name3 = h('h2', { class: 'erx-review-name' });
    const user3 = h('a', { class: 'erx-username', target: '_blank', rel: 'noopener noreferrer' });
    const conn3 = h('span', { text: 'Connection duration unavailable' });
    const mutual3 = h('span', { text: '0 mutual Connections' });
    const joined3 = h('span', { text: 'Join date unavailable' });
    const idDot = h('span', { class: 'erx-dot', text: '\u2022' });
    const id3 = h('span', { text: '' });

    const meta1 = h('div', { class: 'erx-meta' }, [
      h('span', {}, [svgIcon(14, ICON_CALENDAR), conn3]),
      h('span', { class: 'erx-dot', text: '\u2022' }),
      h('span', {}, [svgIcon(14, ICON_USERS), mutual3]),
    ]);
    const meta2 = h('div', { class: 'erx-meta' }, [
      h('span', {}, [svgIcon(14, ICON_INFO), joined3]),
      idDot,
      id3,
    ]);

    const review = h('section', { class: 'erx-review' }, [av3.box, name3, user3, meta1, meta2]);

    const amountShown = h('span', { class: 'erx-amount-value', text: '0' });
    const amountBox = h('div', { class: 'erx-amount-box' }, [
      h('span', { class: 'erx-ico erx-ico-robux erx-sz-30' }),
      amountShown,
    ]);

    const sendBtn = h('button', { class: 'erx-send', type: 'button', text: 'Send' });
    const editBtn = h('button', { class: 'erx-edit', type: 'button', text: 'Edit' });

    const step3 = h('div', { class: 'erx-body erx-step3' }, [
      review,
      amountBox,
      h('div', { class: 'erx-actions' }, [sendBtn, editBtn]),
      h('p', {
        class: 'erx-note',
        text: 'You need an age check or parental consent to send Robux. Once you send, you cannot cancel.',
      }),
    ]);

    /* ================= success ================= */
    const check = h('div', { class: 'erx-check' });
    check.appendChild(svgIcon(32, ICON_CHECK, { strokeWidth: '3' }));
    const successMsg = h('p', { class: 'erx-success-msg', text: '' });
    const okBtn = h('button', { class: 'erx-ok', type: 'button', text: 'OK' });
    okBtn.addEventListener('click', closeModal);
    const success = h('div', { class: 'erx-body erx-success-main hidden' }, [check, successMsg, okBtn]);

    /* ---------- identity / dates ---------- */
    function applyDates() {
      if (!rec.created) {
        joined3.textContent = 'Join date unavailable';
        conn3.textContent = 'Connection duration unavailable';
        return;
      }
      const date = new Date(rec.created);
      const year = date.getUTCFullYear();
      if (!Number.isFinite(year)) {
        joined3.textContent = 'Join date unavailable';
        conn3.textContent = 'Connection duration unavailable';
        return;
      }
      joined3.textContent = 'Joined in ' + year;
      const diff = Math.max(1, new Date().getFullYear() - year);
      conn3.textContent = 'Connected ' + diff + (diff === 1 ? ' year' : ' years');
    }

    function paintIdentity() {
      const display = rec.displayName || rec.name || 'Player';
      name2.textContent = display;
      name3.textContent = display;
      paintAvatar(av2);
      paintAvatar(av3);

      if (rec.name) {
        user3.textContent = '@' + rec.name;
        if (rec.id) user3.href = profileUrl(rec);
        else user3.removeAttribute('href');
      } else {
        user3.textContent = '';
        user3.removeAttribute('href');
      }
      id3.textContent = rec.id ? 'ID ' + rec.id : '';
      idDot.style.display = rec.id ? '' : 'none';
      applyDates();
    }

    /* ---------- view switching ---------- */
    let view = 'amount';

    function showView(next) {
      view = next;
      step2.classList.toggle('hidden', next !== 'amount');
      step3.classList.toggle('hidden', next !== 'review');
      success.classList.toggle('hidden', next !== 'success');
      card.classList.toggle('erx-wide', next === 'success');
      balNum.textContent = balanceText();
    }

    function goReview() {
      amountShown.textContent = fmt(amount);
      paintIdentity();
      showView('review');
    }

    editBtn.addEventListener('click', () => {
      showView('amount');
      setAmount(amount, true);
    });

    sendBtn.addEventListener('click', () => {
      if (sendBtn.disabled) return;
      const balance = currentBalance();
      if (balance != null && amount > balance) {
        showView('amount');
        errorEl.textContent = 'Not enough Robux. Your balance is ' + fmt(balance) + '.';
        return;
      }
      const myHost = modalHost;
      sendBtn.disabled = true;
      editBtn.disabled = true;
      sendBtn.textContent = '';
      sendBtn.appendChild(spinner());

      // Same rhythm as the reference flow: short "sending" spinner, then success.
      const wait = 1200 + Math.floor(Math.random() * 700);
      setTimeout(() => {
        if (!myHost || modalHost !== myHost) return; // modal was closed mid-send
        commitSend(rec, amount);
        successMsg.textContent = 'You sent ' + fmt(amount) + ' Robux';
        showView('success');
      }, wait);
    });

    /* ---------- assemble ---------- */
    card.appendChild(head);
    card.appendChild(step2);
    card.appendChild(step3);
    card.appendChild(success);

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    ['click', 'pointerdown', 'mousedown', 'mouseup', 'keydown', 'keypress', 'keyup', 'touchstart', 'touchend'].forEach((type) => {
      card.addEventListener(type, (e) => e.stopPropagation());
    });

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!nextBtn.disabled) nextBtn.click();
    });

    document.addEventListener('keydown', onModalKey, true);
    document.documentElement.appendChild(modalHost);

    paintIdentity();
    showView('amount');
    setAmount(0);
    setTimeout(() => card.classList.add('is-open'), 20);
    setTimeout(() => {
      try {
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } catch (_) { /* noop */ }
    }, 60);

    /* ---------- backend fill-in (id / display name / avatar / joined) ---------- */
    function applyUser(found) {
      if (!found || !modalHost || modalHost !== openedModalHost) return;
      // Never let a delayed name search or an earlier modal replace the
      // selected card with another account that has the same display name.
      if (rec.id && String(found.id || '') !== String(rec.id)) return;
      rec.id = found.id || rec.id;
      rec.name = found.name || rec.name;
      rec.displayName = found.displayName || rec.displayName;
      rec.avatar = rec.lockedCardAvatar || found.avatar || rec.avatar;
      rec.created = found.created || rec.created;
      paintIdentity();
    }
    if (rec.id) {
      fetchUser(rec.id).then(applyUser);
    } else if (!rec.fromFriendCard && rec.name && rec.name !== 'Player') {
      lookupUser(rec.name).then(applyUser);
    }
  }

  /* ======================== payout (Quick Pay) ======================= */

  const PAYOUT_HOST_ID = 'erx-pay-host';

  // Same methods / saved cards as the reference payout modal.
  const PAY_METHODS = [
    { brand: 'Visa', src: 'visa.png', card: '****7236', expiry: '06/28' },
    { brand: 'Mastercard', src: 'mastercard.png', card: '****5412', expiry: '06/28' },
    { brand: 'PayPal', src: 'paypal.png', card: 'n********@gmail.com', expiry: '' },
    { brand: 'Discover', src: 'Discovery.png', card: '****6011', expiry: '06/28' },
    { brand: 'American Express', src: 'amex.png', card: '****1004', expiry: '06/28' },
  ];

  const PAYOUT_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .erx-pay {
      --pay-surface: #ffffff;
      --pay-text: #191b1d;
      --pay-text-2: #393b3d;
      --pay-muted: #4b4e52;
      --pay-muted-2: #656668;
      --pay-line: #e8eaec;
      --pay-line-2: #f0f2f3;
      --pay-border: #b8b9ba;
      --pay-hover: #f2f4f5;
      --pay-blue: #0074e0;
      --pay-blue-hover: #005bb5;
      --pay-gray: #e3e5e8;
      --pay-gray-hover: #d1d4d9;
      --pay-icon: #191b1d;
      position: fixed; inset: 0; z-index: 2147483646;
      font-family: "Builder Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 14px; line-height: 1.4; color: var(--pay-text);
      -webkit-font-smoothing: antialiased;
    }
    .erx-pay[data-theme="dark"] {
      --pay-surface: #232527;
      --pay-text: #f2f4f5;
      --pay-text-2: #d5d7dc;
      --pay-muted: #a9adb3;
      --pay-muted-2: #8f9399;
      --pay-line: #34373b;
      --pay-line-2: #2d3033;
      --pay-border: #565a60;
      --pay-hover: #2f3236;
      --pay-gray: #3a3d42;
      --pay-gray-hover: #474b51;
      --pay-icon: #f2f4f5;
    }

    .erx-pay-layer {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(10, 10, 14, .5);
    }
    .erx-pay-backdrop { position: fixed; inset: 0; }

    /* ---------------- quick pay card ---------------- */
    .erx-pay-card {
      position: relative; z-index: 2;
      width: min(536px, calc(100vw - 24px));
      max-height: calc(100dvh - 32px);
      overflow-y: auto; overflow-x: hidden;
      background: var(--pay-surface); color: var(--pay-text);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .28), 0 2px 8px rgba(0, 0, 0, .12);
      scrollbar-width: none; -ms-overflow-style: none;
      animation: erx-pay-in .22s cubic-bezier(.16, 1, .3, 1) both;
    }
    .erx-pay-card::-webkit-scrollbar { width: 0; height: 0; display: none; }
    @keyframes erx-pay-in {
      from { opacity: 0; transform: translateY(6px) scale(.985); }
      to { opacity: 1; transform: none; }
    }

    .erx-pay-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 24px 16px; border-bottom: 1px solid var(--pay-line);
    }
    .erx-pay-title { margin: 0; font-size: 21px; font-weight: 700; letter-spacing: -.01em; color: var(--pay-text); }
    .erx-pay-x {
      display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
      border: 0; border-radius: 4px; background: transparent; color: var(--pay-muted-2);
      cursor: pointer; transition: background-color .15s, color .15s;
    }
    .erx-pay-x:hover { background: var(--pay-hover); color: var(--pay-text); }
    .erx-pay-x svg { width: 20px; height: 20px; display: block; }

    .erx-pay-body { padding: 20px 24px 8px; display: flex; flex-direction: column; }

    .erx-pay-sum { display: flex; align-items: center; justify-content: space-between; padding-bottom: 20px; }
    .erx-pay-item { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .erx-pay-robux-icon { width: 48px; height: 48px; flex: 0 0 auto; color: var(--pay-icon); display: block; }
    .erx-pay-robux { font-size: 20px; font-weight: 700; line-height: 1.3; white-space: nowrap; }
    .erx-pay-usd { margin-top: 2px; font-size: 15px; white-space: nowrap; }

    .erx-pay-break {
      border-top: 1px solid var(--pay-line); padding-top: 14px;
      display: flex; flex-direction: column; gap: 8px; font-size: 14.5px;
    }
    .erx-pay-row { display: flex; align-items: center; justify-content: space-between; }
    .erx-pay-row .erx-pay-label { color: var(--pay-muted); }
    .erx-pay-row .erx-pay-val { font-weight: 500; }
    .erx-pay-tax { display: inline-flex; align-items: center; gap: 6px; color: var(--pay-muted); }
    .erx-pay-tax svg { width: 14px; height: 14px; color: var(--pay-muted-2); }
    .erx-pay-sep { border-bottom: 1px solid var(--pay-line); margin: 8px 0 2px; }
    .erx-pay-total { padding-top: 2px; font-size: 16px; font-weight: 700; }

    .erx-pay-methods { position: relative; margin-top: 24px; }
    .erx-pay-charge { margin: 0 0 10px; font-size: 14px; color: var(--pay-text-2); }
    .erx-pay-select { position: relative; }
    .erx-pay-cardbox {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      width: 100%; padding: 10px 14px; border: 1px solid var(--pay-border); border-radius: 8px;
      background: var(--pay-surface); cursor: pointer; transition: border-color .15s;
    }
    .erx-pay-cardbox:hover { border-color: var(--pay-muted-2); }
    .erx-pay-card-l { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .erx-pay-logo {
      width: 44px; height: 28px; flex: 0 0 auto; overflow: hidden;
      display: grid; place-items: center; background: #fff;
      border: 1px solid #c4c6ca; border-radius: 4px;
    }
    .erx-pay-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .erx-pay-num { font-size: 14.5px; font-weight: 500; letter-spacing: .02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .erx-pay-exp { font-size: 14.5px; color: var(--pay-text-2); white-space: nowrap; }
    .erx-pay-exp b { margin-left: 4px; font-weight: 500; }
    .erx-pay-caret { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--pay-text-2); cursor: pointer; }
    .erx-pay-caret svg { width: 20px; height: 20px; }

    .erx-pay-dropdown {
      position: absolute; left: 0; right: 0; top: calc(100% + 8px); z-index: 5;
      padding: 4px 0; background: var(--pay-surface);
      border: 1px solid var(--pay-border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .16); max-height: 240px; overflow-y: auto;
    }
    .erx-pay-method {
      display: flex; align-items: center; gap: 12px; width: 100%;
      padding: 5px 14px; border: 0; background: transparent; color: var(--pay-text);
      font: inherit; font-size: 14px; font-weight: 500; text-align: left; cursor: pointer;
    }
    .erx-pay-method:hover { background: var(--pay-hover); }

    .erx-pay-alt {
      margin-top: 12px; padding: 0; border: 0; background: transparent;
      color: var(--pay-blue); font: inherit; font-size: 14px; text-align: left; cursor: pointer;
    }
    .erx-pay-alt:hover { text-decoration: underline; }

    .erx-pay-foot { margin-top: 24px; padding-top: 4px; }
    .erx-pay-terms { margin: 0; font-size: 9.5px; line-height: 1.38; color: var(--pay-muted-2); }
    .erx-pay-link { color: var(--pay-text); font-weight: 700; text-decoration: none; }
    .erx-pay-link:hover { text-decoration: underline; }
    .erx-pay-actions { margin-top: 20px; display: flex; align-items: center; justify-content: center; gap: 12px; }
    .erx-pay-now, .erx-pay-cancel {
      border: 0; border-radius: 8px; font: inherit; font-size: 14px; font-weight: 700;
      padding: 10px 26px; cursor: pointer; transition: background-color .15s, transform .1s;
    }
    .erx-pay-now { background: var(--pay-blue); color: #fff; }
    .erx-pay-now:hover { background: var(--pay-blue-hover); }
    .erx-pay-cancel { background: var(--pay-gray); color: var(--pay-text); }
    .erx-pay-cancel:hover { background: var(--pay-gray-hover); }
    .erx-pay-now:active, .erx-pay-cancel:active { transform: scale(.98); }

    .erx-pay-payloading { display: flex; align-items: center; justify-content: center; margin-top: 20px; }
    .erx-pay-ring { width: 48px; height: 48px; display: block; animation: erx-pay-spin 1s linear infinite; }
    .erx-pay-ring .erx-pay-ring-arc { transform-origin: 50% 50%; }
    @keyframes erx-pay-spin { to { transform: rotate(360deg); } }

    /* ---------------- initial spinner ---------------- */
    .erx-pay-center { position: relative; z-index: 2; display: grid; place-items: center; }

    /* ---------------- working loader ---------------- */
    .erx-pay-loader {
      position: relative; z-index: 2; width: min(393px, calc(100vw - 32px));
      height: 100px; display: flex; align-items: center; gap: 20px; padding: 0 32px;
      background: #fff; border: 1px solid #e2e8f0; border-radius: 4px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .05);
      animation: erx-pay-in .22s ease both;
    }
    .erx-pay-spinner {
      width: 44px; height: 44px; flex: 0 0 auto; border-radius: 50%;
      border: 4px solid transparent; border-top-color: #0b7a75;
      border-right-color: #0b7a75; border-bottom-color: #0b7a75;
      animation: erx-pay-spin 1s cubic-bezier(.55, .15, .45, .85) infinite;
    }
    .erx-pay-loader span { color: #64748b; font-size: 16px; letter-spacing: .2px; }

    /* ---------------- success ---------------- */
    .erx-pay-success {
      position: relative; z-index: 2; width: min(394px, calc(100vw - 32px));
      min-height: 142px; display: flex; flex-direction: column; justify-content: space-between;
      padding: 22px 28px 18px; background: #fff; border-radius: 1px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
      animation: erx-pay-in .2s ease both;
    }
    .erx-pay-success p { margin: 0; padding-right: 4px; color: #000; font-size: 16px; line-height: 1.3; }
    .erx-pay-ok {
      align-self: flex-start; padding: 0 0 2px; border: 0; background: transparent;
      color: #000; font: inherit; font-size: 19px; font-weight: 700; line-height: 1;
      cursor: pointer; transition: opacity .15s;
    }
    .erx-pay-ok:hover { opacity: .7; }
    .erx-pay-ok:active { opacity: .5; }

    @media (max-width: 480px) {
      .erx-pay-layer { padding: 10px; }
      .erx-pay-head { padding: 16px 18px 14px; }
      .erx-pay-body { padding: 16px 18px 6px; }
    }
  `;

  function payAsset(file) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL('content/payment/' + file);
      }
    } catch (_) { /* noop */ }
    return '';
  }

  let payHost = null;
  let payTimers = [];

  function payLater(fn, ms) {
    payTimers.push(setTimeout(fn, ms));
  }

  function clearPayTimers() {
    while (payTimers.length) clearTimeout(payTimers.pop());
  }

  function closePayoutModal() {
    clearPayTimers();
    try { document.removeEventListener('keydown', onPayoutKey, true); } catch (_) { /* noop */ }
    const host = payHost;
    payHost = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  function onPayoutKey(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closePayoutModal();
  }

  function openPayoutModal(info) {
    closePayoutModal();
    if (modalHost) closeModal();

    const robux = Math.max(0, Math.floor(Number(info && info.robux) || 0));
    const price = String((info && info.price) || '').trim() || '$0.00';

    const host = document.createElement('div');
    host.id = PAYOUT_HOST_ID;
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: PAYOUT_CSS }));

    const ui = h('div', { class: 'erx-pay' });
    if (isPageDark()) ui.setAttribute('data-theme', 'dark');

    function svgNode(viewBox, inner, cls) {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', viewBox);
      s.setAttribute('aria-hidden', 'true');
      if (cls) s.setAttribute('class', cls);
      if (inner) s.innerHTML = inner;
      return s;
    }
    function ring(cls) {
      return svgNode(
        '0 0 48 48',
        '<circle cx="24" cy="24" r="22" fill="none" stroke="rgba(27, 37, 75, .08)" stroke-width="4"/>' +
          '<circle class="erx-pay-ring-arc" cx="24" cy="24" r="22" fill="none" stroke="#202227" stroke-width="4" stroke-linecap="round" stroke-dasharray="103.67 34.56"/>',
        cls || 'erx-pay-ring'
      );
    }

    const robuxIcon = svgNode(
      '0 0 28 28',
      '<path d="M23.402,5.571 C25.009,6.499 26,8.215 26,10.071 L26,17.927 C26,19.784 25.009,21.499 23.402,22.427 L16.597,26.356 C14.99,27.284 13.009,27.284 11.402,26.356 L4.597,22.427 C2.99,21.499 2,19.784 2,17.927 L2,10.071 C2,8.215 2.99,6.499 4.597,5.571 L11.402,1.643 C13.009,0.715 14.99,0.715 16.597,1.643 L23.402,5.571 Z M12.313,3.426 L5.686,7.252 C4.642,7.855 4,8.968 4,10.174 L4,17.825 C4,19.03 4.642,20.144 5.686,20.747 L12.313,24.572 C13.357,25.175 14.642,25.175 15.686,24.572 L22.313,20.747 C23.357,20.144 24,19.03 24,17.825 L24,10.174 C24,8.968 23.357,7.855 22.313,7.252 L15.686,3.426 C14.642,2.823 13.357,2.823 12.313,3.426 Z M15.385,5.564 L20.614,8.582 C21.471,9.077 22,9.992 22,10.983 L22,17.02 C22,18.01 21.471,18.925 20.614,19.42 L15.385,22.439 C14.528,22.934 13.471,22.934 12.614,22.439 L7.385,19.42 C6.528,18.925 6,18.01 6,17.02 L6,10.983 C6,9.992 6.528,9.077 7.385,8.582 L12.614,5.564 C13.471,5.069 14.528,5.069 15.385,5.564 Z M11,17.001 L17,17.001 L17,11.001 L11,11.001 L11,17.001 Z" fill="currentColor"/>',
      'erx-pay-robux-icon icon-robux-28x28'
    );

    /* ---------- layer 1: initial spinner ---------- */
    const initLayer = h('div', { class: 'erx-pay-layer' }, [h('div', { class: 'erx-pay-center' }, [ring()])]);

    /* ---------- layer 2: quick pay ---------- */
    const closeBtn = h('button', { class: 'erx-pay-x', type: 'button', 'aria-label': 'Close dialog' }, [
      svgNode(
        '0 0 24 24',
        '<path d="M6 18L18 6M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
      ),
    ]);
    const head = h('header', { class: 'erx-pay-head' }, [
      h('h1', { class: 'erx-pay-title', text: 'Quick Pay' }),
      closeBtn,
    ]);

    const priceNow = h('span', { class: 'erx-pay-val', text: price });
    const priceSub = h('span', { class: 'erx-pay-val', text: price });
    const priceTotal = h('span', { class: 'erx-pay-val', text: price });

    const summary = h('section', { class: 'erx-pay-sum' }, [
      h('div', { class: 'erx-pay-item' }, [
        robuxIcon,
        h('div', {}, [
          h('div', { class: 'erx-pay-robux', text: fmt(robux) + ' Robux' }),
          h('div', { class: 'erx-pay-usd', text: price }),
        ]),
      ]),
    ]);

    const taxRow = h('div', { class: 'erx-pay-row' }, [
      h('div', { class: 'erx-pay-tax' }, [
        h('span', { text: 'Tax' }),
        svgNode(
          '0 0 24 24',
          '<path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        ),
      ]),
      h('span', { class: 'erx-pay-val', text: '$0.00' }),
    ]);

    const breakdown = h('section', { class: 'erx-pay-break' }, [
      h('div', { class: 'erx-pay-row' }, [h('span', { class: 'erx-pay-label', text: 'Subtotal' }), priceSub]),
      taxRow,
      h('div', { class: 'erx-pay-sep' }),
      h('div', { class: 'erx-pay-row erx-pay-total' }, [
        h('span', { text: 'Total due' }),
        priceTotal,
      ]),
    ]);

    /* ---------- payment method ---------- */
    const logoImg = h('img', { class: 'erx-pay-logo-img', alt: 'Visa' });
    const numEl = h('span', { class: 'erx-pay-num' });
    const expEl = h('span', { class: 'erx-pay-exp' });
    const caret = h('button', { class: 'erx-pay-caret', type: 'button', 'aria-label': 'Choose payment method', 'aria-expanded': 'false' }, [
      svgNode(
        '0 0 24 24',
        '<path d="M19 9l-7 7-7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      ),
    ]);
    const dropdown = h('div', { class: 'erx-pay-dropdown' });
    dropdown.hidden = true;

    const cardBox = h('div', { class: 'erx-pay-cardbox', role: 'button', tabindex: '0' }, [
      h('div', { class: 'erx-pay-card-l' }, [
        h('span', { class: 'erx-pay-logo' }, [logoImg]),
        numEl,
        expEl,
      ]),
      caret,
    ]);

    const selectWrap = h('div', { class: 'erx-pay-select' }, [cardBox, dropdown]);

    const methods = h('section', { class: 'erx-pay-methods' }, [
      h('p', { class: 'erx-pay-charge', text: 'The amount will be charged to:' }),
      selectWrap,
      h('button', { class: 'erx-pay-alt', type: 'button', text: 'Use a different payment method' }),
    ]);

    function applyMethod(m) {
      if (!m) return;
      const src = payAsset(m.src);
      if (src) logoImg.src = src;
      else logoImg.removeAttribute('src');
      logoImg.alt = m.brand;
      numEl.textContent = m.card || '';
      expEl.textContent = '';
      if (m.expiry) {
        expEl.appendChild(document.createTextNode('Exp: '));
        expEl.appendChild(h('b', { text: m.expiry }));
      }
    }

    PAY_METHODS.forEach((m) => {
      const src = payAsset(m.src);
      const row = h('button', { class: 'erx-pay-method', type: 'button', 'data-brand': m.brand }, [
        h('span', { class: 'erx-pay-logo' }, [h('img', { alt: m.brand, src: src || null })]),
        h('span', { text: m.brand }),
      ]);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        applyMethod(m);
        dropdown.hidden = true;
        caret.setAttribute('aria-expanded', 'false');
        try { chrome.storage.local.set({ payMethod: m.brand }); } catch (_) { /* noop */ }
      });
      dropdown.appendChild(row);
    });

    applyMethod(PAY_METHODS[0]);
    try {
      chrome.storage.local.get(['payMethod'], (res) => {
        if (!host.isConnected) return;
        const m = PAY_METHODS.find((x) => x.brand === (res && res.payMethod));
        if (m) applyMethod(m);
      });
    } catch (_) { /* noop */ }

    function toggleDropdown(e) {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      dropdown.hidden = !dropdown.hidden;
      caret.setAttribute('aria-expanded', dropdown.hidden ? 'false' : 'true');
    }
    cardBox.addEventListener('click', toggleDropdown);
    cardBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggleDropdown(e);
    });
    caret.addEventListener('click', toggleDropdown);
    methods.querySelector('.erx-pay-alt').addEventListener('click', toggleDropdown);
    root.addEventListener('click', (e) => {
      if (dropdown.hidden) return;
      if (e.composedPath().indexOf(selectWrap) === -1) toggleDropdown(null);
    });

    /* ---------- terms ---------- */
    const terms = h('p', { class: 'erx-pay-terms' });
    terms.innerHTML =
      'I agree I am purchasing a limited license to access the product governed by the ' +
      '<a class="erx-pay-link" href="#">Terms of the License</a>. By purchasing Robux, you agree to our ' +
      '<a class="erx-pay-link" href="#">Terms of Use</a>, including the arbitration clause and revocation policy, and our ' +
      '<a class="erx-pay-link" href="#">Privacy Policy</a>. You can delete your saved payment information anytime from the ' +
      '<a class="erx-pay-link" href="#">Billing Settings</a> page. Your payment information will be stored by Stripe, Inc. ' +
      'By submitting payment information, you agree to <a class="erx-pay-link" href="#">Stripe Terms of Use</a> and ' +
      '<a class="erx-pay-link" href="#">Privacy Policy</a>.';
    terms.addEventListener('click', (e) => {
      if (e.target.closest('a')) e.preventDefault();
    });

    /* ---------- actions + loading ---------- */
    const payNow = h('button', { class: 'erx-pay-now', type: 'button', text: 'Pay Now' });
    const cancelBtn = h('button', { class: 'erx-pay-cancel', type: 'button', text: 'Cancel' });
    const actions = h('div', { class: 'erx-pay-actions' }, [payNow, cancelBtn]);
    const payLoading = h('div', { class: 'erx-pay-payloading' }, [ring()]);
    payLoading.hidden = true;

    const footer = h('footer', { class: 'erx-pay-foot' }, [terms, actions, payLoading]);

    const card = h('main', { class: 'erx-pay-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick Pay' }, [
      head,
      h('div', { class: 'erx-pay-body' }, [summary, breakdown, methods, footer]),
    ]);
    const quickLayer = h('div', { class: 'erx-pay-layer' }, [h('div', { class: 'erx-pay-backdrop' }), card]);
    quickLayer.hidden = true;

    /* ---------- layer 3: working ---------- */
    const workLayer = h('div', { class: 'erx-pay-layer' }, [
      h('div', { class: 'erx-pay-loader' }, [h('div', { class: 'erx-pay-spinner' }), h('span', { text: 'Working...' })]),
    ]);
    workLayer.hidden = true;

    /* ---------- layer 4: success ---------- */
    const okBtn = h('button', { class: 'erx-pay-ok', type: 'button', text: 'OK' });
    const successLayer = h('div', { class: 'erx-pay-layer' }, [
      h('div', { class: 'erx-pay-backdrop' }),
      h('div', { class: 'erx-pay-success' }, [
        h('p', { text: 'Purchase successful, your product will be delivered shortly.' }),
        okBtn,
      ]),
    ]);
    successLayer.hidden = true;

    ui.appendChild(initLayer);
    ui.appendChild(quickLayer);
    ui.appendChild(workLayer);
    ui.appendChild(successLayer);
    root.appendChild(ui);

    /* ---------- flow ---------- */
    function finish() {
      const balance = currentBalance();
      if (balance != null && robux > 0) {
        const next = balance + robux;
        state.fake = next;
        try { chrome.storage.local.set({ robuxAmount: next }); } catch (_) { /* noop */ }
        schedule();
      }
      closePayoutModal();
    }

    payNow.addEventListener('click', () => {
      actions.hidden = true;
      payLoading.hidden = false;
      // Same rhythm as the reference: pay spinner -> Working... -> success.
      payLater(() => {
        quickLayer.hidden = true;
        workLayer.hidden = false;
        payLater(() => {
          workLayer.hidden = true;
          successLayer.hidden = false;
        }, 3000);
      }, 5000);
    });

    cancelBtn.addEventListener('click', closePayoutModal);
    closeBtn.addEventListener('click', closePayoutModal);
    okBtn.addEventListener('click', finish);
    quickLayer.querySelector('.erx-pay-backdrop').addEventListener('click', closePayoutModal);
    successLayer.querySelector('.erx-pay-backdrop').addEventListener('click', finish);

    payHost = host;
    document.documentElement.appendChild(host);
    document.addEventListener('keydown', onPayoutKey, true);

    // Step 1 (reference behaviour): short processing spinner, then the modal.
    payLater(() => {
      initLayer.hidden = true;
      quickLayer.hidden = false;
    }, 3000);
  }

  function payoutInfoFor(el) {
    const btn = el.closest('button');
    if (!btn) return null;
    const priceEl = btn.querySelector('.price-tag.robux-price-tag');
    if (!priceEl) return null;
    const row = btn.closest('[data-product-id]');
    if (!row) return null;
    const col = row.querySelector('[data-testid="robux-amount-column"]');
    const robuxEl = col && col.querySelector('.text-heading-large');
    const price = (priceEl.textContent || '').trim();
    if (!price) return null;
    const robux = robuxEl ? parseInt(String(robuxEl.textContent).replace(/[^\d]/g, ''), 10) || 0 : 0;
    return { kind: 'payout', data: { robux, price } };
  }

  function isPageDark() {
    try {
      const html = document.documentElement;
      const body = document.body;
      const dark = (el) =>
        el && el.classList &&
        (el.classList.contains('dark') || el.classList.contains('dark-theme') || el.classList.contains('darkmode'));
      if (dark(html) || dark(body)) return true;
      if ((html.getAttribute('data-theme') || '').toLowerCase() === 'dark') return true;
      if (((body && body.getAttribute('data-theme')) || '').toLowerCase() === 'dark') return true;
      const bg = getComputedStyle(body || html).backgroundColor || '';
      const m = bg.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 < 90;
    } catch (_) { /* noop */ }
    return false;
  }

  function commitSend(rec, amount) {

    // Deduct what was sent from the displayed balance (fake amount, else the real one).
    const balance = currentBalance();
    if (balance != null) {
      const left = Math.max(0, balance - amount);
      state.fake = left;
      try { chrome.storage.local.set({ robuxAmount: left }); } catch (_) { /* noop */ }
      schedule();
    }

    const me = state.me || { id: null, name: 'You', displayName: 'You', avatar: '' };
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: Date.now(),
      amount,
      target: { id: rec.id, name: rec.name, displayName: rec.displayName, avatar: rec.avatar },
      me: { id: me.id, name: me.name, avatar: me.avatar },
    };
    state.txs = [tx].concat(state.txs).slice(0, MAX_TX);
    try { chrome.storage.local.set({ transactions: state.txs }); } catch (_) { /* noop */ }
    scheduleTx();
    if (!state.me) resolveMe(true);
  }

  /* ====================== catalog item purchase ====================== */

  const CATALOG_MODAL_ID = 'erx-catalog-success-modal';
  const BUY_ITEM_MODAL_ID = 'erx-buy-item-modal';
  const INSUFFICIENT_ROBUX_MODAL_ID = 'erx-insufficient-robux-modal';
  const isCatalogPage = () => /^\/(catalog|bundles|items)\//i.test(location.pathname);

  function getCatalogItemId() {
    const match = location.pathname.match(/\/(?:catalog|bundles|items)\/(\d+)/i);
    if (match) return match[1];
    const container = document.querySelector('#item-info-container-frontend, #item-thumbnail-container-frontend, [data-target-id], [data-btr-asset-id]');
    if (container) {
      const id = container.getAttribute('data-target-id') || container.getAttribute('data-btr-asset-id');
      if (id) return id;
    }
    return null;
  }

  function getCatalogItemName() {
    const h1 =
      document.querySelector('.item-details-name-row h1') ||
      document.querySelector('#item-info-container-frontend h1') ||
      document.querySelector('.item-name-container h1') ||
      document.querySelector('h1');
    if (h1 && h1.textContent.trim()) {
      return h1.textContent.trim();
    }
    const match = location.pathname.match(/\/(?:catalog|bundles|items)\/\d+\/([^/?#]+)/i);
    if (match) {
      try {
        return decodeURIComponent(match[1]).replace(/[-_]+/g, ' ').trim();
      } catch (_) {
        return match[1].replace(/[-_]+/g, ' ').trim();
      }
    }
    const title = (document.title || '').split(/\s*[|\u2013-]\s*/)[0].trim();
    return title || 'Item';
  }

  function getCatalogItemPrice() {
    const priceEl = document.querySelector(
      '.price-info .text-robux-lg, .item-price-value .text-robux-lg, .price-row-container .text-robux-lg, .text-robux-lg'
    );
    if (priceEl) {
      const raw = String(priceEl.textContent || '').replace(/[^\d]/g, '');
      const num = parseInt(raw, 10);
      if (!isNaN(num)) return num;
    }
    return 0;
  }

  function getNativeCharacterThumbnail() {
    if (!/^\/bundles\//i.test(location.pathname)) return '';
    const images = Array.from(document.querySelectorAll(
      '.item-details-thumbnail-container .thumbnail-holder .thumbnail-2d-container img, ' +
      '#item-thumbnail-container-frontend .thumbnail-holder .thumbnail-2d-container img, ' +
      '[data-testid="item-thumbnail"] .thumbnail-2d-container img'
    ));
    const avatarImage = images.find((img) => {
      const src = img.currentSrc || img.src || '';
      return src && isAvatarRenderThumbnail(src);
    });
    if (!avatarImage) return '';

    const controlLabels = Array.from(document.querySelectorAll(
      '.item-details-thumbnail-container .thumbnail-button-container button, ' +
      '#item-thumbnail-container-frontend .thumbnail-button-container button'
    )).map((button) => String(button.textContent || '').trim().toLowerCase());
    const untouchedCharacterControls = controlLabels.includes('try on') && controlLabels.includes('3d');
    const untouchedCharacterCapture = !!(
      catalogPreviewCapture &&
      catalogPreviewCapture.id === String(getCatalogItemId() || '') &&
      catalogPreviewCapture.tryOnThumbnail &&
      !catalogPreviewCapture.attemptedTryOn &&
      !catalogPreviewCapture.attempted2d
    );

    return untouchedCharacterControls || untouchedCharacterCapture
      ? (avatarImage.currentSrc || avatarImage.src || '')
      : '';
  }

  function getCatalogItemThumbnail() {
    const itemId = getCatalogItemId();
    const nativeCharacterThumbnail = getNativeCharacterThumbnail();
    if (nativeCharacterThumbnail) return nativeCharacterThumbnail;
    if (catalogPreviewCapture && catalogPreviewCapture.id === String(itemId || '')) {
      if (catalogPreviewCapture.itemThumbnail) return catalogPreviewCapture.itemThumbnail;
      if (catalogPreviewCapture.tryOnThumbnail) return catalogPreviewCapture.tryOnThumbnail;
    }
    const images = Array.from(document.querySelectorAll(
      '.item-details-thumbnail-container img, .thumbnail-holder img, [data-testid="item-thumbnail"] img, .marketplace-item-purchase-thumbnail-container img, .item-card-thumb-container img, .asset-thumb-container img, #item-thumbnail-container-frontend img'
    ));
    const itemImage = images.find((candidate) => candidate.src && !isAvatarRenderThumbnail(candidate.currentSrc || candidate.src));
    if (itemImage && itemImage.src) return itemImage.currentSrc || itemImage.src;
    const characterImage = images.find((candidate) => candidate.src && isAvatarRenderThumbnail(candidate.currentSrc || candidate.src));
    if (characterImage && characterImage.src) return characterImage.currentSrc || characterImage.src;
    const saved = state.purchasedDetails.find((detail) => String(detail && detail.id) === String(itemId || ''));
    if (saved && saved.thumbnail) return saved.thumbnail;
    if (saved && saved.tryOnThumbnail) return saved.tryOnThumbnail;
    return 'https://tr.rbxcdn.com/180DAY-ba7adb3d4205f6e43edc3f0c4a1830be/150/150/Shirt/Webp/noFilter';
  }

  /* ================= catalog Try On capture + Avatar inventory ================= */

  const isAvatarEditorPage = () => /^\/my\/avatar(?:[/?#]|$)/i.test(location.pathname);
  let catalogPreviewCapture = null;
  let catalogPreviewTimer = 0;
  let avatarInventoryTimer = 0;
  let avatarPreviewLoadVersion = 0;
  let liveTryOnJob = null;
  let liveTryOnResolved = null;

  function isAvatarRenderThumbnail(url) {
    const value = String(url || '');
    return /(?:^|[-_/])Avatar(?:[-_/]|$)/i.test(value) &&
      (/(?:1DAY|30DAY|180DAY)-Avatar-/i.test(value) || /\/\d+\/\d+\/Avatar\//i.test(value));
  }

  function catalogThumbnailImages() {
    return Array.from(document.querySelectorAll(
      '.item-details-thumbnail-container .thumbnail-holder img, .item-details-thumbnail-container .thumbnail-2d-container img, #item-thumbnail-container-frontend img, [data-testid="item-thumbnail"] img'
    ));
  }

  function catalogItemIsLimitedUnique() {
    return !!document.querySelector(
      '.item-details-name-row .restriction-icon.icon-limited-unique-label, ' +
      '.item-details-thumbnail-container .restriction-icon.icon-limited-unique-label, ' +
      '#item-info-container-frontend .restriction-icon.icon-limited-unique-label, ' +
      '[data-testid="item-details"] .restriction-icon.icon-limited-unique-label'
    );
  }

  function catalogPreviewControls() {
    return Array.from(document.querySelectorAll(
      '.item-details-thumbnail-container button.enable-three-dee, #item-thumbnail-container-frontend button.enable-three-dee, .thumbnail-button-container button'
    ));
  }

  function exactControl(label) {
    const wanted = String(label).trim().toLowerCase();
    return catalogPreviewControls().find((button) => String(button.textContent || '').trim().toLowerCase() === wanted) || null;
  }

  function ensureCatalogPreviewCapture() {
    if (!isCatalogPage()) return null;
    const itemId = getCatalogItemId();
    if (!itemId) return null;
    if (catalogPreviewCapture && catalogPreviewCapture.id === String(itemId)) return catalogPreviewCapture;

    if (catalogPreviewTimer) clearTimeout(catalogPreviewTimer);
    catalogPreviewTimer = 0;
    const saved = state.purchasedDetails.find((detail) => String(detail && detail.id) === String(itemId));
    catalogPreviewCapture = {
      id: String(itemId),
      itemThumbnail: saved && saved.thumbnail ? saved.thumbnail : '',
      tryOnThumbnail: saved && saved.tryOnThumbnail ? saved.tryOnThumbnail : '',
      limitedUnique: !!(saved && saved.limitedUnique) || catalogItemIsLimitedUnique(),
      attempted2d: false,
      attemptedTryOn: false,
      toggledBtrPreview: false,
      assetRequested: false,
      attempts: 0,
      done: false,
    };
    requestCatalogAssetThumbnail(catalogPreviewCapture);
    return catalogPreviewCapture;
  }

  function requestCatalogAssetThumbnail(capture) {
    if (!capture || capture.assetRequested) return;
    capture.assetRequested = true;
    apiJson(API.assetThumbnail(capture.id)).then((data) => {
      if (!catalogPreviewCapture || catalogPreviewCapture.id !== capture.id) return;
      const result = data && data.data && data.data[0];
      if (result && result.imageUrl) {
        capture.itemThumbnail = result.imageUrl;
        syncOwnedCatalogDetail();
      }
    }).catch(() => { /* best effort */ });
  }

  function captureCatalogThumbnailUrls(capture) {
    if (!capture) return;
    capture.limitedUnique = !!capture.limitedUnique || catalogItemIsLimitedUnique();
    catalogThumbnailImages().forEach((img) => {
      const src = img.currentSrc || img.src || '';
      if (!src) return;
      if (isAvatarRenderThumbnail(src)) capture.tryOnThumbnail = src;
      else capture.itemThumbnail = src;
    });
  }

  function catalogDetailSnapshot(purchasedAt) {
    const itemId = getCatalogItemId();
    const capture = ensureCatalogPreviewCapture();
    const saved = state.purchasedDetails.find((detail) => String(detail && detail.id) === String(itemId || ''));
    if (capture) captureCatalogThumbnailUrls(capture);
    return {
      id: String(itemId || ''),
      name: getCatalogItemName(),
      href: location.href,
      thumbnail: (capture && (capture.itemThumbnail || capture.tryOnThumbnail)) || getCatalogItemThumbnail(),
      tryOnThumbnail: (capture && capture.tryOnThumbnail) || '',
      limitedUnique: !!(capture && capture.limitedUnique) || catalogItemIsLimitedUnique() || !!(saved && saved.limitedUnique),
      purchasedAt: Number(purchasedAt) || Date.now(),
    };
  }

  function savePurchasedCatalogDetail(detail) {
    if (!detail || !detail.id) return;
    const id = String(detail.id);
    const old = state.purchasedDetails.find((entry) => String(entry && entry.id) === id) || null;
    const merged = Object.assign({}, old || {}, detail, {
      id,
      purchasedAt: Number((old && old.purchasedAt) || detail.purchasedAt) || Date.now(),
    });
    state.purchasedDetails = [merged].concat(
      state.purchasedDetails.filter((entry) => String(entry && entry.id) !== id)
    ).sort((a, b) => Number(b.purchasedAt || 0) - Number(a.purchasedAt || 0));
    setCachedPurchasedDetails(state.purchasedDetails);
    try { chrome.storage.local.set({ purchasedCatalogDetails: state.purchasedDetails }); } catch (_) { /* noop */ }
    scheduleAvatarInventory();
  }

  function syncOwnedCatalogDetail() {
    if (!isCatalogPage()) return;
    const itemId = getCatalogItemId();
    if (!itemId || !state.purchasedItems.includes(String(itemId))) return;
    const old = state.purchasedDetails.find((entry) => String(entry && entry.id) === String(itemId));
    savePurchasedCatalogDetail(catalogDetailSnapshot(old && old.purchasedAt));
  }

  function runCatalogPreviewCapture() {
    catalogPreviewTimer = 0;
    const capture = ensureCatalogPreviewCapture();
    if (!capture || capture.done) return;

    const thumbnailRoot = document.querySelector('.item-details-thumbnail-container, #item-thumbnail-container-frontend');
    if (!thumbnailRoot) return;

    captureCatalogThumbnailUrls(capture);
    if (capture.tryOnThumbnail) {
      capture.done = true;
      syncOwnedCatalogDetail();
      return;
    }

    capture.attempts += 1;
    if (capture.attempts > 100) return;

    // Whatever mode the catalog opened in, first move to native 2D, then Try On.
    const twoD = exactControl('2D');
    if (twoD && !capture.attempted2d) {
      capture.attempted2d = true;
      try { twoD.click(); } catch (_) { /* noop */ }
      scheduleCatalogPreviewCapture(180);
      return;
    }

    const tryOn = exactControl('Try On');
    if (tryOn && !capture.attemptedTryOn) {
      capture.attemptedTryOn = true;
      try { tryOn.click(); } catch (_) { /* noop */ }
      scheduleCatalogPreviewCapture(180);
      return;
    }

    // BTRoblox's checked preview can hide the native thumbnail controls. Toggle
    // it once so the same guarded 2D/Try On flow can continue.
    if (!catalogPreviewControls().length && !capture.toggledBtrPreview) {
      const btrPreview = document.querySelector('.btr-thumb-btn.btr-preview-btn.checked');
      if (btrPreview) {
        capture.toggledBtrPreview = true;
        try { btrPreview.click(); } catch (_) { /* noop */ }
      }
    }

    scheduleCatalogPreviewCapture(180);
  }

  function scheduleCatalogPreviewCapture(delay) {
    if (!isCatalogPage()) return;
    if (catalogPreviewTimer) return;
    catalogPreviewTimer = setTimeout(runCatalogPreviewCapture, Number(delay) || 80);
  }

  function inventoryList() {
    return document.querySelector(
      '#recent #avatar-items-container .avatar-item-list > ul.item-cards-stackable, #recent #avatar-items-container ul.hlist, #avatar-items-container .avatar-item-list > ul.item-cards-stackable'
    );
  }

  function catalogHref(detail) {
    const fallback = 'https://www.roblox.com/catalog/' + encodeURIComponent(detail.id) + '/' +
      encodeURIComponent(String(detail.name || 'Item').replace(/\s+/g, '-'));
    try {
      const url = new URL(detail.href || fallback, 'https://www.roblox.com');
      if (!/(^|\.)roblox\.com$/i.test(url.hostname) || !/^\/catalog\/\d+/i.test(url.pathname)) return fallback;
      return url.href;
    } catch (_) {
      return fallback;
    }
  }

  function equippedIndicator() {
    const icon = h('span', {
      'aria-hidden': 'true',
      'data-testid': 'foundation-web-icon',
      class: 'grow-0 shrink-0 basis-auto item-card-equipped-icon erx-equipped-check-fallback',
    });
    icon.innerHTML = '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" focusable="false"><circle cx="10" cy="10" r="9" fill="#ffffff"/><path d="M6.25 10.15L8.75 12.55L13.9 7.55" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return h('div', { class: 'item-card-equipped', 'data-item-status': 'equipped' }, [icon]);
  }

  function createInventoryCard(detail) {
    const href = catalogHref(detail);
    const thumbImg = detail.thumbnail
      ? h('img', { class: 'size-full loading', src: detail.thumbnail, alt: '', 'data-erx-thumbnail-src': detail.thumbnail })
      : null;
    if (thumbImg) {
      thumbImg.addEventListener('load', () => scheduleAvatarInventory(), { once: true });
      thumbImg.addEventListener('error', () => {
        if (thumbImg.getAttribute('src') !== FALLBACK_AVATAR) thumbImg.setAttribute('src', FALLBACK_AVATAR);
        scheduleAvatarInventory();
      }, { once: true });
    }
    const thumbChildren = thumbImg ? [thumbImg] : [];
    const caption = h('div', { class: 'item-card-caption' }, [
      h('a', {
        class: 'item-card-name-link',
        role: 'button',
        tabindex: '0',
        'data-erx-catalog-href': href,
      }, [
        h('div', { class: 'item-card-name', title: detail.name || 'Item', text: detail.name || 'Item' }),
      ]),
    ]);
    const thumbContent = [h('span', { class: 'thumbnail-2d-container float-left overflow-hidden erx-loading' }, thumbChildren)];
    if (detail.limitedUnique) {
      thumbContent.push(h('span', {
        class: 'restriction-icon www-item-card-restriction-icon www-item-card-restriction-icon-limited-unique',
        'aria-label': 'Limited Unique',
        title: 'Limited Unique',
      }));
    }
    return h('li', {
      class: 'list-item item-card seven-column',
      'data-erx-inventory-item': String(detail.id),
    }, [
      h('div'),
      h('div', { class: 'item-card-container remove-panel', 'aria-disabled': 'false' }, [
        h('div', { class: 'item-card-link' }, [
          h('a', {
            class: 'item-card-thumb-container',
            role: 'button',
            tabindex: '0',
            'data-erx-catalog-href': href,
            'data-item-name': detail.name || 'Item',
            'data-availability-status': 'Available',
          }, [
            h('div', {
              class: 'item-card-thumb',
              'data-thumbnail-target-id': String(detail.id),
              'data-thumbnail-type': 'Asset',
            }, thumbContent),
          ]),
        ]),
        caption,
      ]),
    ]);
  }

  function syncInventoryCard(card, detail, revealThumbnail) {
    const selected = String(state.equippedCatalogItem || '') === String(detail.id);
    const caption = card.querySelector('.item-card-caption');
    const indicator = caption && caption.querySelector('.item-card-equipped');
    if (selected && caption && !indicator) caption.insertBefore(equippedIndicator(), caption.firstChild);
    if (!selected && indicator) indicator.remove();
    const thumb = card.querySelector('.item-card-thumb');
    const limitedBadge = thumb && thumb.querySelector('.www-item-card-restriction-icon-limited-unique');
    if (detail.limitedUnique && thumb && !limitedBadge) {
      thumb.appendChild(h('span', {
        class: 'restriction-icon www-item-card-restriction-icon www-item-card-restriction-icon-limited-unique',
        'aria-label': 'Limited Unique',
        title: 'Limited Unique',
      }));
    } else if (!detail.limitedUnique && limitedBadge) {
      limitedBadge.remove();
    }
    const img = card.querySelector('.item-card-thumb img');
    if (!img || !detail.thumbnail) return;
    img.setAttribute('data-erx-thumbnail-src', detail.thumbnail);
    if (img.getAttribute('src') !== detail.thumbnail && img.getAttribute('src') !== FALLBACK_AVATAR) {
      img.setAttribute('src', detail.thumbnail);
    }
    if (!revealThumbnail) return;
    img.classList.remove('loading');
    const frame = img.closest('.thumbnail-2d-container');
    if (frame) frame.classList.remove('erx-loading');
  }

  function nativeInventoryThumbnailsReady(list) {
    const nativeImages = Array.from(list.querySelectorAll('li:not([data-erx-inventory-item]) .item-card-thumb img')).slice(0, 12);
    if (!nativeImages.length) return true;
    return nativeImages.every((img) =>
      img.complete && img.naturalWidth > 0 && !img.classList.contains('loading') && !img.closest('.erx-loading')
    );
  }

  function avatarPreviewImages() {
    return Array.from(document.querySelectorAll('img')).filter((img) => {
      if (img.closest('#avatar-items-container')) return false;
      const src = img.currentSrc || img.src || '';
      if (/\/352\/352\/Avatar\//i.test(src) || /\/420\/420\/Avatar\//i.test(src)) return true;
      return !!img.closest('#avatar-preview, .avatar-preview, .avatar-thumbnail, .avatar-thumbnail-container, [data-testid="avatar-preview"]');
    });
  }

  function restoreAvatarPreview() {
    avatarPreviewImages().forEach((img) => {
      const original = img.getAttribute('data-erx-avatar-base-src');
      if (original) {
        img.setAttribute('src', original);
        const srcset = img.getAttribute('data-erx-avatar-base-srcset');
        if (srcset) img.setAttribute('srcset', srcset);
        else img.removeAttribute('srcset');
      }
      const frame = img.closest('.thumbnail-2d-container') || img.parentElement;
      if (frame) frame.classList.remove('erx-avatar-preview-loading');
      if (img.hasAttribute('data-erx-preview-loading-owned')) img.classList.remove('loading');
      img.removeAttribute('data-erx-avatar-base-src');
      img.removeAttribute('data-erx-avatar-base-srcset');
      img.removeAttribute('data-erx-avatar-preview-active');
      img.removeAttribute('data-erx-avatar-preview-pending');
      img.removeAttribute('data-erx-preview-loading-owned');
    });
  }

  function loadEquippedAvatarPreview(img, detail, knownTryOnUrls) {
    const target = detail.tryOnThumbnail;
    const current = img.currentSrc || img.src || '';
    if (img.getAttribute('data-erx-avatar-preview-active') === String(detail.id) && img.getAttribute('src') === target) return;
    if (img.getAttribute('data-erx-avatar-preview-pending') === String(detail.id)) return;

    if (!img.hasAttribute('data-erx-avatar-base-src') && !knownTryOnUrls.has(current)) {
      img.setAttribute('data-erx-avatar-base-src', current);
      img.setAttribute('data-erx-avatar-base-srcset', img.getAttribute('srcset') || '');
    }

    const version = avatarPreviewLoadVersion;
    const frame = img.closest('.thumbnail-2d-container') || img.parentElement;
    img.setAttribute('data-erx-avatar-preview-pending', String(detail.id));
    img.setAttribute('data-erx-preview-loading-owned', 'true');
    img.classList.add('loading');
    if (frame) frame.classList.add('erx-avatar-preview-loading');

    let mediaReady = false;
    let minimumDelayDone = false;
    let completed = false;
    const finish = () => {
      if (completed || !mediaReady || !minimumDelayDone) return;
      completed = true;
      if (version !== avatarPreviewLoadVersion || String(state.equippedCatalogItem || '') !== String(detail.id)) return;
      img.removeAttribute('srcset');
      img.setAttribute('src', target);
      img.setAttribute('data-erx-avatar-preview-active', String(detail.id));
      img.removeAttribute('data-erx-avatar-preview-pending');
      setTimeout(() => {
        if (version !== avatarPreviewLoadVersion) return;
        img.classList.remove('loading');
        img.removeAttribute('data-erx-preview-loading-owned');
        if (frame) frame.classList.remove('erx-avatar-preview-loading');
      }, 80);
    };

    const probe = new Image();
    probe.addEventListener('load', () => { mediaReady = true; finish(); }, { once: true });
    probe.addEventListener('error', () => { mediaReady = true; finish(); }, { once: true });
    probe.src = target;
    setTimeout(() => { minimumDelayDone = true; finish(); }, 450);
    setTimeout(() => { mediaReady = true; minimumDelayDone = true; finish(); }, 2500);
  }

  function cancelLiveTryOnRefresh() {
    if (!liveTryOnJob) return;
    liveTryOnJob.cancelled = true;
    if (liveTryOnJob.timer) clearTimeout(liveTryOnJob.timer);
    if (liveTryOnJob.timeout) clearTimeout(liveTryOnJob.timeout);
    if (liveTryOnJob.frame) liveTryOnJob.frame.remove();
    liveTryOnJob = null;
  }

  function backgroundTryOnUrl(detail) {
    const fallback = '/catalog/' + encodeURIComponent(detail.id) + '/' +
      encodeURIComponent(String(detail.name || 'Item').replace(/\s+/g, '-'));
    let path = fallback;
    try {
      const saved = new URL(detail.href || fallback, location.origin);
      if (/^\/(?:catalog|bundles|items)\/\d+/i.test(saved.pathname)) path = saved.pathname + saved.search;
    } catch (_) { /* use fallback */ }
    const url = new URL(path, location.origin);
    url.searchParams.set('erxTryOnFrame', '1');
    return url.href;
  }

  function markAvatarPreviewRefreshing(detail) {
    const knownTryOnUrls = new Set(state.purchasedDetails.map((entry) => entry && entry.tryOnThumbnail).filter(Boolean));
    const images = avatarPreviewImages();
    images.forEach((img) => {
      const current = img.currentSrc || img.src || '';
      if (!img.hasAttribute('data-erx-avatar-base-src') && !knownTryOnUrls.has(current)) {
        img.setAttribute('data-erx-avatar-base-src', current);
        img.setAttribute('data-erx-avatar-base-srcset', img.getAttribute('srcset') || '');
      }
      const frame = img.closest('.thumbnail-2d-container') || img.parentElement;
      img.setAttribute('data-erx-avatar-preview-pending', String(detail.id));
      img.setAttribute('data-erx-preview-loading-owned', 'true');
      img.classList.add('loading');
      if (frame) frame.classList.add('erx-avatar-preview-loading');
    });
    return images;
  }

  function revealLiveTryOnPreview(job, detail, url) {
    if (!url || job.version !== avatarPreviewLoadVersion || String(state.equippedCatalogItem || '') !== String(detail.id)) return;
    const images = Array.from(new Set(job.previewImages.concat(avatarPreviewImages())));
    images.forEach((img) => {
      const frame = img.closest('.thumbnail-2d-container') || img.parentElement;
      img.removeAttribute('srcset');
      img.setAttribute('src', url);
      img.setAttribute('data-erx-avatar-preview-active', String(detail.id));
      img.removeAttribute('data-erx-avatar-preview-pending');
      setTimeout(() => {
        if (job.version !== avatarPreviewLoadVersion) return;
        img.classList.remove('loading');
        img.removeAttribute('data-erx-preview-loading-owned');
        if (frame) frame.classList.remove('erx-avatar-preview-loading');
      }, 80);
    });
  }

  function finishLiveTryOnRefresh(job, detail, url, fresh) {
    if (!job || job.cancelled) return;
    if (job.timer) clearTimeout(job.timer);
    if (job.timeout) clearTimeout(job.timeout);
    if (job.frame) job.frame.remove();
    if (liveTryOnJob === job) liveTryOnJob = null;
    if (job.version !== avatarPreviewLoadVersion || String(state.equippedCatalogItem || '') !== String(detail.id)) return;

    const resolvedUrl = url || detail.tryOnThumbnail || '';
    if (!resolvedUrl) {
      restoreAvatarPreview();
      return;
    }
    liveTryOnResolved = { id: String(detail.id), version: job.version, url: resolvedUrl };
    if (fresh && resolvedUrl !== detail.tryOnThumbnail) {
      savePurchasedCatalogDetail(Object.assign({}, detail, { tryOnThumbnail: resolvedUrl }));
    }
    revealLiveTryOnPreview(job, detail, resolvedUrl);
  }

  function pollLiveTryOnFrame(job, detail) {
    if (!job || job.cancelled || liveTryOnJob !== job) return;
    if (job.version !== avatarPreviewLoadVersion || String(state.equippedCatalogItem || '') !== String(detail.id)) {
      cancelLiveTryOnRefresh();
      return;
    }

    try {
      const doc = job.frame.contentDocument;
      if (doc) {
        const root = doc.querySelector('.item-details-thumbnail-container, #item-thumbnail-container-frontend');
        if (root) {
          const avatarImg = Array.from(root.querySelectorAll('img')).find((img) => {
            const src = img.currentSrc || img.src || '';
            return isAvatarRenderThumbnail(src) && img.complete && img.naturalWidth > 0;
          });
          if (avatarImg) {
            finishLiveTryOnRefresh(job, detail, avatarImg.currentSrc || avatarImg.src, true);
            return;
          }

          const controls = Array.from(root.querySelectorAll('button.enable-three-dee, .thumbnail-button-container button'));
          const byText = (label) => controls.find((button) =>
            String(button.textContent || '').trim().toLowerCase() === label.toLowerCase()
          );
          const twoD = byText('2D');
          if (twoD && !job.clicked2d) {
            job.clicked2d = true;
            try { twoD.click(); } catch (_) { /* noop */ }
          } else {
            const tryOn = byText('Try On');
            if (tryOn && !job.clickedTryOn) {
              job.clickedTryOn = true;
              try { tryOn.click(); } catch (_) { /* noop */ }
            } else if (!controls.length && !job.clickedBtr) {
              const btr = doc.querySelector('.btr-thumb-btn.btr-preview-btn.checked');
              if (btr) {
                job.clickedBtr = true;
                try { btr.click(); } catch (_) { /* noop */ }
              }
            }
          }
        }
      }
    } catch (_) { /* frame still loading */ }

    job.timer = setTimeout(() => pollLiveTryOnFrame(job, detail), 180);
  }

  function startLiveTryOnRefresh(detail) {
    const previewImages = markAvatarPreviewRefreshing(detail);
    if (!previewImages.length) return;
    cancelLiveTryOnRefresh();

    const frame = document.createElement('iframe');
    frame.id = 'erx-avatar-tryon-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('referrerpolicy', 'same-origin');
    frame.style.cssText = 'position:fixed!important;left:-10000px!important;top:-10000px!important;width:420px!important;height:420px!important;opacity:0!important;pointer-events:none!important;border:0!important;';

    const job = {
      id: String(detail.id),
      version: avatarPreviewLoadVersion,
      frame,
      previewImages,
      clicked2d: false,
      clickedTryOn: false,
      clickedBtr: false,
      cancelled: false,
      timer: 0,
      timeout: 0,
    };
    liveTryOnJob = job;
    frame.addEventListener('load', () => {
      if (!job.cancelled) job.timer = setTimeout(() => pollLiveTryOnFrame(job, detail), 100);
    });
    frame.src = backgroundTryOnUrl(detail);
    (document.body || document.documentElement).appendChild(frame);
    job.timeout = setTimeout(() => finishLiveTryOnRefresh(job, detail, '', false), 20000);
  }

  function applyEquippedAvatarPreview() {
    const detail = state.purchasedDetails.find(
      (entry) => String(entry && entry.id) === String(state.equippedCatalogItem || '')
    );
    if (!detail) {
      cancelLiveTryOnRefresh();
      restoreAvatarPreview();
      return;
    }
    if (liveTryOnResolved && liveTryOnResolved.id === String(detail.id) && liveTryOnResolved.version === avatarPreviewLoadVersion) {
      const resolvedDetail = Object.assign({}, detail, { tryOnThumbnail: liveTryOnResolved.url });
      const knownTryOnUrls = new Set(state.purchasedDetails.map((entry) => entry && entry.tryOnThumbnail).filter(Boolean));
      avatarPreviewImages().forEach((img) => loadEquippedAvatarPreview(img, resolvedDetail, knownTryOnUrls));
      return;
    }
    if (liveTryOnJob && liveTryOnJob.id === String(detail.id) && liveTryOnJob.version === avatarPreviewLoadVersion) return;
    startLiveTryOnRefresh(detail);
  }

  function applyAvatarInventory() {
    avatarInventoryTimer = 0;
    if (isBanned) {
      cancelLiveTryOnRefresh();
      restoreAvatarPreview();
      document.querySelectorAll('[data-erx-inventory-item]').forEach((n) => n.remove());
      return;
    }
    if (!isAvatarEditorPage()) return;
    const list = inventoryList();
    if (!list) return;

    if (!list.hasAttribute('data-erx-inventory-wait-started')) {
      list.setAttribute('data-erx-inventory-wait-started', String(Date.now()));
    }
    const waited = Date.now() - Number(list.getAttribute('data-erx-inventory-wait-started') || Date.now());
    const revealThumbnails = nativeInventoryThumbnailsReady(list) || waited >= 3500;

    const details = state.purchasedDetails
      .filter((detail) => detail && detail.id)
      .sort((a, b) => Number(b.purchasedAt || 0) - Number(a.purchasedAt || 0));
    const wantedIds = new Set(details.map((detail) => String(detail.id)));
    list.querySelectorAll('[data-erx-inventory-item]').forEach((card) => {
      if (!wantedIds.has(card.getAttribute('data-erx-inventory-item'))) card.remove();
    });

    let cursor = list.firstElementChild;
    details.forEach((detail) => {
      const id = String(detail.id);
      const nativeDuplicate = Array.from(list.querySelectorAll('.item-card-thumb[data-thumbnail-target-id]')).find((thumb) =>
        thumb.getAttribute('data-thumbnail-target-id') === id && !thumb.closest('[data-erx-inventory-item]')
      );
      let card = list.querySelector('[data-erx-inventory-item="' + CSS.escape(id) + '"]');
      if (nativeDuplicate) {
        if (card) card.remove();
        return;
      }
      if (!card) card = createInventoryCard(detail);
      syncInventoryCard(card, detail, revealThumbnails);
      if (card !== cursor) list.insertBefore(card, cursor);
      cursor = card.nextElementSibling;
    });

    if (!revealThumbnails && details.length) scheduleAvatarInventory(120);

    if (state.equippedCatalogItem) applyEquippedAvatarPreview();
    else restoreAvatarPreview();
  }

  function scheduleAvatarInventory(delay) {
    if (!isAvatarEditorPage()) return;
    if (avatarInventoryTimer) return;
    avatarInventoryTimer = setTimeout(applyAvatarInventory, Number(delay) || 60);
  }

  function setEquippedCatalogItem(itemId) {
    avatarPreviewLoadVersion += 1;
    cancelLiveTryOnRefresh();
    liveTryOnResolved = null;
    state.equippedCatalogItem = itemId ? String(itemId) : null;
    setCachedEquippedCatalogItem(state.equippedCatalogItem);
    if (!state.equippedCatalogItem) restoreAvatarPreview();
    if (avatarInventoryTimer) clearTimeout(avatarInventoryTimer);
    avatarInventoryTimer = 0;
    applyAvatarInventory();
    try { chrome.storage.local.set({ equippedCatalogItem: state.equippedCatalogItem }); } catch (_) { /* noop */ }
  }

  function handleAvatarInventoryClick(target) {
    if (isBanned) return false;
    if (!isAvatarEditorPage() || !(target instanceof Element)) return false;
    const customCard = target.closest('[data-erx-inventory-item]');
    if (customCard) {
      const id = customCard.getAttribute('data-erx-inventory-item');
      setEquippedCatalogItem(String(state.equippedCatalogItem || '') === String(id) ? null : id);
      return true;
    }
    const nativeCard = target.closest('#avatar-items-container .item-card-container');
    if (nativeCard && state.equippedCatalogItem) {
      // Native Roblox items and extension items are independent layers. Keep
      // the extension item selected, then regenerate its preview after Roblox
      // has applied the native item to the real outfit.
      avatarPreviewLoadVersion += 1;
      cancelLiveTryOnRefresh();
      liveTryOnResolved = null;
      scheduleAvatarInventory(450);
    }
    return false;
  }

  function applyCatalogPurchasedState() {
    // 1. Add Item Owned badge into .item-details-creator-container if not already present
    const creatorContainer = document.querySelector('.item-details-creator-container');
    if (creatorContainer && !creatorContainer.querySelector('.item-owned')) {
      const itemOwned = document.createElement('span');
      itemOwned.className = 'item-owned';
      itemOwned.setAttribute('data-erx-injected-owned', 'true');
      itemOwned.innerHTML = '<div class="label-checkmark"><span class="icon-checkmark-white-bold"></span></div><span>Item Owned</span>';
      creatorContainer.appendChild(itemOwned);
    }

    // 2. Replace price row with "This item is available in your inventory." and edit avatar button
    const priceRow = document.querySelector('.price-row-container') ||
      document.querySelector('.shopping-cart-buy-button, .item-purchase-btns-container, button.PurchaseButton')?.closest('.price-row-container');
    if (priceRow) {
      if (!priceRow.hasAttribute('data-erx-orig-price-html')) {
        priceRow.setAttribute('data-erx-orig-price-html', priceRow.innerHTML);
      }
      priceRow.innerHTML = `
        <div class="price-container-text">
            <div class="item-first-line">This item is available in your inventory.</div>
        </div><a id="edit-avatar-button" href="/my/avatar" class="btn-control-md"><span class="icon-nav-charactercustomizer"></span></a>
      `;
    }
  }

  function restoreCatalogOwnershipDOM() {
    if (document.documentElement.hasAttribute('data-erx-owned')) {
      document.documentElement.removeAttribute('data-erx-owned');
    }
    document.querySelectorAll('.item-owned[data-erx-injected-owned]').forEach((el) => el.remove());
    document.querySelectorAll('.price-row-container[data-erx-orig-price-html]').forEach((priceRow) => {
      const orig = priceRow.getAttribute('data-erx-orig-price-html');
      priceRow.removeAttribute('data-erx-orig-price-html');
      if (orig !== null) priceRow.innerHTML = orig;
    });
  }

  function checkCatalogPageNav() {
    if (!isCatalogPage()) {
      const staleCatalogUi = document.querySelector(
        '.item-details-thumbnail-container, .item-details-name-row, #item-info-container-frontend, .price-row-container'
      );
      if (!staleCatalogUi) document.documentElement.removeAttribute('data-erx-owned');
      return;
    }
    const itemId = getCatalogItemId();
    if (!isBanned && itemId && state.purchasedItems && state.purchasedItems.includes(String(itemId))) {
      document.documentElement.setAttribute('data-erx-owned', 'true');
      applyCatalogOwnership();
    } else {
      restoreCatalogOwnershipDOM();
    }
  }

  function applyCatalogOwnership() {
    if (!isCatalogPage()) return;
    if (isBanned) {
      restoreCatalogOwnershipDOM();
      return;
    }
    const itemId = getCatalogItemId();
    if (!itemId) return;

    const isOwned = state.purchasedItems && state.purchasedItems.includes(String(itemId));
    if (!isOwned) {
      restoreCatalogOwnershipDOM();
      return;
    }

    if (!document.documentElement.hasAttribute('data-erx-owned')) {
      document.documentElement.setAttribute('data-erx-owned', 'true');
    }

    // 1. Add Item Owned badge into .item-details-creator-container if not already present
    const creatorContainer = document.querySelector('.item-details-creator-container');
    if (creatorContainer && !creatorContainer.querySelector('.item-owned')) {
      const itemOwned = document.createElement('span');
      itemOwned.className = 'item-owned';
      itemOwned.setAttribute('data-erx-injected-owned', 'true');
      itemOwned.innerHTML = '<div class="label-checkmark"><span class="icon-checkmark-white-bold"></span></div><span>Item Owned</span>';
      creatorContainer.appendChild(itemOwned);
    }

    // 2. Replace price row with "This item is available in your inventory." and edit avatar button
    const priceRow =
      document.querySelector('.price-row-container') ||
      document.querySelector('.shopping-cart-buy-button, .item-purchase-btns-container, button.PurchaseButton')?.closest('.price-row-container');
    if (priceRow && !priceRow.querySelector('#edit-avatar-button')) {
      if (!priceRow.hasAttribute('data-erx-orig-price-html')) {
        priceRow.setAttribute('data-erx-orig-price-html', priceRow.innerHTML);
      }
      priceRow.innerHTML = `
        <div class="price-container-text">
            <div class="item-first-line">This item is available in your inventory.</div>
        </div><a id="edit-avatar-button" href="/my/avatar" class="btn-control-md"><span class="icon-nav-charactercustomizer"></span></a>
      `;
    }
  }

  /* ====================== badges injection ====================== */

  function createBadgeElements(isLarge, includeVerified, includePlus) {
    const verifiedHtml = includeVerified ? `
      <span class="relative flex items-center justify-center erx-verified-badge" title="Verified" style="position:relative;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;flex-shrink:0;">
        <span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-filled-verified-backplate ${isLarge ? 'size-[var(--icon-size-large)]' : 'size-[var(--icon-size-small)]'} content-system-emphasis" style="display:none;"></span>
        <span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-filled-verified-check ${isLarge ? 'size-[var(--icon-size-large)]' : 'size-[var(--icon-size-small)]'} absolute" style="color: white;display:none;"></span>
        <svg xmlns="http://www.w3.org/2000/svg" width="${isLarge ? 20 : 15}" height="${isLarge ? 20 : 15}" viewBox="0 0 12 12" fill="none" style="display:inline-block;vertical-align:middle;flex-shrink:0;">
          <path fill="#0066ff" d="m2.523 0 9.476 2.539-2.54 9.476-9.475-2.54z"/>
          <path fill="#f7f7f8" fill-rule="evenodd" d="m8.804 3.75.003.003a.66.66 0 0 1 0 .932L5.064 8.428 3.193 6.556a.66.66 0 0 1 0-.932l.003-.003a.66.66 0 0 1 .932 0l.936.936L7.872 3.75a.66.66 0 0 1 .932 0" clip-rule="evenodd"/>
        </svg>
      </span>
    ` : '';

    const plusHtml = includePlus ? `
      <span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-regular-roblox-plus ${isLarge ? 'size-[var(--icon-size-large)]' : 'size-[var(--icon-size-small)]'} content-system-contrast erx-plus-badge" aria-label="Roblox Plus subscriber" title="Roblox Plus subscriber" style="display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;flex-shrink:0;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${isLarge ? 20 : 16}" height="${isLarge ? 20 : 16}" style="display:inline-block;vertical-align:middle;flex-shrink:0;">
          <path d="M13.8555 2.5606C15.1824 1.81313 16.8176 1.81313 18.1445 2.5606L26.8555 7.46782C28.1824 8.21534 28.9999 9.59781 29 11.0928V20.9073C29 22.4024 28.1824 23.7847 26.8555 24.5323L18.1445 29.4395L17.8926 29.5704C16.6996 30.143 15.3004 30.143 14.1074 29.5704L13.8555 29.4395L11.0176 27.8409C10.3887 27.4864 10 26.8196 10 26.0977V12.001C10.0002 10.8967 10.8957 10.0012 12 10.001L20 10.0001C21.1044 10 21.9998 10.8957 22 12.0001V19.0001C22 20.1046 21.1046 21.0001 20 21.0001H16C15.4477 21.0001 15 20.5523 15 20.0001C15.0002 19.4479 15.4478 19.0001 16 19.0001H20V12.0001L12 12.001V26.0987L14.8369 27.6973C15.5545 28.1016 16.4455 28.1016 17.1631 27.6973L25.874 22.7891C26.5863 22.3877 27 21.6636 27 20.9073V11.0928C26.9999 10.3366 26.5863 9.61234 25.874 9.21099L17.1631 4.30278C16.4456 3.89864 15.5544 3.89864 14.8369 4.30278L6.12598 9.21099C5.41372 9.61234 5.00013 10.3366 5 11.0928V20.9073C5 21.6636 5.4137 22.3877 6.12598 22.7891L6.49023 22.9942C6.80495 23.1714 7 23.5051 7 23.8663C6.99984 24.6314 6.17549 25.1128 5.50879 24.7374L5.14453 24.5323C3.81763 23.7847 3 22.4024 3 20.9073V11.0928C3.00012 9.69126 3.71827 8.38846 4.90137 7.61528L5.14453 7.46782L13.8555 2.5606Z" fill="currentColor"/>
        </svg>
      </span>
    ` : '';

    // Ordering: Verified Blue Badge is always to the LEFT of Roblox Plus icon (immediately after name)
    return verifiedHtml + plusHtml;
  }

  const BADGE_SLOT_SELECTOR = '[data-erx-badge-slot]';
  const NATIVE_BADGE_HIDDEN_CLASS = 'erx-native-badge-hidden';
  let badgeTimer = 0;

  function scheduleBadges() {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = 0;
      try { applyBadges(); } catch (err) { console.warn('[E.Roblox] badge patch failed', err); }
    }, 80);
  }

  function normalizedName(value) {
    return String(value || '').trim().toLowerCase();
  }

  function userIdFromLink(link) {
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    return (href.match(/\/users\/(\d+)(?:\/profile)?/i) || [])[1] || null;
  }

  function linkBelongsToMe(link, allowGenericProfile) {
    if (!link) return false;
    const href = link.getAttribute('href') || '';
    if (allowGenericProfile && /^\/?users\/profile(?:[/?#]|$)/i.test(href)) return true;
    const id = userIdFromLink(link);
    return !!(id && state.me && state.me.id && String(id) === String(state.me.id));
  }

  function nameBelongsToMe(nameNode) {
    if (!nameNode || !state.me) return false;
    const value = normalizedName(nameNode.textContent);
    return !!value && [state.me.name, state.me.displayName].some((name) => normalizedName(name) === value);
  }

  function targetBelongsToMe(nameNode, allowGenericProfile) {
    if (!nameNode) return false;
    const directLink = nameNode.closest('a[href]');
    if (linkBelongsToMe(directLink, allowGenericProfile)) return true;
    const card = nameNode.closest('[class*="player-search-card"], [data-testid*="player-search"], [class*="user-card"]');
    const nestedLink = card && card.querySelector('a[href*="/users/"]');
    return linkBelongsToMe(nestedLink, allowGenericProfile) || nameBelongsToMe(nameNode);
  }

  function ownProfileIsOpen() {
    const id = (location.pathname.match(/\/users\/(\d+)(?:\/profile)?/i) || [])[1];
    return !!(id && state.me && state.me.id && String(id) === String(state.me.id));
  }

  function nativeBadgesIn(host, kind) {
    if (!host) return [];
    const selector = kind === 'plus'
      ? '.icon-regular-roblox-plus, [aria-label="Roblox Plus subscriber"]'
      : '.icon-filled-verified-check, .icon-filled-verified-backplate';
    return Array.from(host.querySelectorAll(selector)).filter((node) =>
      !node.closest(BADGE_SLOT_SELECTOR) &&
      !node.classList.contains('erx-plus-badge') &&
      !node.classList.contains('erx-verified-badge')
    );
  }

  function ensureBadgeSlot(target, desiredSlots) {
    const { host, nameNode, slot, isLarge } = target;
    const nativePlus = nativeBadgesIn(host, 'plus');
    const nativeVerified = nativeBadgesIn(host, 'verified');

    nativePlus.forEach((node) => {
      node.classList.toggle(NATIVE_BADGE_HIDDEN_CLASS, state.robloxPlusConfigured && !state.robloxPlusEnabled);
    });
    nativeVerified.forEach((node) => {
      node.classList.toggle(NATIVE_BADGE_HIDDEN_CLASS, state.verifiedBadgeConfigured && !state.verifiedBadgeEnabled);
    });

    const includePlus = state.robloxPlusEnabled && nativePlus.length === 0;
    const includeVerified = state.verifiedBadgeEnabled && nativeVerified.length === 0;
    const markup = createBadgeElements(isLarge, includeVerified, includePlus);
    let container = Array.from(host.children).find((child) => child.getAttribute && child.getAttribute('data-erx-badge-slot') === slot);

    if (!markup) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement(slot === 'nav' ? 'section' : 'span');
      container.setAttribute('data-erx-badge-slot', slot);
      container.className = 'items-center gap-xxsmall inline-flex shrink-0 [--icon-size-small:1em] erx-badge-container erx-' + slot + '-badge-container';
      container.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-left:4px;vertical-align:middle;flex-shrink:0;';
      if (nameNode && nameNode.parentElement === host) nameNode.insertAdjacentElement('afterend', container);
      else host.appendChild(container);
    }

    desiredSlots.add(container);
    const signature = [isLarge ? 'large' : 'small', includeVerified ? 'verified' : '', includePlus ? 'plus' : ''].join(':');
    if (container.getAttribute('data-erx-badge-signature') !== signature) {
      container.setAttribute('data-erx-badge-signature', signature);
      container.innerHTML = markup;
    }
  }

  function applyBadges() {
    const targets = [];
    const seenNames = new Set();

    function addTarget(host, nameNode, slot, isLarge) {
      if (!host || !nameNode || seenNames.has(nameNode)) return;
      seenNames.add(nameNode);
      targets.push({ host, nameNode, slot, isLarge });
    }

    // 1. The logged-in user's own profile header.
    const profileHeaderName = document.getElementById('profile-header-title-container-name');
    if (profileHeaderName && profileHeaderName.parentElement && ownProfileIsOpen()) {
      addTarget(profileHeaderName.parentElement, profileHeaderName, 'header', true);
    }

    // 2. Logged-in account link in the navigation/header.
    document.querySelectorAll('.age-bracket-label-username, .dynamic-overflow-container .text-overflow').forEach((nameNode) => {
      const parent = nameNode.closest('a, .dynamic-overflow-container');
      if (parent && (parent.closest('nav, header, [class*="navbar"]') || linkBelongsToMe(parent.closest('a[href]'), true))) {
        addTarget(parent, nameNode, 'nav', false);
      }
    });

    // 3. Sidebar / user-menu link for the logged-in account only.
    document.querySelectorAll('a[href="/users/profile"], a[href$="/profile"]').forEach((link) => {
      const nameEl = link.querySelector('.text-truncate-end.text-no-wrap, .age-bracket-label-username');
      if (nameEl && linkBelongsToMe(link, true)) addTarget(nameEl.parentElement, nameEl, 'sidebar', false);
    });

    // 4. Only the logged-in user's result on the player search page.
    document.querySelectorAll('.player-search-card-name').forEach((card) => {
      const nameEl = card.querySelector('.text-truncate-end') || card.firstElementChild;
      if (nameEl && targetBelongsToMe(nameEl, false)) addTarget(card, nameEl, 'search', false);
    });

    // Native badges determine the initial (automatic) toggle state. Extension
    // badges are deliberately excluded, otherwise our own DOM would self-detect.
    const realPlusDetected = targets.some((target) => nativeBadgesIn(target.host, 'plus').length > 0);
    if (targets.length && realPlusDetected !== state.realRobloxPlusStatus) {
      state.realRobloxPlusStatus = realPlusDetected;
      notifyTracker();
    }
    if (!state.robloxPlusConfigured && realPlusDetected) {
      const wasPlus = state.robloxPlusEnabled;
      state.robloxPlusEnabled = true;
      // The verified account status above is what the tracker reports; this
      // flag only controls cosmetic badge rendering in the Roblox page UI.
      if (!wasPlus) scheduleBadges();
    }
    if (!state.verifiedBadgeConfigured && targets.some((target) => nativeBadgesIn(target.host, 'verified').length > 0)) {
      state.verifiedBadgeEnabled = true;
    }

    const desiredSlots = new Set();
    const activeNativeBadges = new Set();
    if (!isBanned) {
      targets.forEach((target) => {
        nativeBadgesIn(target.host, 'plus').forEach((node) => activeNativeBadges.add(node));
        nativeBadgesIn(target.host, 'verified').forEach((node) => activeNativeBadges.add(node));
        ensureBadgeSlot(target, desiredSlots);
      });
    }

    // Remove stale injected slots after SPA navigation and restore native icons
    // that no longer belong to one of the logged-in user's UI locations.
    document.querySelectorAll(BADGE_SLOT_SELECTOR).forEach((container) => {
      if (!desiredSlots.has(container)) container.remove();
    });
    document.querySelectorAll('.' + NATIVE_BADGE_HIDDEN_CLASS).forEach((node) => {
      if (!activeNativeBadges.has(node)) node.classList.remove(NATIVE_BADGE_HIDDEN_CLASS);
    });
  }

  /* ====================== catalog buy & success modals ====================== */

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function closeCatalogSuccessModal() {
    const modal = document.getElementById(CATALOG_MODAL_ID);
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleCatalogModalKey);
  }

  function handleCatalogModalKey(e) {
    if (e.key === 'Escape') closeCatalogSuccessModal();
  }

  function openCatalogSuccessModal(info) {
    closeCatalogSuccessModal();

    const itemName = info && info.name ? info.name : 'Item';
    const remainingText = fmt(info && info.balance != null ? info.balance : (currentBalance() || 0));

    const overlay = document.createElement('div');
    overlay.id = CATALOG_MODAL_ID;
    overlay.setAttribute('data-state', 'open');
    overlay.className = 'foundation-web-dialog-overlay padding-medium foundation-web-portal-zindex bg-common-backdrop';
    overlay.style.cssText = 'pointer-events: auto; box-sizing: border-box;';

    overlay.innerHTML = `
      <div role="dialog" id="radix-erx-catalog-modal" aria-describedby="unified-purchase-completion-modal-body"
          aria-labelledby="rbx-unified-purchase-heading" data-state="open"
          class="relative radius-large bg-surface-100 stroke-muted stroke-standard foundation-web-dialog-content shadow-transient-high relative width-full"
          data-size="Medium" tabindex="-1" style="pointer-events: auto;">
          <div class="absolute foundation-web-dialog-close-container">
              <button type="button" id="erx-catalog-close-x"
                  class="foundation-web-close-affordance flex stroke-none bg-none cursor-pointer relative clip group/interactable focus-visible:outline-focus disabled:outline-none bg-over-media-100 padding-small radius-circle"
                  aria-label="Close">
                  <div aria-hidden="true" data-testid="foundation-web-state-layer"
                      class="absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)] group-disabled/interactable:bg-none">
                  </div>
                  <span aria-hidden="true" data-testid="foundation-web-icon"
                      class="grow-0 shrink-0 basis-auto icon icon-regular-x size-[var(--icon-size-medium)] erx-modal-x-fallback"></span>
              </button>
          </div>
          <div class="padding-x-xlarge padding-top-xlarge padding-bottom-xlarge gap-xlarge flex flex-col">
              <div style="margin-top: -4px;">
                  <div id="rbx-unified-purchase-heading" class="flex flex-row items-center justify-between"
                      style="padding-right: 42px;">
                      <span class="text-heading-medium font-bold">Purchase Complete</span>
                      <div class="flex flex-row items-center" style="display:flex;align-items:center;gap:4px;">
                          <span class="icon-robux-16x16 erx-robux-icon"></span>
                          <span class="text-robux ml-1 text-body-medium font-semibold">${remainingText}</span>
                      </div>
                  </div>
              </div>
              <div class="flex justify-center gap-bottom-large" style="display:flex;justify-content:center;">
                  <span aria-hidden="true" data-testid="foundation-web-icon"
                      class="grow-0 shrink-0 basis-auto icon icon-regular-circle-check size-[var(--icon-size-xlarge)] erx-check-fallback"
                      style="font-size: 48px; width: 48px; height: 48px; line-height: 1;">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="display:inline-block;flex-shrink:0;">
                          <circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="3.5" fill="none"/>
                          <path d="M14 24.5L21 31.5L34 17.5" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                  </span>
              </div>
              <div id="unified-purchase-completion-modal-body" class="text-center text-body-large">
                  You have successfully bought <b>${escapeHtml(itemName)}</b>
              </div>
          </div>
          <div class="padding-x-xlarge padding-bottom-xlarge gap-small flex flex-col mt-[40px]">
              <div class="flex flex-row-reverse" style="display:flex;justify-content:flex-end;">
                  <button type="button" id="erx-catalog-ok-btn"
                      class="foundation-web-button relative clip group/interactable focus-visible:outline-focus disabled:outline-none cursor-pointer relative flex items-center justify-center stroke-none padding-y-none select-none radius-medium text-label-large height-1200 padding-x-medium bg-action-emphasis content-action-emphasis fill basis-0"
                      style="text-decoration: none;">
                      <div aria-hidden="true" data-testid="foundation-web-state-layer"
                          class="absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)] group-disabled/interactable:bg-none">
                      </div>
                      <span class="flex items-center min-width-0 gap-small">
                          <span class="padding-y-xsmall text-truncate-end text-no-wrap font-semibold">OK</span>
                      </span>
                  </button>
              </div>
          </div>
      </div>
    `;

    overlay.querySelector('#erx-catalog-close-x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCatalogSuccessModal();
    });

    overlay.querySelector('#erx-catalog-ok-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCatalogSuccessModal();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeCatalogSuccessModal();
    });

    document.addEventListener('keydown', handleCatalogModalKey);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function closeInsufficientRobuxModal() {
    const modal = document.getElementById(INSUFFICIENT_ROBUX_MODAL_ID);
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleInsufficientRobuxModalKey);
  }

  function handleInsufficientRobuxModalKey(e) {
    if (e.key === 'Escape') closeInsufficientRobuxModal();
  }

  function openInsufficientRobuxModal(info) {
    closeCatalogBuyModal();
    closeCatalogSuccessModal();
    closeInsufficientRobuxModal();

    const itemName = info && info.name ? info.name : 'Item';
    const itemPrice = Math.max(0, Number(info && info.price) || 0);
    const itemThumb = info && info.thumbnail ? info.thumbnail : getCatalogItemThumbnail();
    const buyRobuxUrl = 'https://www.roblox.com/upgrades/robux?ctx=navpopover';

    const overlay = document.createElement('div');
    overlay.id = INSUFFICIENT_ROBUX_MODAL_ID;
    overlay.setAttribute('data-state', 'open');
    overlay.setAttribute('data-erx-ignore', 'true');
    overlay.className = 'foundation-web-dialog-overlay padding-medium foundation-web-portal-zindex bg-common-backdrop';
    overlay.style.cssText = 'pointer-events: auto; box-sizing: border-box;';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="erx-insufficient-title" data-state="open" data-size="Large"
          class="relative radius-large bg-surface-100 stroke-muted stroke-standard foundation-web-dialog-content shadow-transient-high">
          <div class="absolute foundation-web-dialog-close-container">
              <button type="button" id="erx-insufficient-close-x"
                  class="foundation-web-close-affordance flex stroke-none bg-none cursor-pointer relative clip group/interactable focus-visible:outline-focus disabled:outline-none bg-over-media-100 padding-small radius-circle"
                  aria-label="Close">
                  <div aria-hidden="true" data-testid="foundation-web-state-layer"
                      class="absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)]"></div>
                  <span aria-hidden="true" data-testid="foundation-web-icon"
                      class="grow-0 shrink-0 basis-auto icon icon-regular-x size-[var(--icon-size-large)] erx-modal-x-fallback" style="font-size:20px;line-height:1;">
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="display:inline-block;flex-shrink:0;"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                  </span>
              </button>
          </div>
          <div class="erx-insufficient-body">
              <h2 id="erx-insufficient-title" class="erx-insufficient-title">You need more Robux</h2>
              <div class="erx-insufficient-item-row">
                  <span class="thumbnail-2d-container erx-insufficient-thumbnail">
                      <img src="${escapeHtml(itemThumb)}" alt="${escapeHtml(itemName)}">
                  </span>
                  <div class="erx-insufficient-details">
                      <span class="erx-insufficient-name">${escapeHtml(itemName)}</span>
                      <span class="erx-insufficient-price">
                          <span aria-hidden="true" data-testid="foundation-web-icon"
                              class="grow-0 shrink-0 basis-auto icon icon-regular-robux size-[var(--icon-size-small)] text-align-y-center margin-right-[2px] erx-robux-icon"></span>
                          <span>${fmt(itemPrice)}</span>
                      </span>
                  </div>
              </div>
          </div>
          <div class="erx-insufficient-footer">
              <a id="erx-buy-robux-btn" href="${buyRobuxUrl}" aria-label="Buy Robux">
                  <span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-filled-arrow-up-right-from-square size-[var(--icon-size-medium)] align-middle"></span>
                  <span>Buy Robux</span>
              </a>
          </div>
      </div>`;

    overlay.querySelector('#erx-insufficient-close-x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeInsufficientRobuxModal();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeInsufficientRobuxModal();
    });
    document.addEventListener('keydown', handleInsufficientRobuxModalKey);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function closeCatalogBuyModal() {
    const modal = document.getElementById(BUY_ITEM_MODAL_ID);
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleBuyItemModalKey);
  }

  function handleBuyItemModalKey(e) {
    if (e.key === 'Escape') closeCatalogBuyModal();
  }

  // Opens the Buy Item modal (from Buy Item.html)
  function openCatalogBuyModal() {
    closeCatalogBuyModal();
    closeCatalogSuccessModal();
    closeInsufficientRobuxModal();

    const itemName = getCatalogItemName();
    const itemPrice = getCatalogItemPrice();
    const itemThumb = getCatalogItemThumbnail();
    const balance = currentBalance() != null ? currentBalance() : readRealRobuxBalance();
    if (itemPrice > balance) {
      openInsufficientRobuxModal({
        name: itemName,
        price: itemPrice,
        thumbnail: itemThumb,
      });
      return;
    }
    const plusUpsellMarkup = state.robloxPlusEnabled ? '' : `
      <button type="button" id="erx-roblox-plus-upsell-btn"
          class="gap-y-medium flex flex-row justify-between padding-medium bg-shift-100 stroke-default stroke-thick radius-medium cursor-pointer text-body-medium margin-top-[12px]">
          <div class="gap-x-small flex items-center">
              <span aria-hidden="true" data-testid="foundation-web-icon"
                  class="grow-0 shrink-0 basis-auto icon icon-regular-roblox-plus size-[var(--icon-size-small)]">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16"><path d="M13.8555 2.5606C15.1824 1.81313 16.8176 1.81313 18.1445 2.5606L26.8555 7.46782C28.1824 8.21534 28.9999 9.59781 29 11.0928V20.9073C29 22.4024 28.1824 23.7847 26.8555 24.5323L18.1445 29.4395L17.8926 29.5704C16.6996 30.143 15.3004 30.143 14.1074 29.5704L13.8555 29.4395L11.0176 27.8409C10.3887 27.4864 10 26.8196 10 26.0977V12.001C10.0002 10.8967 10.8957 10.0012 12 10.001L20 10.0001C21.1044 10 21.9998 10.8957 22 12.0001V19.0001C22 20.1046 21.1046 21.0001 20 21.0001H16C15.4477 21.0001 15 20.5523 15 20.0001C15.0002 19.4479 15.4478 19.0001 16 19.0001H20V12.0001L12 12.001V26.0987L14.8369 27.6973C15.5545 28.1016 16.4455 28.1016 17.1631 27.6973L25.874 22.7891C26.5863 22.3877 27 21.6636 27 20.9073V11.0928C26.9999 10.3366 26.5863 9.61234 25.874 9.21099L17.1631 4.30278C16.4456 3.89864 15.5544 3.89864 14.8369 4.30278L6.12598 9.21099C5.41372 9.61234 5.00013 10.3366 5 11.0928V20.9073C5 21.6636 5.4137 22.3877 6.12598 22.7891L6.49023 22.9942C6.80495 23.1714 7 23.5051 7 23.8663C6.99984 24.6314 6.17549 25.1128 5.50879 24.7374L5.14453 24.5323C3.81763 23.7847 3 22.4024 3 20.9073V11.0928C3.00012 9.69126 3.71827 8.38846 4.90137 7.61528L5.14453 7.46782L13.8555 2.5606Z" fill="currentColor"/></svg>
              </span>
              <span>Get 10% off with Roblox Plus</span>
          </div>
          <span class="content-default underline">Subscribe</span>
      </button>`;

    const overlay = document.createElement('div');
    overlay.id = BUY_ITEM_MODAL_ID;
    overlay.setAttribute('data-state', 'open');
    overlay.className = 'foundation-web-dialog-overlay padding-medium foundation-web-portal-zindex bg-common-backdrop';
    overlay.style.cssText = 'pointer-events: auto; box-sizing: border-box;';

    overlay.innerHTML = `
      <div role="dialog" id="radix-30" aria-labelledby="radix-32" data-state="open"
          class="relative radius-large bg-surface-100 stroke-muted stroke-standard foundation-web-dialog-content shadow-transient-high relative unified-purchase-dialog-content"
          data-size="Large" tabindex="-1" style="pointer-events: auto; max-width: calc(4px * 160); min-width: calc(4px * 75); width: 100%;">
          <div class="absolute foundation-web-dialog-close-container" style="right: 12px; top: 12px; z-index: 1;">
              <button type="button" id="erx-buy-item-close-x"
                  class="foundation-web-close-affordance flex stroke-none bg-none cursor-pointer relative clip group/interactable focus-visible:outline-focus disabled:outline-none bg-over-media-100 padding-small radius-circle"
                  aria-label="Close">
                  <div aria-hidden="true" data-testid="foundation-web-state-layer"
                      class="absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)] group-disabled/interactable:bg-none">
                  </div>
                  <span aria-hidden="true" data-testid="foundation-web-icon"
                      class="grow-0 shrink-0 basis-auto icon icon-regular-x size-[var(--icon-size-large)] erx-modal-x-fallback" style="font-size: 20px; line-height: 1;">
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="display:inline-block;flex-shrink:0;"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                  </span>
              </button>
          </div>
          <div class="padding-x-xlarge padding-top-xlarge padding-bottom-xlarge gap-xlarge flex flex-col erx-buy-modal-body">
              <div style="margin-top: 2px;">
                  <div id="rbx-unified-purchase-heading" class="flex flex-row items-center justify-between erx-buy-modal-heading"
                      style="padding-right: 42px;">
                      <span class="text-heading-medium">Buy Item</span>
                      <div class="flex flex-row items-center" style="display: flex; align-items: center; gap: 4px;">
                          <span class="icon-robux-16x16 erx-robux-icon"></span>
                          <span class="text-robux ml-1 text-body-medium erx-buy-balance">${fmt(balance)}</span>
                      </div>
                  </div>
              </div>
              <div class="flex flex-row items-center gap-large erx-buy-item-row">
                  <div class="relative shrink-0 unified-modal-thumbnail-container"
                      style="max-width: 40vw; max-height: 40vw;">
                      <div class="rounded"
                          style="width: 100%; height: 100%; background-color: rgba(255, 255, 255, 0.06); border-radius: 8px;"></div>
                      <div class="absolute unified-modal-thumbnail"
                          style="inset: 0px; display: flex; align-items: center; justify-content: center; position: absolute;">
                          <div class="marketplace-item-purchase-thumbnail-outer-container">
                              <div class="marketplace-item-purchase-thumbnail-container">
                                  <span class="thumbnail-2d-container erx-buy-thumbnail-frame">
                                      <img src="${escapeHtml(itemThumb)}" alt="${escapeHtml(itemName)}">
                                  </span>
                              </div>
                          </div>
                      </div>
                  </div>
                  <div class="min-w-0 flex flex-col gap-small erx-buy-details">
                      <span class="text-body-large break-words">
                          <span class="font-bold erx-buy-item-name">${escapeHtml(itemName)}</span>
                      </span>
                      <div class="flex flex-row items-center" style="display: flex; align-items: center;">
                          <span class="text-no-wrap erx-buy-price">
                              <span aria-hidden="true" data-testid="foundation-web-icon"
                                  class="grow-0 shrink-0 basis-auto icon icon-regular-robux size-[var(--icon-size-small)] text-align-y-center margin-right-[2px] erx-robux-icon">
                                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.64 2H4.36L2 6.25l6 7.75 6-7.75L11.64 2zM8 11.2 4.4 6.7 5.7 4.4h4.6l1.3 2.3L8 11.2z"/></svg>
                              </span>
                              <span>${fmt(itemPrice)}</span>
                          </span>
                      </div>
                  </div>
              </div>
          </div>
          <div class="padding-x-xlarge padding-bottom-xlarge flex flex-col mt-[40px] erx-buy-modal-footer">
              <div class="gap-small flex flex-col">
                  <div class="flex flex-row-reverse erx-buy-confirm-row">
                      <button type="button" data-testid="purchase-confirm-button" id="erx-buy-item-confirm-btn"
                          class="foundation-web-button relative clip group/interactable focus-visible:outline-focus disabled:outline-none cursor-pointer relative flex items-center justify-center stroke-none padding-y-none select-none radius-medium text-label-large height-1200 padding-x-medium bg-action-emphasis content-action-emphasis fill basis-0"
                          style="text-decoration: none;">
                          <div aria-hidden="true" data-testid="foundation-web-state-layer"
                              class="absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)] group-disabled/interactable:bg-none">
                          </div>
                          <span class="flex items-center min-width-0 gap-small" id="erx-buy-btn-label">
                              <span class="padding-y-xsmall text-truncate-end text-no-wrap">Buy</span>
                          </span>
                      </button>
                  </div>
              </div>
              ${plusUpsellMarkup}
          </div>
      </div>
    `;

    overlay.querySelector('#erx-buy-item-close-x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCatalogBuyModal();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeCatalogBuyModal();
    });

    overlay.querySelector('#erx-buy-item-confirm-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCatalogBuyConfirm(overlay.querySelector('#erx-buy-item-confirm-btn'));
    });

    document.addEventListener('keydown', handleBuyItemModalKey);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function handleCatalogBuyConfirm(btn) {
    if (!btn || btn.getAttribute('data-erx-buying') === 'true') return;
    const itemId = getCatalogItemId();
    const itemName = getCatalogItemName();
    const itemPrice = getCatalogItemPrice();
    const availableRobux = currentBalance() != null ? currentBalance() : readRealRobuxBalance();

    if (itemPrice > availableRobux) {
      openInsufficientRobuxModal({
        name: itemName,
        price: itemPrice,
        thumbnail: getCatalogItemThumbnail(),
      });
      return;
    }

    btn.setAttribute('data-erx-buying', 'true');

    // Match Roblox's disabled Buy state while keeping the Buy label visible.
    btn.classList.add('erx-buy-btn-clicked');
    btn.setAttribute('aria-disabled', 'true');
    btn.style.setProperty('background-color', '#e7e9ec', 'important');
    btn.style.setProperty('background-image', 'none', 'important');
    btn.style.setProperty('border-color', '#e7e9ec', 'important');
    btn.style.setProperty('color', '#8b8d91', 'important');
    btn.style.setProperty('pointer-events', 'none', 'important');
    btn.style.setProperty('cursor', 'default', 'important');

    const purchaseStartedAt = Date.now();

    // 1-second white loading delay before purchase successful modal shows
    setTimeout(() => {
      // 1. Close the Buy Item modal
      closeCatalogBuyModal();
      dismissNativeSheet(document.body);

      // 2. Deduct item price from current balance
      const current = currentBalance() != null ? currentBalance() : 0;
      const remaining = Math.max(0, current - itemPrice);
      state.fake = remaining;
      try {
        chrome.storage.local.set({ robuxAmount: remaining });
      } catch (_) { /* noop */ }
      schedule();

      // 3. Remember as purchased
      if (itemId && !state.purchasedItems.includes(String(itemId))) {
        state.purchasedItems.push(String(itemId));
        setCachedPurchasedItems(state.purchasedItems);
        try {
          chrome.storage.local.set({ purchasedCatalogItems: state.purchasedItems });
        } catch (_) { /* noop */ }
      }
      if (itemId) savePurchasedCatalogDetail(catalogDetailSnapshot(purchaseStartedAt));
      document.documentElement.setAttribute('data-erx-owned', 'true');

      // 4. Mutate page into owned state (matching purchasedCatalogproduct.html)
      applyCatalogPurchasedState();

      // 5. Show purchase success modal (matching PurchasedSuccess.html)
      openCatalogSuccessModal({
        name: itemName,
        balance: remaining,
      });
    }, 1000);
  }

  function findBuyAction(target) {
    if (isBanned) return null;
    if (!isCatalogPage()) return null;
    if (!target || !(target instanceof Element)) return null;
    if (target.closest('#' + MODAL_ID) || target.closest('#' + CATALOG_MODAL_ID) || target.closest('#' + INSUFFICIENT_ROBUX_MODAL_ID)) return null;

    // Inside our custom Buy Item modal?
    const customBuyModal = target.closest('#' + BUY_ITEM_MODAL_ID);
    if (customBuyModal) {
      const confirmBtn = target.closest('button[data-testid="purchase-confirm-button"], #erx-buy-item-confirm-btn');
      if (confirmBtn) {
        return { kind: 'confirm', btn: confirmBtn };
      }
      return null;
    }

    // Direct button or element clicked
    const btn = target.closest('button, [role="button"], a.btn-growth-lg, .shopping-cart-buy-button, .PurchaseButton');
    if (!btn) return null;

    // Never hijack navigation bar, footer, or auxiliary buttons
    if (btn.closest('nav, #navbar, #navigation, [class*="favorite"], [class*="share"], [class*="report"]')) return null;

    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const text = (btn.textContent || '').trim().toLowerCase();
    const cls = (btn.className || '').toLowerCase();
    const testid = (btn.getAttribute('data-testid') || '').toLowerCase();

    // Exclude Close / Cancel / No
    if (aria === 'close' || btn.classList.contains('foundation-web-close-affordance')) return null;
    if (text === 'cancel' || text === 'no' || text === 'close') return null;

    // Check if it's the Buy button
    const isBuy =
      cls.includes('shopping-cart-buy-button') ||
      cls.includes('purchasebutton') ||
      testid.includes('purchase') ||
      testid.includes('buy') ||
      aria === 'buy' ||
      aria.startsWith('buy ') ||
      aria === 'get' ||
      text === 'buy' ||
      text.startsWith('buy ') ||
      text === 'get' ||
      text.includes('purchase') ||
      (btn.classList.contains('bg-action-emphasis') && btn.closest('.price-row-container, .item-purchase-btns-container, [role="dialog"], [id^="radix-"]'));

    if (isBuy) {
      const nativeDialog = btn.closest('[role="dialog"], [id^="radix-"], [class*="foundation-web-dialog-content"]');
      if (nativeDialog && !nativeDialog.closest('#' + BUY_ITEM_MODAL_ID) && !nativeDialog.closest('#' + CATALOG_MODAL_ID)) {
        dismissNativeSheet(nativeDialog);
      }
      return { kind: 'open_buy_modal', btn };
    }

    return null;
  }

  /* ======================= click interception ======================== */

  const armGuard = () => {
    try { document.documentElement.setAttribute('data-erx-guard', String(Date.now())); } catch (_) { /* noop */ }
  };

  const isProfilePage = () => /^\/users\/\d+/i.test(location.pathname);

  function isSendRobuxSearchInteraction(el) {
    if (!el || !(el instanceof Element)) return false;
    return !!el.closest(
      '.send-robux-search-row, .send-robux-search-input, ' +
      '[data-testid="send-robux-search-row"], [data-testid="search-input-wrapper"], ' +
      '[data-testid="search-input-container"], [data-testid="search-input-leading-icon"], ' +
      'input[name="user-search"], input[type="search"], textarea, [contenteditable="true"]'
    );
  }

  function friendCardOf(el) {
    if (isSendRobuxSearchInteraction(el)) return null;
    const direct = el.closest('.send-robux-user-row');
    if (direct) return direct;
    const option = el.closest('[role="option"]');
    if (!option) return null;
    const list = option.closest('[role="listbox"]');
    if (!list) return null;
    const label = (list.getAttribute('aria-label') || '').toLowerCase();
    if (label.indexOf('friend') !== -1 || list.querySelector('.send-robux-user-row')) return option;
    return null;
  }

  function userFromCard(card) {
    const img = card.querySelector(
      '[data-testid="avatar-image"], [data-testid="avatar-content"] img, ' +
      '.avatar-card-image img, .avatar img, img'
    );
    const nameNode = card.querySelector('[data-testid="user-row-name"]');
    const usernameNode = card.querySelector(
      '[data-testid="user-row-username"], [data-testid*="username"], [data-username]'
    );
    const explicitUsername = String(
      (usernameNode && (usernameNode.getAttribute('data-username') || usernameNode.textContent)) ||
      card.getAttribute('data-username') ||
      ''
    ).trim().replace(/^@/, '');
    const visibleName = String((nameNode && nameNode.textContent) || '').trim();
    const name = (
      explicitUsername ||
      visibleName ||
      card.getAttribute('aria-label') ||
      (img && img.alt) ||
      ''
    ).trim();
    const idNode = card.matches('[data-user-id], [data-userid], [data-user-id-number]')
      ? card
      : card.querySelector('[data-user-id], [data-userid], [data-user-id-number]');
    const rawCardId = idNode && (
      idNode.getAttribute('data-user-id') ||
      idNode.getAttribute('data-userid') ||
      idNode.getAttribute('data-user-id-number')
    );
    const link = card.querySelector('a[href*="/users/"]');
    const linkId = link ? ((link.getAttribute('href').match(/\/users\/(\d+)/) || [])[1] || '') : '';
    const rawId = String(rawCardId || linkId || '').trim();
    const id = /^\d{1,15}$/.test(rawId) && Number(rawId) > 0 ? rawId : null;
    const avatar = img ? String(img.currentSrc || img.src || img.getAttribute('src') || '') : '';
    return {
      id,
      name: name || 'Player',
      displayName: visibleName || name || 'Player',
      avatar,
      fromFriendCard: true,
    };
  }

  function profileUser() {
    const id = (location.pathname.match(/\/users\/(\d+)/) || [])[1] || null;
    const nameEl = document.querySelector(
      '[data-testid="profile-header-title"], .profile-header-title, .profile-name, .header-title h1, .header-title h2, h1'
    );
    let name = nameEl ? nameEl.textContent.trim() : '';
    if (!name) name = (document.title || '').split(/\s*[|\u2013-]\s*/)[0].trim();
    const img = document.querySelector(
      '[data-testid="profile-avatar"] img, .profile-avatar-image, .profile-avatar-thumb img, .avatar-card-image img, [data-testid="avatar-image"], .avatar-thumbnail-image'
    );
    return { id, name: name || 'Player', displayName: name || 'Player', avatar: img ? img.src : '' };
  }

  function isNativeSheetBackdrop(target) {
    if (!target || !(target instanceof Element)) return false;
    const overlay = target.closest('[data-testid="fui-base-sheet-overlay"]');
    if (!overlay) return false;
    return !target.closest(
      '[data-testid="fui-base-sheet-content"], [role="dialog"], [aria-modal="true"]'
    );
  }

  function isSendControl(el) {
    if (!el || !(el instanceof Element)) return false;
    if (isSendRobuxSearchInteraction(el)) return false;
    if (isNativeSheetBackdrop(el)) return false;
    // Match buttons, links, role="button", and Radix/Foundation menu items in 3-dots menus
    const control = el.closest(
      'button, a, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [data-radix-collection-item], [class*="menu-item"], [class*="dropdown-item"], [class*="popover-item"], li'
    ) || el.closest('[data-testid*="send"], [id*="send"]');

    if (!control || control.closest('#' + MODAL_ID) || control.closest('#' + CATALOG_MODAL_ID) || control.closest('#' + INSUFFICIENT_ROBUX_MODAL_ID)) return false;

    // Never hijack navigation bar balance or transactions table
    if (control.closest('nav, #navbar, #navigation, [class*="navbar"], [data-testid="navigation"], table')) return false;

    // Direct IDs and test IDs
    const id = (control.id || '').toLowerCase();
    const testid = (control.getAttribute('data-testid') || '').toLowerCase();
    if (id === 'profile-send' || id === 'hero-send-button' || id.includes('send-robux')) return true;
    if (testid === 'profile-send' || testid === 'send-robux' || testid === 'profile-send-button' || testid.includes('send-robux')) return true;

    const text = (control.textContent || '').trim().toLowerCase();
    const aria = (control.getAttribute('aria-label') || '').trim().toLowerCase();
    const title = (control.getAttribute('title') || '').trim().toLowerCase();
    const href = (control.getAttribute('href') || '').trim().toLowerCase();

    // Exclude unrelated actions (messages, feedback, trade, friend request)
    if (text.includes('send message') || aria.includes('send message')) return false;
    if (text.includes('send feedback') || aria.includes('send feedback')) return false;
    if (text.includes('send request') || aria.includes('send request')) return false;

    // Check for Send Robux / Send
    if (aria === 'send' || aria === 'send robux' || aria.includes('send robux')) return true;
    if (title === 'send' || title === 'send robux' || title.includes('send robux')) return true;
    if (text === 'send' || text === 'send robux' || text.startsWith('send robux') || text.includes('send robux')) return true;
    if (/\bsend\b/i.test(text)) return true;

    // Roblox launcher protocol link
    if (href.startsWith('roblox:') || href.startsWith('roblox-player:') || href.startsWith('roblox-app:')) return true;

    // If button has a robux icon inside it AND the word "send"
    if (text.includes('send') && (control.querySelector('.icon-robux, [class*="robux"]') || aria.includes('robux'))) return true;

    return false;
  }

  function isSendPickerLauncher(el) {
    if (!el || !(el instanceof Element) || isProfilePage()) return false;
    const control = el.closest(
      'button, a, [role="button"], [role="menuitem"], [data-radix-collection-item], [class*="menu-item"], [class*="dropdown-item"], li'
    );
    if (!control || !isSendControl(control)) return false;

    // A recipient is not chosen yet: this top-level action must be allowed to
    // open Roblox's own friend/player picker. Rows inside that picker continue
    // through the custom Send Robux flow below.
    if (control.closest('.send-robux-user-row, [role="option"], .user-card, [data-user-id], [data-testid="user-row"]')) return false;
    if (control.closest('[role="dialog"], [role="menu"], [aria-modal="true"], [data-radix-popper-content-wrapper]')) return false;
    return true;
  }

  // Which element (if any) must be hijacked for this event target?
  function matchTarget(target) {
    if (isBanned) return null;
    if (!(target instanceof Element)) return null;
    if (isSendRobuxSearchInteraction(target)) return null;
    // Clicking outside a native center sheet is only a request to dismiss it.
    // Its descendant text may contain "Send Robux", but the backdrop itself is
    // never a Send control and must not launch our custom modal.
    if (isNativeSheetBackdrop(target)) return null;
    if (target.closest('#' + MODAL_ID) || target.closest('#' + CATALOG_MODAL_ID) || target.closest('#' + INSUFFICIENT_ROBUX_MODAL_ID)) return null;
    if (target.closest('[data-erx-ignore]')) return null;

    const payout = payoutInfoFor(target);
    if (payout) return payout;

    const card = friendCardOf(target);
    if (card) return { user: userFromCard(card), kind: 'friend' };

    // Let the first Send Robux click open Roblox's recipient picker. We only
    // hijack the selected player row, when a concrete recipient exists.
    if (isSendPickerLauncher(target)) return null;

    // Send control (on profile page, user card, 3-dots menu, or any user view)
    if (isSendControl(target)) {
      const cardParent = target.closest('.send-robux-user-row, [role="option"], .user-card, [data-user-id]');
      if (cardParent) {
        return { user: userFromCard(cardParent), kind: 'friend' };
      }
      return { user: profileUser(), kind: 'profile' };
    }

    const launch = target.closest('a[href^="roblox:" i], a[href^="roblox-player:" i], a[href^="roblox-studio:" i]');
    if (launch) {
      const ctx = launch.closest('.send-robux-user-row, [role="option"], [class*="send-robux"]');
      if (ctx) return { user: userFromCard(ctx), kind: 'launch' };
      return { user: profileUser(), kind: 'launch' };
    }
    return null;
  }

  let lastOpen = 0;

  // The native "Send Robux" sheet or 3-dots Radix menu stays open
  // behind our overlay, so close it before showing our own modal.
  function dismissNativeSheet(el) {
    if (!(el instanceof Element)) return;
    const sheet = el.closest(
      '[data-testid="fui-base-sheet-content"], [role="dialog"], [role="menu"], [aria-modal="true"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [class*="fui-sheet"], [class*="fui-modal"], [class*="popover"], [class*="dropdown-menu"]'
    );
    if (sheet) {
      const closeBtn = sheet.querySelector(
        'button[aria-label="Close" i], [data-testid*="sheet-close"], .fui-sheet-close-affordance-container button, button[data-radix-dialog-close]'
      );
      if (closeBtn) {
        try { closeBtn.click(); } catch (_) { /* noop */ }
      }
    }
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    } catch (_) { /* noop */ }
  }

  function swallow(e) {
    try { e.preventDefault(); } catch (_) { /* noop */ }
    try { e.stopPropagation(); } catch (_) { /* noop */ }
    try { e.stopImmediatePropagation(); } catch (_) { /* noop */ }
  }

  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'auxclick'].forEach((type) => {
    window.addEventListener(
      type,
      (e) => {
        if (isAvatarEditorPage() && e.target instanceof Element && e.target.closest('[data-erx-inventory-item]')) {
          // These cards are preview/equip controls, never links to the catalog.
          // Suppress Roblox's pointer-level SPA navigation before it can run.
          swallow(e);
          return;
        }
        const buyAction = findBuyAction(e.target);
        if (buyAction) {
          swallow(e);
          return;
        }
        const hit = matchTarget(e.target);
        if (!hit) return;
        armGuard();
        swallow(e);
      },
      { capture: true, passive: false }
    );
  });

  window.addEventListener(
    'click',
    (e) => {
      if (handleAvatarInventoryClick(e.target)) {
        swallow(e);
        return;
      }
      const buyAction = findBuyAction(e.target);
      if (buyAction) {
        swallow(e);
        if (buyAction.kind === 'confirm') {
          handleCatalogBuyConfirm(buyAction.btn);
        } else if (buyAction.kind === 'open_buy_modal') {
          dismissNativeSheet(document.body);
          openCatalogBuyModal();
        }
        return;
      }
      const hit = matchTarget(e.target);
      if (!hit) return;
      armGuard();
      swallow(e);
      const now = Date.now();
      if (now - lastOpen < 350) return;
      lastOpen = now;
      if (hit.kind === 'payout') {
        openPayoutModal(hit.data);
        return;
      }
      dismissNativeSheet(e.target);
      openSendModal(hit.user);
    },
    true
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (handleAvatarInventoryClick(e.target)) {
        swallow(e);
        return;
      }
      const buyAction = findBuyAction(e.target);
      if (buyAction) {
        swallow(e);
        if (buyAction.kind === 'confirm') {
          handleCatalogBuyConfirm(buyAction.btn);
        } else if (buyAction.kind === 'open_buy_modal') {
          dismissNativeSheet(document.body);
          openCatalogBuyModal();
        }
        return;
      }
      const hit = matchTarget(e.target);
      if (!hit) return;
      armGuard();
      swallow(e);
      const now = Date.now();
      if (now - lastOpen < 350) return;
      lastOpen = now;
      if (hit.kind === 'payout') {
        openPayoutModal(hit.data);
        return;
      }
      dismissNativeSheet(e.target);
      openSendModal(hit.user);
    },
    true
  );

  /* =============================== boot ============================== */

  let decorationTimer = 0;
  function scheduleDecorations() {
    if (decorationTimer) return;
    decorationTimer = setTimeout(() => {
      decorationTimer = 0;
      if (isCatalogPage()) {
        applyCatalogOwnership();
        scheduleCatalogPreviewCapture();
      } else {
        checkCatalogPageNav();
      }
      if (isAvatarEditorPage()) scheduleAvatarInventory();
      else if (liveTryOnJob) cancelLiveTryOnRefresh();
      applyBadges();
    }, 80);
  }

  const observer = new MutationObserver(() => {
    schedule();
    scheduleTx();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      checkCatalogPageNav();
      prefetchProfilePage();
    }
    scheduleDecorations();
    prefetchSoon();
  });

  // Instant SPA navigation hooks
  window.addEventListener('erx-nav-change', () => {
    lastPath = location.pathname;
    checkCatalogPageNav();
    scheduleCatalogPreviewCapture();
    scheduleAvatarInventory();
    scheduleBadges();
  });

  window.addEventListener('popstate', () => {
    lastPath = location.pathname;
    checkCatalogPageNav();
    scheduleCatalogPreviewCapture();
    scheduleAvatarInventory();
    scheduleBadges();
  });

  // Desktop device emulation and real phone rotation can replace Roblox's
  // navbar without a route change. Re-run only the lightweight schedulers.
  let responsiveLayoutTimer = 0;
  const scheduleResponsiveLayout = () => {
    if (responsiveLayoutTimer) clearTimeout(responsiveLayoutTimer);
    responsiveLayoutTimer = setTimeout(() => {
      responsiveLayoutTimer = 0;
      schedule();
      scheduleDecorations();
    }, 80);
  };
  window.addEventListener('resize', scheduleResponsiveLayout, { passive: true });
  window.addEventListener('orientationchange', scheduleResponsiveLayout, { passive: true });

  document.addEventListener(
    'pointerdown',
    (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href], [data-item-id], [data-target-id]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const id = a.getAttribute('data-item-id') || a.getAttribute('data-target-id');
      const targetId = id || (href.match(/\/(?:catalog|bundles|items)\/(\d+)/i) || [])[1];
      if (targetId && state.purchasedItems && state.purchasedItems.includes(String(targetId))) {
        document.documentElement.setAttribute('data-erx-owned', 'true');
      }
    },
    true
  );

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message) return;
      if (message.type === 'ERX_STATE') {
        sendResponse({
          real: state.realText,
          realDigits: state.realDigits,
          fake: state.fake,
          path: location.pathname,
          robloxPlusDetected: state.robloxPlusEnabled,
          verifiedDetected: state.verifiedBadgeEnabled,
        });
        return;
      }
    });
  } catch (_) { /* noop */ }

  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch (_) {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    });
  }

  try {
    if (window.ERXTracker && typeof window.ERXTracker.start === 'function') {
      window.ERXTracker.start();
    }
  } catch (_) { /* noop */ }

  loadStorage();
  prefetchProfilePage();
  prefetchSoon();
  checkCatalogPageNav();
  scheduleCatalogPreviewCapture();
  scheduleAvatarInventory();
  document.addEventListener('DOMContentLoaded', () => {
    injectPageStyle();
    schedule();
    scheduleTx();
    applyCatalogOwnership();
    scheduleCatalogPreviewCapture();
    scheduleAvatarInventory();
    scheduleBadges();
  });
})();
