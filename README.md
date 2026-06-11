# Parcel Screening — Config-Driven Data Layer

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

Network calls run **in the service worker**, not the content script — content
scripts inherit the page's CORS context and will be blocked.

### Required `manifest.json` host permissions

```json
"host_permissions": [
  "https://www.arcgis.com/*",
  "https://services*.arcgis.com/*",
  "https://gis.conservation.ca.gov/*",
  "https://hazards.fema.gov/*",
  "https://geocoding.geo.census.gov/*",
  "https://*.sanjoseca.gov/*"
]
```

(`geo.sanjoseca.gov` is San Jose's confirmed host. `www.arcgis.com` is only
needed if you later add an ArcGIS Online-hosted jurisdiction via
`kind: 'arcgis-item'`. Keep the list as narrow as you can — broad permissions
get extra Web Store review.)

## Confirmed San Jose endpoints (validated live)

All San Jose planning layers are served from one MapServer:
`https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer`

| Layer | ID | Key field |
|-------|----|-----------|
| Parcels | 49 | `APN` (no area attribute — area is geometry-derived) |
| Zonings (Since 2000) | 129 | `NEWZONING` (e.g. `R-M`, `CG`, `LI`) |
| Site Address Points | 131 | `FullAddress` + `APN` (primary parcel resolver) |

Native SR is 2227 (State Plane CA III, US feet); the client requests
`outSR=4326`, so results come back as lat/lng.

> Why the earlier `www.arcgis.com/sharing/...` call failed: those items are on
> San Jose's own **Enterprise** server, not ArcGIS **Online**, so the public
> Online sharing API can't see them. The config now points at the city server
> directly (`kind: 'arcgis-service'`), removing the resolution step entirely.

### Bonus: San Jose-local layers (same service) — your civil-engineering roadmap

The city pre-localizes layers you'd otherwise stitch from many sources, all in
the service above: Flood Hazard Area (170), Seismic Hazard Zone (81), Geologic
Hazard Zone (27), **Slope Over 15% (151)**, **Soil Type (83)**, Vacant Land
Inventory (124), Water Service Provider (125), Sanitary Mains (69), Storm Drain
System (86), Site Address Points (131). These are listed in the San Jose
`localLayers` config block — wire them in as jurisdiction overrides for higher
fidelity than the statewide shared layers.

## Still to verify (only the shared layers remain)

- **FEMA flood** — CONFIRMED: layer 28 ("Flood Hazard Zones") with `FLD_ZONE` /
  `SFHA_TF` / `ZONE_SUBTY` on service
  `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`.
  (San Jose's local flood layer 170 is a ready alternative if you prefer.)
- **CGS fault** service responds at the URL in config; a parcel intersecting a
  feature == in an Alquist-Priolo zone.

## Validating any future endpoint

When you add another jurisdiction, confirm each value like this:

1. **Service + layer:** open `<serviceUrl>?f=json` and read the `layers` array;
   match parcels / zoning by name to get the `layerId`.
2. **Fields:** open `<serviceUrl>/<layerId>?f=json` and read `fields` for the
   real APN / zoning-code attribute names; update `fieldMap`.
3. **Smoke test:** open
   `<serviceUrl>/<layerId>/query?where=1=1&resultRecordCount=1&outFields=*&f=json`
   and check the attributes look right.

## Adding a new jurisdiction

1. Copy the commented template at the bottom of `JURISDICTIONS` in
   `jurisdictions.js`, rename the key (e.g. `'sunnyvale'`).
2. Fill the `parcel` and `zoning` `source` blocks (item id or direct service
   URL + layer index) and their `fieldMap`s.
3. Validate with the steps above. No other file changes needed — `screen.js`
   and `arcgis.js` are jurisdiction-agnostic.

Because you're in Alameda County but targeting San Jose, this is also how you'd
add an Alameda entry to demo locally: same code path, different config.

## Known constraints (recap)

- Public GIS services are provided "as is," may rate-limit, and occasionally
  change layer indices/URLs. Cache results in `chrome.storage` and consider a
  short debounce.
- Coordinate systems differ per service; the client requests `outSR=4326` so
  the app speaks lat/lng throughout. Parcel `areaSqft` units depend on the
  source projection — verify.
- A failed layer degrades that field to `null` and is recorded in
  `result.errors`; the rest of the screen still returns.
- The verdict logic in `SCREENING_RULES` is intentionally simple and explicit —
  tune the rules to your risk tolerance; it's config, not buried code.
