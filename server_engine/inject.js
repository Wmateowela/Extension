/*
 * E.Roblox — MAIN world guard (runs at document_start).
 *
 * Roblox opens the desktop app by navigating to a `roblox://` / `roblox-player://`
 * URL, which makes the browser show the "Open Roblox?" dialog. The content
 * script swallows the click itself, and this script is the safety net: while the
 * guard is armed (a friend card / Send button was just clicked) every attempt to
 * launch the protocol from JS is dropped, so the dialog can never appear.
 *
 * The guard is time limited (~4s) so normal "Play" buttons keep working.
 */
(() => {
  'use strict';

  const PROTO = /^\s*roblox(-player|-studio|-studio-auth|-app)?:/i;
  const GUARD_ATTR = 'data-erx-guard';
  const GUARD_MS = 4000;

  const armed = () => {
    try {
      const stamp = Number(document.documentElement.getAttribute(GUARD_ATTR) || 0);
      return Date.now() - stamp < GUARD_MS;
    } catch (_) {
      return false;
    }
  };

  /* ==================== catalog owned pre-paint ==================== */
  function checkUrlForCatalogOwned(url) {
    try {
      const u = String(url || location.pathname);
      const match = u.match(/\/(?:catalog|bundles|items)\/(\d+)/i);
      if (!match) {
        // During Roblox SPA navigation the old catalog DOM can remain visible
        // briefly after the URL changes. Keep the owned suppression marker until
        // that DOM is actually gone so Buy / Add to Cart cannot flash back in.
        const catalogUiStillVisible = !!document.querySelector(
          '.item-details-thumbnail-container, .item-details-name-row, #item-info-container-frontend, .price-row-container'
        );
        if (!catalogUiStillVisible && document.documentElement && document.documentElement.hasAttribute('data-erx-owned')) {
          document.documentElement.removeAttribute('data-erx-owned');
        }
        return false;
      }
      const raw = localStorage.getItem('erx_purchased_items');
      const items = raw ? JSON.parse(raw) : [];
      if (Array.isArray(items) && items.map(String).includes(String(match[1]))) {
        if (document.documentElement) {
          document.documentElement.setAttribute('data-erx-owned', 'true');
        }
        return true;
      } else {
        if (document.documentElement && document.documentElement.hasAttribute('data-erx-owned')) {
          document.documentElement.removeAttribute('data-erx-owned');
        }
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  // Pre-paint check on document_start
  checkUrlForCatalogOwned(location.pathname);

  // SPA Navigation hooks in MAIN world to eliminate any 0.5s visual flash
  try {
    const origPushState = history.pushState;
    history.pushState = function (state, title, url) {
      if (url) checkUrlForCatalogOwned(url);
      const res = origPushState.apply(this, arguments);
      window.dispatchEvent(new CustomEvent('erx-nav-change', { detail: { url: String(url || location.pathname) } }));
      return res;
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function (state, title, url) {
      if (url) checkUrlForCatalogOwned(url);
      const res = origReplaceState.apply(this, arguments);
      window.dispatchEvent(new CustomEvent('erx-nav-change', { detail: { url: String(url || location.pathname) } }));
      return res;
    };

    window.addEventListener('popstate', () => {
      checkUrlForCatalogOwned(location.pathname);
      window.dispatchEvent(new CustomEvent('erx-nav-change', { detail: { url: location.pathname } }));
    }, true);

    document.addEventListener(
      'pointerdown',
      (e) => {
        const anchor = e.target instanceof Element ? e.target.closest('a[href], [data-item-id], [data-target-id]') : null;
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        const id = anchor.getAttribute('data-item-id') || anchor.getAttribute('data-target-id');
        if (href) checkUrlForCatalogOwned(href);
        else if (id) checkUrlForCatalogOwned('/catalog/' + id);
      },
      true
    );
  } catch (_) { /* noop */ }

  const isProfilePage = () => /^\/users\/\d+/i.test(location.pathname);

  const shouldBlock = (url) => {
    try {
      if (!PROTO.test(String(url))) return false;
      if (armed()) return true;
      // On user profile pages (/users/*), always block roblox-player launcher
      if (isProfilePage()) return true;
      return false;
    } catch (_) {
      return false;
    }
  };

  // Always arm guard if clicking any Send Robux / Send button (including 3-dots menu items) in MAIN world
  try {
    document.addEventListener(
      'pointerdown',
      (e) => {
        const btn = e.target instanceof Element ? e.target.closest(
          'button, a, [role="button"], [role="menuitem"], [role="option"], [data-radix-collection-item], [class*="menu-item"], [class*="dropdown-item"], li'
        ) : null;
        if (!btn) return;
        const id = (btn.id || '').toLowerCase();
        const testid = (btn.getAttribute('data-testid') || '').toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text = (btn.textContent || '').trim().toLowerCase();
        const href = (btn.getAttribute('href') || '').toLowerCase();

        if (text.includes('send message') || aria.includes('send message')) return;
        if (text.includes('send feedback') || aria.includes('send feedback')) return;
        if (text.includes('send request') || aria.includes('send request')) return;

        const sendLike =
          id === 'profile-send' ||
          id === 'hero-send-button' ||
          id.includes('send-robux') ||
          testid === 'profile-send' ||
          testid === 'send-robux' ||
          testid === 'profile-send-button' ||
          aria === 'send' ||
          aria === 'send robux' ||
          aria.includes('send robux') ||
          text === 'send' ||
          text === 'send robux' ||
          text.includes('send robux') ||
          /\bsend\b/i.test(text);

        const hasRecipient = !!btn.closest(
          '.send-robux-user-row, [role="option"], .user-card, [data-user-id], [data-testid="user-row"]'
        );
        const insideRecipientUi = !!btn.closest(
          '[role="dialog"], [role="menu"], [aria-modal="true"], [data-radix-popper-content-wrapper]'
        );

        // A top-level Send Robux action opens Roblox's player picker. Do not arm
        // the protocol guard until a player row (or a profile recipient) exists.
        if (sendLike && !isProfilePage() && !hasRecipient && !insideRecipientUi) return;

        if (
          id === 'profile-send' ||
          id === 'hero-send-button' ||
          id.includes('send-robux') ||
          testid === 'profile-send' ||
          testid === 'send-robux' ||
          testid === 'profile-send-button' ||
          aria === 'send' ||
          aria === 'send robux' ||
          aria.includes('send robux') ||
          text === 'send' ||
          text === 'send robux' ||
          text.includes('send robux') ||
          /\bsend\b/i.test(text) ||
          href.startsWith('roblox:') ||
          href.startsWith('roblox-player:')
        ) {
          document.documentElement.setAttribute(GUARD_ATTR, String(Date.now()));
        }
      },
      true
    );
  } catch (_) { /* noop */ }

  /* iframe.src = "roblox-player:..." (classic launcher technique) */
  try {
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get: srcDesc.get,
        set(value) {
          if (shouldBlock(value)) return;
          return srcDesc.set.call(this, value);
        },
      });
    }
  } catch (_) { /* noop */ }

  /* el.setAttribute('src' | 'href', "roblox:...") */
  try {
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const key = String(name).toLowerCase();
      if ((key === 'src' || key === 'href') && shouldBlock(value)) return;
      return originalSetAttribute.call(this, name, value);
    };
  } catch (_) { /* noop */ }

  /* window.open("roblox:...") */
  try {
    const originalOpen = window.open;
    window.open = function (url, ...rest) {
      if (shouldBlock(url)) return null;
      return originalOpen.call(this, url, ...rest);
    };
  } catch (_) { /* noop */ }

  /* anchor.click() on a roblox: link */
  try {
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (shouldBlock(this.href)) return;
      return originalAnchorClick.call(this);
    };
  } catch (_) { /* noop */ }

  /* location.assign / location.replace */
  try {
    const assign = Location.prototype.assign;
    const replace = Location.prototype.replace;
    Location.prototype.assign = function (url) {
      if (shouldBlock(url)) return;
      return assign.call(this, url);
    };
    Location.prototype.replace = function (url) {
      if (shouldBlock(url)) return;
      return replace.call(this, url);
    };
  } catch (_) { /* noop */ }

  /* location.href = "roblox:..." — Navigation API (Chromium) */
  try {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', (event) => {
        const dest = event.destination && event.destination.url;
        if (event.cancelable && shouldBlock(dest)) event.preventDefault();
      });
    }
  } catch (_) { /* noop */ }

  /* Last resort: an <a href="roblox:..."> click that slipped through. */
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      if (shouldBlock(anchor.getAttribute('href'))) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
})();
