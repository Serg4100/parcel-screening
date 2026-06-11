/**
 * content.js — Feature B (auto-detect).
 * -----------------------------------------------------------------------------
 * Runs ONLY on the Santa Clara County Assessor pages declared in
 * manifest.json -> content_scripts.matches. It scans the page's visible text
 * for an Assessor Parcel Number (APN) in the canonical NNN-NN-NNN form and, if
 * found, stages it for the side panel and shows a small "screen this" button.
 *
 * Design notes:
 *   - DOM-STRUCTURE-INDEPENDENT: we match the APN by text pattern, not by CSS
 *     selectors, so a site redesign won't break detection.
 *   - PRIVACY: nothing leaves the page except the APN string, and only to this
 *     extension's own service worker (chrome.runtime.sendMessage).
 *   - MV3 LIMIT: a content script can't open the side panel (that needs a user
 *     gesture inside the extension), so the button stages the APN and prompts
 *     the user to open the panel via the toolbar icon, which then auto-screens.
 * -----------------------------------------------------------------------------
 */

const APN_RE = /\b\d{3}-\d{2}-\d{3}\b/;
const BADGE_ID = 'parcel-screen-badge';

let lastApn = null;

function findApn() {
  const text = document.body ? document.body.innerText : '';
  const m = text.match(APN_RE);
  return m ? m[0] : null;
}

function send(apn) {
  try {
    chrome.runtime.sendMessage({ type: 'PARCEL_DETECTED', value: apn, mode: 'apn' });
  } catch (_) {
    // Extension context can be invalidated on reload; ignore.
  }
}

function label(apn) {
  return `\u25E7 Screen parcel \u00B7 ${apn}`;
}

function showBadge(apn) {
  let el = document.getElementById(BADGE_ID);
  if (!el) {
    el = document.createElement('button');
    el.id = BADGE_ID;
    el.type = 'button';
    el.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'padding:9px 13px', 'border:0', 'border-radius:8px', 'cursor:pointer',
      'background:#17191d', 'color:#f6f5f1',
      'font:600 13px/1.2 system-ui,-apple-system,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,.25)',
    ].join(';');
    el.addEventListener('click', () => {
      send(lastApn); // refresh the staged query (live-updates an open panel)
      el.textContent = 'Open the Parcel Screen icon \u25B8';
      setTimeout(() => { el.textContent = label(lastApn); }, 2500);
    });
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = label(apn);
}

function scan() {
  const apn = findApn();
  if (apn && apn !== lastApn) {
    lastApn = apn;
    send(apn);
    showBadge(apn);
  }
}

// Initial scan, then watch for SPA / async content changes (debounced).
scan();
if (document.body) {
  let t = null;
  const mo = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(scan, 500);
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}
