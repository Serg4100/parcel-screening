/**
 * background.js — MV3 service worker (module).
 * -----------------------------------------------------------------------------
 * The ONLY place network calls happen. Content scripts and the side panel
 * inherit the page's CORS context and would be blocked; the worker, with the
 * host_permissions declared in manifest.json, can fetch the GIS services.
 *
 * Responsibilities:
 *   - open the side panel when the toolbar icon is clicked
 *   - answer SCREEN_PARCEL messages by running screenParcel(), with a simple
 *     time-boxed cache in chrome.storage.local so repeat lookups are instant
 *     and we don't hammer the public services.
 * -----------------------------------------------------------------------------
 */

import { screenParcel } from './data-layer/screen.js';

const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h — GIS data changes slowly
const CACHE_PREFIX = 'screen:';
// Bump this whenever the ScreenResult shape changes (new fields like area,
// buildable, slope/soil, future local layers). Old cache entries key off the
// previous version string and are simply never matched, so a schema change can
// never serve a stale result that's missing the new fields.
const SCHEMA_VERSION = 'v9';

/** Open the side panel from the toolbar icon. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('setPanelBehavior failed:', e));

  // Feature A: right-click a selected address/APN on any page -> screen it.
  chrome.contextMenus.create(
    { id: 'ps-screen-selection', title: 'Screen parcel: "%s"', contexts: ['selection'] },
    () => void chrome.runtime.lastError // ignore "duplicate id" on re-install
  );
});

/* Pending-query plumbing -------------------------------------------------------
 * Both the context menu (A) and the assessor-page content script (B) stage a
 * query here; the side panel consumes it on open (or live, if already open).
 */
const PENDING_KEY = 'pendingQuery';
const APN_RE = /\d{3}-\d{2}-\d{3}/;

function stagePending(value, mode) {
  const v = String(value || '').trim();
  if (!v) return Promise.resolve();
  const finalMode = mode || (APN_RE.test(v) ? 'apn' : 'address');
  return chrome.storage.local.set({
    [PENDING_KEY]: { value: v, mode: finalMode, jurisdictionId: 'san-jose', t: Date.now() },
  });
}

// A: context-menu click is a user gesture, so we may open the panel directly.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ps-screen-selection') return;
  await stagePending(info.selectionText);
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn('sidePanel.open failed:', e);
  }
});

// B: the content script reports a detected APN. We can't open the panel from
// here (MV3 requires a user gesture), so we stage it and badge the icon; the
// user opens the panel with one click and it auto-screens.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type !== 'PARCEL_DETECTED') return;
  stagePending(msg.value, msg.mode);
  if (sender.tab?.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: '•' });
    chrome.action.setBadgeBackgroundColor({ color: '#2f6f6b' });
  }
});

/** Stable cache key for a given query. */
function cacheKey({ address, apn, jurisdictionId }) {
  const id = (apn || address || '').trim().toLowerCase();
  return `${CACHE_PREFIX}${SCHEMA_VERSION}|${jurisdictionId}|${id}`;
}

async function getCached(key) {
  try {
    const obj = await chrome.storage.local.get(key);
    const entry = obj[key];
    if (entry && Date.now() - entry.t < CACHE_TTL_MS) return entry.v;
  } catch (e) {
    console.warn('cache read failed:', e);
  }
  return null;
}

async function setCached(key, value) {
  try {
    await chrome.storage.local.set({ [key]: { t: Date.now(), v: value } });
  } catch (e) {
    console.warn('cache write failed:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type !== 'SCREEN_PARCEL') return; // not ours

  (async () => {
    const payload = msg.payload || {};
    const key = cacheKey(payload);

    if (!msg.bustCache) {
      const cached = await getCached(key);
      if (cached) {
        sendResponse({ ok: true, cached: true, result: cached });
        return;
      }
    }

    try {
      const result = await screenParcel(payload);
      await setCached(key, result);
      sendResponse({ ok: true, cached: false, result });
    } catch (e) {
      // screenParcel is designed not to throw, but guard anyway.
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // keep the message channel open for the async response
});
