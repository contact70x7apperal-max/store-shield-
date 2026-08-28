/**
 * StoreShield storefront protection script.
 *
 * What this file actually does, in order:
 *   1. Fetches this shop's feature toggles from the app (via Shopify's App
 *      Proxy, so the request is same-origin and signature-verified).
 *   2. If bot protection is on: adds a honeypot field + render-timestamp to
 *      every form, and blocks submissions that trip either check.
 *   3. If rate limiting is on: asks the server whether this visitor's
 *      client id is over its submission quota before letting a form through.
 *   4. If CSP hardening is on: adds a best-effort <meta> CSP tag at runtime
 *      (see the README for why this is weaker than the head-embedded
 *      version, and how to add that instead).
 *   5. If the trust badge is on: renders a small, honestly-labeled badge.
 *
 * Nothing here claims to stop a determined, targeted attacker. It raises
 * the cost of casual scripted abuse (spam bots, naive scrapers) and adds
 * one real defense-in-depth layer (CSP). That's the whole scope.
 */
(function () {
  "use strict";

  var scriptTag = document.currentScript;
  var shop = scriptTag && scriptTag.getAttribute("data-shop");
  if (!shop) return;

  var PROXY_BASE = "/apps/store-shield";
  var CLIENT_ID_KEY = "store_shield_client_id";
  var MIN_HUMAN_FILL_TIME_MS = 1200;

  // ---- 1. A random, non-invasive client id (NOT a device fingerprint) ----
  // This is just a random UUID stored in localStorage so the server can
  // recognize "the same browser submitted N times", nothing about the
  // visitor's hardware or behavior is read to build it.
  function getClientId() {
    try {
      var id = localStorage.getItem(CLIENT_ID_KEY);
      if (!id) {
        id =
          "c_" +
          Date.now().toString(36) +
          "_" +
          Math.random().toString(36).slice(2, 12);
        localStorage.setItem(CLIENT_ID_KEY, id);
      }
      return id;
    } catch (e) {
      // Privacy mode / storage blocked: fall back to a per-page-load id.
      // Rate limiting degrades gracefully to "less effective", not broken.
      return "c_session_" + Math.random().toString(36).slice(2, 12);
    }
  }

  var clientId = getClientId();
  var hadPointerOrKeyActivity = false;
  window.addEventListener(
    "pointermove",
    function () {
      hadPointerOrKeyActivity = true;
    },
    { once: true, passive: true },
  );
  window.addEventListener(
    "keydown",
    function () {
      hadPointerOrKeyActivity = true;
    },
    { once: true },
  );

  function logEvent(eventType) {
    fetch(PROXY_BASE + "/events?shop=" + encodeURIComponent(shop), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: eventType, fingerprint: clientId }),
      keepalive: true,
    }).catch(function () {
      /* best-effort logging; never block the shopper on a network error */
    });
  }

  function checkRateLimit() {
    return fetch(PROXY_BASE + "/events?shop=" + encodeURIComponent(shop), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "form_submit", fingerprint: clientId }),
    })
      .then(function (r) {
        return r.ok ? r.json() : { overLimit: false };
      })
      .catch(function () {
        return { overLimit: false }; // fail open — never trap real shoppers offline
      });
  }

  function showBlockedMessage(form, text) {
    var el = form.querySelector("[data-store-shield-message]");
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-store-shield-message", "");
      el.setAttribute("role", "alert");
      el.style.cssText = "color:#8a1f11;font-size:0.875em;margin-top:0.5em;";
      form.appendChild(el);
    }
    el.textContent = text;
  }

  // ---- 2 & 3. Honeypot + timing + rate-limit gate on every form ----
  function instrumentForm(form) {
    if (form.dataset.storeShieldSkip !== undefined) return;
    if (form.dataset.storeShieldInstrumented) return;
    form.dataset.storeShieldInstrumented = "true";

    var renderedAt = Date.now();

    var honeypotName = "ss_hp_" + Math.random().toString(36).slice(2, 8);
    var honeypot = document.createElement("input");
    honeypot.type = "text";
    honeypot.name = honeypotName;
    honeypot.autocomplete = "off";
    honeypot.tabIndex = -1;
    honeypot.setAttribute("aria-hidden", "true");
    // Off-screen rather than display:none — some bots specifically skip
    // display:none fields, so this is a deliberately slightly-harder target.
    honeypot.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
    form.appendChild(honeypot);

    form.addEventListener("submit", function (event) {
      if (form.dataset.storeShieldBypass === "true") return; // programmatic re-submit below

      var settings = window.__storeShieldSettings || {};
      if (!settings.botProtectionEnabled && !settings.rateLimitEnabled) return;

      var isHoneypotFilled = honeypot.value.trim().length > 0;
      var fillTime = Date.now() - renderedAt;
      var tooFast = fillTime < MIN_HUMAN_FILL_TIME_MS && !hadPointerOrKeyActivity;
      var webdriverFlag = !!navigator.webdriver;

      if (settings.botProtectionEnabled && isHoneypotFilled) {
        event.preventDefault();
        logEvent("honeypot_triggered");
        showBlockedMessage(form, "Submission blocked. Please try again.");
        return;
      }

      if (settings.botProtectionEnabled && (tooFast || webdriverFlag)) {
        event.preventDefault();
        logEvent("bot_suspected");
        showBlockedMessage(form, "Submission blocked. Please try again.");
        return;
      }

      if (settings.rateLimitEnabled) {
        event.preventDefault();
        checkRateLimit().then(function (result) {
          if (result.overLimit) {
            showBlockedMessage(
              form,
              "You've submitted this a few times already — please wait a bit before trying again.",
            );
            return;
          }
          form.dataset.storeShieldBypass = "true";
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.submit();
          }
        });
        return;
      }

      logEvent("form_submit");
    });
  }

  function instrumentAllForms() {
    document.querySelectorAll("form").forEach(instrumentForm);
  }

  // ---- 4. Best-effort runtime CSP meta tag ----
  function applyCspIfEnabled(settings) {
    if (!settings.cspHardeningEnabled) return;
    if (document.querySelector('meta[http-equiv="Content-Security-Policy"]')) {
      return; // merchant already pasted the head snippet — don't double up
    }
    var domains = (settings.cspAllowedDomains || []).join(" ");
    var meta = document.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute(
      "content",
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.shopify.com " +
        domains +
        "; object-src 'none'; base-uri 'self';",
    );
    document.head.appendChild(meta);
    console.info(
      "[StoreShield] Added a runtime CSP meta tag. This only protects scripts " +
        "loaded after this point — for full-page coverage, paste the snippet " +
        "from the StoreShield settings page into theme.liquid's <head>.",
    );
  }

  // ---- 5. Trust badge (explicitly cosmetic) ----
  function renderTrustBadgeIfEnabled(settings) {
    if (!settings.trustBadgeEnabled) return;
    var badge = document.createElement("div");
    badge.setAttribute("data-store-shield-badge", "");
    badge.title = "Trust indicator, not a security guarantee.";
    badge.style.cssText =
      "display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#4a5568;margin-top:8px;";
    badge.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z" fill="#2f855a"/></svg>' +
      "<span>Protected by StoreShield</span>";
    var checkoutBtn = document.querySelector(
      '[name="checkout"], .shopify-payment-button, [data-shopify="payment-button"]',
    );
    if (checkoutBtn && checkoutBtn.parentNode) {
      checkoutBtn.parentNode.appendChild(badge);
    }
  }

  fetch(PROXY_BASE + "/settings?shop=" + encodeURIComponent(shop))
    .then(function (r) {
      return r.ok ? r.json() : {};
    })
    .catch(function () {
      return {};
    })
    .then(function (settings) {
      window.__storeShieldSettings = settings;
      applyCspIfEnabled(settings);
      renderTrustBadgeIfEnabled(settings);
      instrumentAllForms();

      // Re-scan for forms that get injected later (e.g. a quick-view modal
      // or an app-added newsletter popup rendered after our first pass).
      var observer = new MutationObserver(function () {
        instrumentAllForms();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
})();
