 Parcel Screening — Config-Driven Data Layer

A jurisdiction-agnostic data layer for the preliminary-screening feature. You
give it an address or APN plus a `jurisdictionId`; it returns one normalized
result with parcel, zoning, flood, and seismic data plus a go / caution / no-go
verdict. Swapping cities or counties is a config edit in `jurisdictions.js`, not
a code change.

Currently configured: **San Jose, CA** (Path A). Shared statewide/national
layers (FEMA flood, CGS Alquist-Priolo fault) apply to any California
jurisdiction.

## Files

| File | Role |
|------|------|
| `jurisdictions.js` | Config registry: per-jurisdiction sources + field maps, shared layers, screening rules, normalized schema (JSDoc). **This is the file you edit most.** |
| `arcgis.js` | Generic ArcGIS REST client: resolve Hub items → service URLs, query by point/APN, reproject to WGS84. |
| `geocode.js` | Address → lat/lng via the free U.S. Census geocoder. |
| `screen.js` | Orchestrator: `screenParcel({address|apn, jurisdictionId})` → normalized result. |

## Using it from the MV3 service worker

```js
// background.js  (manifest: "background": { "service_worker": "background.js", "type": "module" })
import { screenParcel } from './data-layer/screen.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCREEN_PARCEL') {
    screenParcel(msg.payload).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
});
```
