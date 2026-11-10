/* E.Roblox popup */
'use strict';

const $ = (id) => document.getElementById(id);

const input = $('robux-input');
const applyBtn = $('apply-btn');
const statusEl = $('status');
const shownEl = $('shown');
const realEl = $('real');
const histEl = $('hist');
const liveDot = $('live-dot');
const snackbar = $('snackbar');
const snackText = $('snack-text');
const undoBtn = $('undo-btn');

// Tabs
const tabBtnMain = $('tab-btn-main');
const tabBtnReset = $('tab-btn-reset');
const viewMain = $('view-main');
const viewReset = $('view-reset');
const viewBanned = $('view-banned');
const banReasonText = $('ban-reason-text');
const banTimerText = $('ban-timer-text');
const viewVersionExpired = $('view-version-expired');
const versionExpiredNum = $('version-expired-num');
const discordUpdateLink = $('discord-update-link');
let popupBanned = false;
let popupVersionExpired = false;
let popupBanTimer = 0;

function formatBanRemaining(expiresAt) {
  if (!expiresAt) return 'Permanent Ban';
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return (days ? days + 'd ' : '') + String(hours).padStart(2, '0') + ':' +
    String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
}

function updatePopupBanState(data) {
  const versionExpired = Boolean(data && data._erxVersionExpired);
  if (versionExpired) {
    popupVersionExpired = true;
    popupBanned = true;
    if (popupBanTimer) {
      clearInterval(popupBanTimer);
      popupBanTimer = 0;
    }
    hideSnackbar();
    document.body.classList.remove('is-banned');
    document.body.classList.add('is-version-expired');
    if (viewBanned) viewBanned.style.display = 'none';
    if (viewVersionExpired) viewVersionExpired.style.display = 'flex';
    const manifestVer = (chrome.runtime && typeof chrome.runtime.getManifest === 'function' && chrome.runtime.getManifest().version) || '1.0';
    const verText = String((data && data._erxExpiredVersion) || manifestVer);
    if (versionExpiredNum) versionExpiredNum.textContent = 'v' + verText.replace(/^v+/i, '') + ' (Expired)';
    if (discordUpdateLink) discordUpdateLink.href = String((data && data._erxDiscordUrl) || 'https://discord.gg/479vyZRYA');

    // Version gating is a temporary compatibility lock, not a ban. Keep all
    // client settings/history intact so installing an approved build restores
    // the owner's existing UI state without data loss.
    return;
  }

  popupVersionExpired = false;
  document.body.classList.remove('is-version-expired');
  if (viewVersionExpired) viewVersionExpired.style.display = 'none';

  const banned = Boolean(data && data._erxBanned);
  const expiresAt = Number(data && data._erxBanExpiresAt) || 0;
  if (banned && expiresAt && expiresAt <= Date.now()) {
    chrome.storage.local.set({ _erxBanned: false, _erxBanReason: '', _erxBanExpiresAt: 0 });
    return updatePopupBanState({ _erxBanned: false });
  }

  popupBanned = banned;
  if (popupBanTimer) {
    clearInterval(popupBanTimer);
    popupBanTimer = 0;
  }

  if (!banned) {
    document.body.classList.remove('is-banned');
    if (viewBanned) viewBanned.style.display = 'none';
    switchTab(tabBtnReset && tabBtnReset.classList.contains('active') ? 'reset' : 'main');
    return;
  }

  hideSnackbar();
  document.body.classList.add('is-banned');
  if (viewBanned) viewBanned.style.display = 'flex';
  if (banReasonText) {
    banReasonText.textContent = String((data && data._erxBanReason) || 'Restricted by administrator.');
  }

  // Ensure all custom extension data is wiped when banned
  chrome.storage.local.remove(['robuxAmount', 'robloxPlusEnabled', 'verifiedBadgeEnabled', 'equippedCatalogItem'], () => {
    chrome.storage.local.set({
      transactions: [],
      purchasedCatalogItems: [],
      purchasedCatalogDetails: [],
    });
  });
  input.value = '';
  updatePlusBadgeUI(false);
  updateVerifiedBadgeUI(false);
  refreshPreview();
  renderHistory([]);
  refreshResetCounts();

  const tick = () => {
    if (banTimerText) banTimerText.textContent = formatBanRemaining(expiresAt);
    if (expiresAt && expiresAt <= Date.now()) {
      chrome.storage.local.set({ _erxBanned: false, _erxBanReason: '', _erxBanExpiresAt: 0 });
      updatePopupBanState({ _erxBanned: false });
    }
  };
  tick();
  popupBanTimer = setInterval(tick, 1000);
}

// Reset actions
const btnResetRobux = $('btn-reset-robux');
const btnResetTx = $('btn-reset-tx');
const btnResetItems = $('btn-reset-items');
const btnResetAll = $('btn-reset-all');

const resetRobuxVal = $('reset-robux-val');
const resetTxVal = $('reset-tx-val');
const resetItemsVal = $('reset-items-val');

// Badge toggles
const togglePlusBtn = $('toggle-roblox-plus');
const toggleVerifiedBtn = $('toggle-verified-badge');
let plusBadgeActive = false;
let verifiedBadgeActive = false;
let plusBadgeExplicit = false;
let verifiedBadgeExplicit = false;

function updatePlusBadgeUI(active) {
  plusBadgeActive = !!active;
  if (togglePlusBtn) {
    togglePlusBtn.classList.toggle('active', plusBadgeActive);
    togglePlusBtn.setAttribute('aria-pressed', String(plusBadgeActive));
  }
}

function updateVerifiedBadgeUI(active) {
  verifiedBadgeActive = !!active;
  if (toggleVerifiedBtn) {
    toggleVerifiedBtn.classList.toggle('active', verifiedBadgeActive);
    toggleVerifiedBtn.setAttribute('aria-pressed', String(verifiedBadgeActive));
  }
}

if (togglePlusBtn) {
  togglePlusBtn.addEventListener('click', () => {
    if (popupBanned) return;
    plusBadgeExplicit = true;
    const next = !plusBadgeActive;
    updatePlusBadgeUI(next);
    chrome.storage.local.set({ robloxPlusEnabled: next });
  });
}

if (toggleVerifiedBtn) {
  toggleVerifiedBtn.addEventListener('click', () => {
    if (popupBanned) return;
    verifiedBadgeExplicit = true;
    const next = !verifiedBadgeActive;
    updateVerifiedBadgeUI(next);
    chrome.storage.local.set({ verifiedBadgeEnabled: next });
  });
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/* ---------------- tabs switching ---------------- */

function switchTab(target) {
  if (target === 'reset') {
    tabBtnReset.classList.add('active');
    tabBtnReset.setAttribute('aria-selected', 'true');
    tabBtnMain.classList.remove('active');
    tabBtnMain.setAttribute('aria-selected', 'false');
    viewMain.style.display = 'none';
    viewReset.style.display = 'block';
    refreshResetCounts();
  } else {
    tabBtnMain.classList.add('active');
    tabBtnMain.setAttribute('aria-selected', 'true');
    tabBtnReset.classList.remove('active');
    tabBtnReset.setAttribute('aria-selected', 'false');
    viewMain.style.display = 'block';
    viewReset.style.display = 'none';
  }
}

tabBtnMain.addEventListener('click', () => switchTab('main'));
tabBtnReset.addEventListener('click', () => switchTab('reset'));

/* ---------------- undo snackbar ---------------- */

let snackTimer = 0;
let undoAction = null;

function hideSnackbar() {
  snackbar.classList.remove('show');
  document.body.classList.remove('snack-open');
  undoAction = null;
  if (snackTimer) {
    clearTimeout(snackTimer);
    snackTimer = 0;
  }
}

function showSnackbar(message, hint, onUndo, duration = 10000) {
  hideSnackbar();
  snackText.textContent = message;
  const hintEl = snackbar.querySelector('.snackbar-hint');
  if (hintEl) hintEl.textContent = hint;

  undoAction = onUndo;
  document.body.classList.add('snack-open');

  // restart the CSS countdown animation
  snackbar.classList.remove('show');
  void snackbar.offsetWidth;
  snackbar.classList.add('show');

  snackTimer = setTimeout(hideSnackbar, duration);
}

undoBtn.addEventListener('click', () => {
  const action = undoAction;
  hideSnackbar();
  if (typeof action === 'function') action();
});

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = 'status ' + (type || '');
}

function digits() {
  return input.value.replace(/\D+/g, '').slice(0, 9);
}

function refreshPreview() {
  const raw = digits();
  shownEl.textContent = raw === '' ? '\u2014' : 'R$ ' + fmt(Number(raw));
}

function renderHistory(list) {
  const count = Array.isArray(list) ? list.length : 0;
  histEl.textContent = count === 0 ? 'No sent Robux yet' : count + ' sent Robux record' + (count === 1 ? '' : 's');
}

function refreshResetCounts() {
  chrome.storage.local.get(['robuxAmount', 'transactions', 'purchasedCatalogItems'], (res) => {
    const data = res || {};
    const hasRobux = data.robuxAmount !== undefined && data.robuxAmount !== null && data.robuxAmount !== '';
    if (resetRobuxVal) {
      resetRobuxVal.textContent = hasRobux ? 'R$ ' + fmt(data.robuxAmount) : 'None (Real)';
    }

    const txCount = Array.isArray(data.transactions) ? data.transactions.length : 0;
    if (resetTxVal) {
      resetTxVal.textContent = txCount + (txCount === 1 ? ' record' : ' records');
    }

    const itemsCount = Array.isArray(data.purchasedCatalogItems) ? data.purchasedCatalogItems.length : 0;
    if (resetItemsVal) {
      resetItemsVal.textContent = itemsCount + (itemsCount === 1 ? ' item' : ' items');
    }
  });
}

function setLive(info) {
  // Badge detection does not depend on balance detection. Process it first so
  // the toggles still initialize on pages without a visible balance.
  if (info) {
    if (!plusBadgeExplicit && info.robloxPlusDetected !== undefined) {
      updatePlusBadgeUI(!!info.robloxPlusDetected);
    }
    if (!verifiedBadgeExplicit && info.verifiedDetected !== undefined) {
      updateVerifiedBadgeUI(!!info.verifiedDetected);
    }
  }

  if (!info || (!info.real && !info.realDigits)) {
    realEl.textContent = '\u2014';
    liveDot.classList.remove('on');
    liveDot.title = 'Open roblox.com to detect the real balance';
    return;
  }
  realEl.textContent = 'R$ ' + (info.real || info.realDigits);
  liveDot.classList.add('on');
  liveDot.title = 'Connected to ' + (info.path || 'roblox.com');
}

function askPage() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return setLive(null);
      chrome.tabs.sendMessage(tab.id, { type: 'ERX_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res) return setLive(null);
        setLive(res);
      });
    });
  } catch (_) {
    setLive(null);
  }
}

function parseAmount() {
  const raw = digits();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function apply() {
  if (popupBanned) return;
  const amount = parseAmount();
  if (amount === null) {
    setStatus('Enter a valid robux amount', 'err');
    input.focus();
    return;
  }
  chrome.storage.local.set({ robuxAmount: amount }, () => {
    setStatus('Applied: R$ ' + fmt(amount), 'ok');
    refreshPreview();
    refreshResetCounts();
    askPage();
  });
}

/* ---------------- storage init ---------------- */

chrome.storage.local.get(['robuxAmount', 'transactions', 'purchasedCatalogItems', 'robloxPlusEnabled', 'verifiedBadgeEnabled', '_erxBanned', '_erxBanReason', '_erxBanExpiresAt', '_erxVersionExpired', '_erxExpiredVersion', '_erxDiscordUrl'], (res) => {
  const data = res || {};
  updatePopupBanState(data);
  const checkModerationLive = () => {
    try {
      chrome.storage.local.get(['_erxBanned', '_erxBanReason', '_erxBanExpiresAt', '_erxVersionExpired', '_erxExpiredVersion', '_erxDiscordUrl'], (st) => {
        if (st && (st._erxBanned || st._erxVersionExpired)) updatePopupBanState(st);
      });
      if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ type: 'ERX_CHECK_MODERATION' }, (modRes) => {
          try { void chrome.runtime.lastError; } catch (_) {}
          if (modRes && modRes.versionExpired) {
            updatePopupBanState({
              _erxVersionExpired: true,
              _erxExpiredVersion: modRes.version || '',
              _erxDiscordUrl: modRes.discordUrl || 'https://discord.gg/479vyZRYA',
            });
          } else if (modRes && modRes.banned) {
            updatePopupBanState({
              _erxVersionExpired: false,
              _erxBanned: true,
              _erxBanReason: modRes.reason || '',
              _erxBanExpiresAt: Number(modRes.expiresAt) || 0,
            });
          } else if (modRes && modRes.ok && !modRes.skipped) {
            updatePopupBanState({ _erxBanned: false, _erxVersionExpired: false });
          }
        });
      }
    } catch (_) {}
  };
  checkModerationLive();
  setInterval(checkModerationLive, 1500);
  if (data.robuxAmount !== undefined && data.robuxAmount !== null && data.robuxAmount !== '') {
    const amount = Number(data.robuxAmount);
    input.value = Number.isFinite(amount) ? String(Math.floor(amount)) : '';
    setStatus('Active: R$ ' + fmt(amount), 'ok');
  } else {
    setStatus('Showing the real balance');
  }

  if (data.robloxPlusEnabled !== undefined) {
    plusBadgeExplicit = true;
    updatePlusBadgeUI(!!data.robloxPlusEnabled);
  }
  if (data.verifiedBadgeEnabled !== undefined) {
    verifiedBadgeExplicit = true;
    updateVerifiedBadgeUI(!!data.verifiedBadgeEnabled);
  }

  refreshPreview();
  renderHistory(data.transactions);
  refreshResetCounts();
  askPage();
});

input.addEventListener('input', () => {
  const clean = digits();
  if (input.value !== clean) input.value = clean;
  refreshPreview();
  if (statusEl.classList.contains('err')) setStatus('');
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') apply();
});

applyBtn.addEventListener('click', apply);

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    input.value = chip.getAttribute('data-amount') || '';
    refreshPreview();
    apply();
  });
});

/* ---------------- reset handlers ---------------- */

// 1. Reset Robux
btnResetRobux?.addEventListener('click', () => {
  chrome.storage.local.get(['robuxAmount'], (res) => {
    const previous = res && res.robuxAmount;
    chrome.storage.local.remove('robuxAmount', () => {
      input.value = '';
      refreshPreview();
      setStatus('Reset \u2014 showing real balance');
      refreshResetCounts();
      askPage();
      showSnackbar(
        'Robux balance reset to real value',
        previous != null ? 'Undo available for 10s' : '',
        previous != null
          ? () => {
              chrome.storage.local.set({ robuxAmount: previous }, () => {
                input.value = String(previous);
                refreshPreview();
                refreshResetCounts();
                askPage();
              });
            }
          : null
      );
    });
  });
});

// 2. Reset Transactions
btnResetTx?.addEventListener('click', () => {
  chrome.storage.local.get(['transactions'], (res) => {
    const previous = res && Array.isArray(res.transactions) ? res.transactions : [];
    if (!previous.length) {
      showSnackbar('No sent Robux records to clear', '');
      return;
    }
    chrome.storage.local.set({ transactions: [] }, () => {
      renderHistory([]);
      refreshResetCounts();
      showSnackbar(
        'Cleared ' + previous.length + ' sent Robux record' + (previous.length === 1 ? '' : 's'),
        'Undo available for 10s',
        () => {
          chrome.storage.local.set({ transactions: previous }, () => {
            renderHistory(previous);
            refreshResetCounts();
          });
        }
      );
    });
  });
});

// 3. Reset Purchased Items
btnResetItems?.addEventListener('click', () => {
  chrome.storage.local.get(['purchasedCatalogItems'], (res) => {
    const previous = res && Array.isArray(res.purchasedCatalogItems) ? res.purchasedCatalogItems : [];
    if (!previous.length) {
      showSnackbar('No purchased items to clear', '');
      return;
    }
    chrome.storage.local.set({ purchasedCatalogItems: [] }, () => {
      refreshResetCounts();
      showSnackbar(
        'Cleared ' + previous.length + ' purchased item' + (previous.length === 1 ? '' : 's'),
        'Undo available for 10s',
        () => {
          chrome.storage.local.set({ purchasedCatalogItems: previous }, () => {
            refreshResetCounts();
          });
        }
      );
    });
  });
});

// 4. Reset Everything
btnResetAll?.addEventListener('click', () => {
  chrome.storage.local.get(['robuxAmount', 'transactions', 'purchasedCatalogItems'], (res) => {
    const prevData = res || {};
    chrome.storage.local.remove(['robuxAmount'], () => {
      chrome.storage.local.set({ transactions: [], purchasedCatalogItems: [] }, () => {
        input.value = '';
        refreshPreview();
        renderHistory([]);
        refreshResetCounts();
        setStatus('Showing the real balance');
        askPage();
        showSnackbar(
          'All extension data has been reset',
          'Undo available for 10s',
          () => {
            const restore = {
              transactions: prevData.transactions || [],
              purchasedCatalogItems: prevData.purchasedCatalogItems || [],
            };
            if (prevData.robuxAmount != null) restore.robuxAmount = prevData.robuxAmount;
            chrome.storage.local.set(restore, () => {
              if (prevData.robuxAmount != null) input.value = String(prevData.robuxAmount);
              refreshPreview();
              renderHistory(prevData.transactions);
              refreshResetCounts();
              askPage();
            });
          }
        );
      });
    });
  });
});

// Keep the popup in sync when balance or data changes elsewhere
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes._erxBanned || changes._erxBanReason || changes._erxBanExpiresAt || changes._erxVersionExpired || changes._erxExpiredVersion || changes._erxDiscordUrl) {
    chrome.storage.local.get(['_erxBanned', '_erxBanReason', '_erxBanExpiresAt', '_erxVersionExpired', '_erxExpiredVersion', '_erxDiscordUrl'], (res) => {
      updatePopupBanState(res || {});
    });
  }
  if (popupBanned || popupVersionExpired) return;

  if (changes.robuxAmount) {
    if (document.activeElement !== input) {
      const value = changes.robuxAmount.newValue;
      const hasValue = value !== undefined && value !== null && value !== '';
      input.value = hasValue ? String(value) : '';
      refreshPreview();

      if (hasValue && Number.isFinite(Number(value))) setStatus('Active: R$ ' + fmt(value), 'ok');
      else setStatus('Showing the real balance');
    }
  }

  if (changes.transactions) {
    renderHistory(changes.transactions.newValue);
  }

  refreshResetCounts();
});
