# Privacy Policy — Parcel Screen

**Effective date:** [EFFECTIVE_DATE]
**Publisher:** [DEVELOPER_NAME]
**Contact:** [CONTACT_EMAIL]

Parcel Screen ("the Extension") is a Chrome browser extension that performs
preliminary buildability screening of parcels in San José, California. This
policy explains exactly what data the Extension handles, where it goes, and what
it does not do. It is written to match the Extension's actual behavior.

---

## 1. Summary

- The Extension has **no server of its own.** All processing runs locally in your
  browser. The publisher operates no backend, collects nothing about you, and
  receives none of your data.
- The Extension has **no analytics, no accounts, no advertising, no cookies, and
  no tracking.** It does not sell or share data with anyone.
- The only data that leaves your device is the **address or parcel number (APN)
  you choose to screen**, sent to public **government mapping services** so the
  Extension can look up that parcel. The publisher is not one of those services
  and cannot see those requests.

---

## 2. What the Extension processes

The Extension only ever works with information you provide or select:

- An **address** you type into the side panel.
- An **APN** (Assessor Parcel Number) you type, select, or that the Extension
  detects on a Santa Clara County Assessor web page (see Section 4).
- The **geographic coordinates** and parcel data derived from the above by the
  government services in Section 3.

The Extension does **not** collect your name, email, account credentials,
browsing history, or any data from web pages other than the assessor pages
described in Section 4.

---

## 3. Data sent to third-party government services

To screen a parcel, the Extension sends the address or APN (or coordinates
derived from an address) to the following public services. These requests are
made directly from your browser to each service; the publisher does not
intermediate, log, or store them.

| Service | What is sent | Purpose |
|---|---|---|
| U.S. Census Bureau Geocoder (`geocoding.geo.census.gov`) | the address you entered | convert an address to coordinates. **Not contacted when you screen by APN.** |
| City of San José GIS (`geo.sanjoseca.gov`) | coordinates or APN | retrieve parcel boundary, zoning, flood, seismic, geologic, slope, soil, water-provider, and vacant-land data |
| FEMA National Flood Hazard Layer (`hazards.fema.gov`) | coordinates | retrieve federal flood-zone data (used as a fallback/shared source) |
| California Geological Survey (`gis.conservation.ca.gov`) | coordinates | retrieve fault-zone data (used as a fallback) |
| Santa Clara County Airport Land Use GIS (`services2.arcgis.com` — County of Santa Clara service hosted on Esri's ArcGIS Online platform) | coordinates | retrieve airport influence area data (building-height / land-use compatibility review zones) |
These are independent third parties with their own privacy practices, over which
the publisher has no control. The Extension only contacts the hosts declared in
its manifest (the five above); it does not transmit your data to any other
destination.

---

## 4. Behavior on Santa Clara County Assessor pages

The Extension includes a content script that runs **only** on the following
sites, as declared in its manifest:

- `https://www.sccassessor.org/*`
- `https://asr.santaclaracounty.gov/*`

On those pages it scans the page's visible text for an APN in the standard
`NNN-NN-NNN` format. If one is found, it offers a button to screen that parcel.

- The **only** information that leaves the page is the matched **APN string**,
  and it is sent **only to the Extension's own internal service worker** within
  your browser — not to the publisher or any external server.
- The script does **not** read login information, form fields, cookies, or any
  page content other than the visible text needed to find the APN, and it does
  **not** transmit page contents anywhere.

---

## 5. Local storage on your device

The Extension uses Chrome's local storage (`chrome.storage.local`), which stays
on your device:

- **Cached screening results** are stored for up to 24 hours so repeat lookups
  are fast and the public services are not queried unnecessarily.
- A **pending query** (the last address/APN you chose to screen) is stored briefly
  so the side panel can pick it up when opened.

This data never leaves your device, is not uploaded anywhere, and is removed when
you uninstall the Extension or clear the Extension's data.

---

## 6. Permissions and why they are used

- **`storage`** — local caching and the pending-query handoff described in
  Section 5.
- **`sidePanel`** — displays the screening results panel.
- **`contextMenus`** — adds a right-click "Screen parcel" option so you can
  screen selected text (an address or APN). The selected text is then processed
  exactly as described in Sections 2 and 3.
- **Host permissions** for the four government services in Section 3 — required
  so the Extension can query those services on your behalf.
- **Content scripts** on the two assessor sites in Section 4 — required only for
  APN auto-detection on those pages.

---

## 7. Data sharing and sale

The publisher does not collect your data and therefore does not sell, rent,
trade, or share it. The Extension contains no advertising or third-party tracking
of any kind. The government services in Section 3 receive only the parcel lookup
information necessary to return results, and handle it under their own policies.

---

## 8. Children's privacy

The Extension is a professional/real-estate tool and is not directed to children
under 13, and does not knowingly collect information from children.

---

## 9. Security

Because the Extension stores no personal data on any server and operates no
backend, there is no central repository of user data to be breached. Lookup
requests to the government services are made over HTTPS.

---

## 10. Changes to this policy

This policy may be updated to reflect changes to the Extension. Material changes
will be reflected by updating the effective date above and, where appropriate,
the Extension's listing. Continued use after an update constitutes acceptance of
the revised policy.

---

## 11. Contact

Questions about this policy can be directed to **[CONTACT_EMAIL]**.

---

## Appendix — Chrome Web Store data-disclosure mapping (for the publisher)

This appendix is guidance for completing the Web Store "Privacy practices" form;
it is not part of the user-facing policy.

- **Does this item collect or use the user's data?** The form's definition of
  "collect" includes transmitting data off the user's device. Because the
  address/APN is transmitted to third-party services, select **Yes** and disclose:
  - *Location* — parcel address/coordinates are processed and transmitted.
  - *Personally identifiable information* — only if a screened address could
    identify the user (disclose conservatively as "Personally identifiable
    information → address" to be safe).
- **Website content** — disclose the assessor-page APN read (Section 4), framed as
  reading limited page text to detect a parcel number.
- **Required certifications** (all should be truthful as **Yes** for this build):
  - Data is **not** sold or transferred to third parties beyond the disclosed
    use (the government lookups are the disclosed use).
  - Data is **not** used or transferred for purposes unrelated to the item's
    single purpose.
  - Data is **not** used or transferred to determine creditworthiness or for
    lending.
- Provide the hosted URL of this policy in the listing's **Privacy policy** field.

---

*This Extension provides preliminary screening only and is not a substitute for a
survey, title report, geotechnical or Phase I environmental assessment, or a
determination by a planning department or licensed professional. See the
in-application disclaimer and Terms of Service.*
