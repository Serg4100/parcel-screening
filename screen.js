/**
 * screen.js
 * -----------------------------------------------------------------------------
 * The orchestrator. Given an address OR an APN plus a jurisdictionId, it:
 *   1. resolves the parcel location (geocode address, or APN attribute query)
 *   2. queries the parcel layer (base data + geometry)
 *   3. queries zoning (jurisdiction-specific)
 *   4. queries shared layers (FEMA flood, CGS fault)
 *   5. normalizes everything to one schema and computes a verdict
 *
 * Every layer is wrapped so a single failed service degrades that field to null
 * and records an error, rather than failing the whole screen. This matters:
 * public GIS endpoints go down or change, and a partial result is still useful.
 *
 * Call this from the MV3 service worker. Returns a ScreenResult (see
 * jurisdictions.js for the typedef).
 * -----------------------------------------------------------------------------
 */

import {
  getJurisdiction,
  SHARED_LAYERS,
  SCREENING_RULES,
} from './jurisdictions.js';
import {
  queryByPoint,
  queryByPointBuffered,
  queryByApn,
  intersectsPoint,
  ringCentroid,
  polygonAreaSqFt,
} from './arcgis.js';
import { geocodeAddress } from './geocode.js';

/** Run an async step, capturing failure into `errors` instead of throwing. */
async function safe(label, fn, errors) {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    return null;
  }
}

/** Map raw attributes through a fieldMap into a flat normalized object. */
function applyFieldMap(raw, fieldMap) {
  const out = {};
  if (!raw) return out;
  for (const [normalizedKey, rawKey] of Object.entries(fieldMap)) {
    out[normalizedKey] = raw[rawKey] ?? null;
  }
  return out;
}

/**
 * Match a zoning code to a development-standards entry. Tries an exact match,
 * then strips overlay/parenthetical suffixes (e.g. "R-1-8(PD)" -> "R-1-8").
 */
function matchStandards(table, code) {
  if (!table || !code) return { std: null, overlay: null };
  if (table[code]) return { std: table[code], overlay: null };
  const m = String(code).match(/^(.*?)\s*(\([^)]*\))\s*$/);
  const base = (m ? m[1] : String(code)).trim();
  return { std: table[base] || null, overlay: m ? m[2] : null };
}

/**
 * Resolve an address (or APN) to a single parcel feature, layered best-first.
 * The contract: never silently guess. Each tier reports HOW it resolved via
 * `method`, and the buffer tier refuses to pick when >1 parcel is in range —
 * it returns candidates for the caller to surface instead.
 *
 * Tiers:
 *   apn         — direct attribute query (most reliable when user has the APN)
 *   point       — geocode -> exact point-in-polygon against the parcel layer
 *   buffer      — geocode -> small buffer; ONLY if exactly one parcel in range
 *   ambiguous   — buffer found several; caller asks the user to choose
 *   none        — nothing matched
 *
 * NOTE: an address-point layer (e.g. SJ 131) is NOT usable here — it holds
 * near-zero-area POINTS, so a point-intersect almost never matches. The parcel
 * POLYGON layer is the right target; a small buffer recovers points that the
 * free geocoder drops into the street right-of-way.
 *
 * @returns {Promise<{
 *   feature: object|null,
 *   location: {lat:number,lng:number}|null,
 *   method: 'apn'|'point'|'buffer'|'ambiguous'|'none',
 *   candidates?: Array<{apn:string|null, geometry:object|null}>,
 *   note?: string,
 * }>}
 */
async function resolveParcel({ address, apn, jur, errors }) {
  const parcelSrc = jur.parcel.source;
  const apnField = jur.parcel.fieldMap.apn;
  const resolver = jur.resolver || {};

  // Tier 0: APN supplied directly.
  if (apn) {
    const f = await safe(
      'resolve-apn',
      () => queryByApn(parcelSrc, apnField, apn),
      errors
    );
    if (f) return { feature: f, location: ringCentroid(f.geometry), method: 'apn' };
  }

  if (!address) {
    return { feature: null, location: null, method: 'none' };
  }

  // Need a geocoded point for the remaining tiers.
  const geo = await safe('geocode', () => geocodeAddress(address), errors);
  if (!geo) return { feature: null, location: null, method: 'none' };
  const location = { lat: geo.lat, lng: geo.lng };

  // Tier 1: exact point-in-polygon against the parcel layer.
  const exact = await safe(
    'resolve-point',
    () => queryByPoint(parcelSrc, location.lng, location.lat),
    errors
  );
  if (exact) return { feature: exact, location, method: 'point' };

  // Tier 2: small buffer — disambiguate, do not guess. The free geocoder often
  // lands in the street right-of-way a few feet off the parcel edge.
  const bufferFeet = resolver.bufferFeet ?? 60;
  const near = await safe(
    'resolve-buffer',
    () => queryByPointBuffered(parcelSrc, location.lng, location.lat, bufferFeet),
    errors
  );
  if (near && near.length === 1) {
    return {
      feature: near[0],
      location,
      method: 'buffer',
      note: `Address fell just outside a parcel; resolved to the single parcel within ${bufferFeet} ft. Confirm this is correct.`,
    };
  }
  if (near && near.length > 1) {
    const cap = resolver.maxCandidates ?? 5;
    const candidates = near.slice(0, cap).map((f) => ({
      apn: applyFieldMap(f.attributes, jur.parcel.fieldMap).apn ?? null,
      geometry: f.geometry ?? null,
    }));
    return {
      feature: null,
      location,
      method: 'ambiguous',
      candidates,
      note: `Address fell between ${near.length} parcels within ${bufferFeet} ft. Pick the intended parcel.`,
    };
  }

  return { feature: null, location, method: 'none' };
}

/**
 * @param {{address?:string, apn?:string, jurisdictionId:string}} input
 * @returns {Promise<import('./jurisdictions.js').ScreenResult>}
 */
export async function screenParcel({ address, apn, jurisdictionId }) {
  const errors = [];
  const jur = getJurisdiction(jurisdictionId);

  /** @type {import('./jurisdictions.js').ScreenResult} */
  const result = {
    query: { input: apn || address || '', jurisdictionId },
    location: null,
    parcel: { apn: null, areaSqft: null, geometry: null, raw: null },
    parcelResolution: { method: 'none', note: null, candidates: null },
    zoning: { code: null, description: null, raw: null },
    flood: { zone: null, sfha: null, floodway: null, bfe: null, raw: null },
    seismic: { inFaultZone: null, hazardType: null, raw: null },
    slope: { overThreshold: null, value: null, raw: null },
    soil: { type: null, raw: null },
    geologic: { inHazardZone: null, hazardType: null, raw: null },
    water: { provider: null, raw: null },
    vacant: { inInventory: null, gpDesignation: null, landClass: null, areaAcres: null, planningArea: null, raw: null },
    airport: { inInfluenceArea: null, heightLimitFt: null, surface: null, raw: null },
    buildable: { minLotSqft: null, belowMinLot: null, setbacks: null, maxHeightFt: null, farThreshold: null, estMaxFloorAreaSqft: null, farBasis: null, note: null },
    flags: [],
    verdict: 'unknown',
    errors,
  };

  // --- 1 & 2. Resolve parcel + location -------------------------------------
  const resolution = await resolveParcel({ address, apn, jur, errors });
  result.location = resolution.location;
  result.parcelResolution = {
    method: resolution.method,
    note: resolution.note ?? null,
    candidates: resolution.candidates ?? null,
  };

  // Ambiguous: buffer found several parcels. Surface them; don't guess, don't
  // run hazard layers against a coin-flip parcel. Caller asks the user to pick.
  if (resolution.method === 'ambiguous') {
    result.flags.push('Address is between multiple parcels — selection required');
    result.verdict = 'unknown';
    return result;
  }

  if (!result.location) {
    errors.push('Could not resolve a location from the provided input.');
    return result; // nothing downstream can run without a point
  }

  // Geocoded fine, but neither the exact point nor the buffer hit a parcel — the
  // free geocoder commonly lands in a street right-of-way or off the parcel grid.
  // Say so explicitly instead of leaving APN / zoning / buildability silently
  // blank; hazard layers below still run on the point.
  if (resolution.method === 'none') {
    const bufferFeet = (jur.resolver && jur.resolver.bufferFeet) || 60;
    errors.push(
      `No parcel found at the geocoded point (nothing within ${bufferFeet} ft). ` +
        `The address likely resolved to a street right-of-way or a spot off the parcel ` +
        `grid, so parcel, zoning, and buildability can't be derived from it — ` +
        `try screening by APN instead.`
    );
  }

  const { lng, lat } = result.location;
  const parcelFeature = resolution.feature;

  if (parcelFeature) {
    const mapped = applyFieldMap(parcelFeature.attributes, jur.parcel.fieldMap);
    result.parcel = {
      apn: mapped.apn ?? apn ?? null,
      areaSqft: mapped.areaSqft ?? null,
      geometry: parcelFeature.geometry ?? null,
      raw: parcelFeature.attributes ?? null,
    };
  }

  // --- 2b. Parcel area -------------------------------------------------------
  // Layer 49 carries no area attribute, so area is geometry-derived. The main
  // flow speaks 4326 (degrees), which can't be area-measured, so we re-fetch
  // this ONE parcel in a planar SR (2227, US feet) and run the shoelace.
  // Prefer the APN selector (exact); fall back to a point query when needed.
  if (result.parcel.areaSqft == null && (result.parcel.apn || result.location)) {
    const areaFeat = await safe(
      'parcel-area',
      () =>
        result.parcel.apn
          ? queryByApn(jur.parcel.source, jur.parcel.fieldMap.apn, result.parcel.apn, { outSR: 2227 })
          : queryByPoint(jur.parcel.source, lng, lat, { outSR: 2227 }),
      errors
    );
    const sqft = areaFeat ? polygonAreaSqFt(areaFeat.geometry) : null;
    if (sqft) result.parcel.areaSqft = Math.round(sqft);
  }

  // --- 3. Zoning -------------------------------------------------------------
  const zoningFeature = await safe(
    'zoning',
    () => queryByPoint(jur.zoning.source, lng, lat),
    errors
  );
  if (zoningFeature) {
    const mapped = applyFieldMap(zoningFeature.attributes, jur.zoning.fieldMap);
    const labels = jur.zoning.labels || {};
    result.zoning = {
      code: mapped.code ?? null,
      description: mapped.description ?? labels[mapped.code]
        ?? labels[String(mapped.code).replace(/\s*\(.*$/, '').trim()] ?? null,
      raw: zoningFeature.attributes ?? null,
    };
  }

  // --- 4. Flood (local-first, attribute) ------------------------------------
  // Default source is the shared FEMA NFHL (works for any CA jurisdiction). A
  // jurisdiction may override with its own copy: San Jose's layer 170 is the
  // SAME FEMA DFIRM (06085C) on the city's reliable host and additionally
  // carries a base-flood-elevation field. The fieldMap travels with the source,
  // so the normalization below is field-name-independent. We normalize a
  // `floodway` boolean here (rather than letting the screening rule reach into
  // raw with a hardcoded field name) so the no-go floodway rule works for ANY
  // source. -9999 / blank BFE are NoData sentinels → null.
  const floodCfg = jur.flood?.source ? jur.flood : SHARED_LAYERS.flood;
  const floodFeature = await safe(
    'flood',
    () => queryByPoint(floodCfg.source, lng, lat),
    errors
  );
  if (floodFeature) {
    const fm = floodCfg.fieldMap;
    const a = floodFeature.attributes;
    const subty = fm.floodway ? String(a[fm.floodway] ?? '') : '';
    const bfeNum = fm.bfe ? Number(a[fm.bfe]) : NaN;
    result.flood = {
      zone: a[fm.zone] ?? null,
      sfha: a[fm.sfha] === 'T' ? true : a[fm.sfha] === 'F' ? false : null,
      floodway: /floodway/i.test(subty),
      bfe: Number.isFinite(bfeNum) && bfeNum > 0 ? bfeNum : null,
      raw: a,
    };
  } else if (!errors.some((e) => e.startsWith('flood'))) {
    // No intersecting flood polygon usually means "outside mapped SFHA".
    result.flood = { zone: 'X (unmapped/none)', sfha: false, floodway: false, bfe: null, raw: null };
  }

  // --- 4a. Seismic ----------------------------------------------------------

  // Seismic: prefer the jurisdiction's LOCAL hazard layer (reliable + carries a
  // hazard type). Fall back to the shared CGS fault layer only if no local one
  // is configured. CGS is frequently "not started", so local-first is also more
  // robust.
  if (jur.seismic?.source) {
    const sf = await safe(
      'seismic',
      () => queryByPoint(jur.seismic.source, lng, lat),
      errors
    );
    if (sf) {
      const htField = jur.seismic.fieldMap?.hazardType;
      result.seismic = {
        inFaultZone: true, // an intersecting hazard polygon == in a zone
        hazardType: (htField && sf.attributes?.[htField]) || null,
        raw: sf.attributes ?? null,
      };
    } else if (!errors.some((e) => e.startsWith('seismic'))) {
      // Clean miss == not in a mapped hazard zone.
      result.seismic = { inFaultZone: false, hazardType: null, raw: null };
    }
  } else {
    const fault = await safe(
      'seismic-fault',
      () => intersectsPoint(SHARED_LAYERS.seismicFault.source, lng, lat),
      errors
    );
    if (fault) {
      result.seismic = {
        inFaultZone: fault.hit,
        hazardType: null,
        raw: fault.feature?.attributes ?? null,
      };
    }
  }

  // --- 4b. Slope (local-first, presence-based) ------------------------------
  // Layer 151 "Slope Over 15%" is thematic: a feature exists only where slope
  // exceeds the threshold, so an intersecting polygon == steep. No field name is
  // required for the verdict; the optional value field only adds a display band.
  if (jur.slope?.source) {
    const sl = await safe(
      'slope',
      () => queryByPoint(jur.slope.source, lng, lat),
      errors
    );
    if (sl) {
      const vField = jur.slope.fieldMap?.value;
      result.slope = {
        overThreshold: true,
        value: (vField && sl.attributes?.[vField]) ?? null,
        raw: sl.attributes ?? null,
      };
    } else if (!errors.some((e) => e.startsWith('slope'))) {
      // Clean miss == not in a mapped >15% slope area.
      result.slope = { overThreshold: false, value: null, raw: null };
    }
  }

  // --- 4c. Soil (local-first, type-capturing) -------------------------------
  // Layer 83 "Soil Type" is NOT presence-based — the signal is the type value.
  // We capture the mapped type via fieldMap.type and ALWAYS keep raw attributes
  // so the value is recoverable even if the field name is still being confirmed.
  if (jur.soil?.source) {
    const so = await safe(
      'soil',
      () => queryByPoint(jur.soil.source, lng, lat),
      errors
    );
    if (so) {
      const tField = jur.soil.fieldMap?.type;
      result.soil = {
        type: (tField && so.attributes?.[tField]) ?? null,
        raw: so.attributes ?? null,
      };
    }
  }

  // --- 4d. Geologic hazard (local-first, presence-based) --------------------
  // Layer 27 "Geologic Hazard Zone" — distinct from seismic (81). An intersecting
  // polygon == in a mapped geologic hazard zone. Presence drives the flag; the
  // optional hazard-type field adds detail when configured.
  if (jur.geologic?.source) {
    const gh = await safe(
      'geologic',
      () => queryByPoint(jur.geologic.source, lng, lat),
      errors
    );
    if (gh) {
      const htField = jur.geologic.fieldMap?.hazardType;
      result.geologic = {
        inHazardZone: true,
        hazardType: (htField && gh.attributes?.[htField]) || null,
        raw: gh.attributes ?? null,
      };
    } else if (!errors.some((e) => e.startsWith('geologic'))) {
      result.geologic = { inHazardZone: false, hazardType: null, raw: null };
    }
  }

  // --- 4e. Buildability ------------------------------------------------------
  // Combine zoning standards (SJMC §20.30.200) with the derived lot area.
  // SJ has no lot-coverage %, so the buildable SIZE signal is FAR-based for
  // single-family (estimated max floor area before discretionary review), and
  // a minimum-lot-area developability check for all residential districts.
  const { std, overlay } = matchStandards(jur.developmentStandards, result.zoning.code);
  if (overlay) {
    const isPD = overlay.toUpperCase().includes('PD');
    const baseLabel = (jur.zoning.labels || {})[
      String(result.zoning.code).replace(/\s*\(.*$/, '').trim()
    ] || null;
    result.buildable = {
      minLotSqft: null, belowMinLot: null, setbacks: null, maxHeightFt: null,
      farThreshold: null, estMaxFloorAreaSqft: null,
      farBasis: 'Overlay — standards per permit',
      note: `${isPD ? 'Planned Development (PD)' : overlay + ' overlay'} rezoning. ` +
        `Development standards are set by the ${isPD ? 'PD' : 'overlay'} permit and its ` +
        `conditions of approval — not the base ${baseLabel || 'district'} zoning — and can't ` +
        `be derived from the zoning code. Verify the governing standards with the City of San José.`,
    };
  } else if (std) {
    const area = result.parcel.areaSqft;
    const below = area != null ? area < std.minLotSqft : null;
    const estFloor =
      std.farThreshold && area != null ? Math.round(area * std.farThreshold) : null;
    result.buildable = {
      minLotSqft: std.minLotSqft ?? null,
      belowMinLot: below,
      setbacks: std.setbacks ?? null,
      maxHeightFt: std.maxHeightFt ?? null,
      farThreshold: std.farThreshold ?? null,
      estMaxFloorAreaSqft: estFloor,
      farBasis: std.farBasis ?? null,
      note: std.note ?? null,
    };
  }

  // --- 4f. Water service provider (local, attribute) -------------------------
  // Layer 125 "Water Service Provider": every parcel sits inside a provider's
  // service-area polygon, so the signal is the NAME attribute, not presence.
  // Informational only — no verdict rule attached.
  if (jur.water?.source) {
    const w = await safe(
      'water',
      () => queryByPoint(jur.water.source, lng, lat),
      errors
    );
    if (w) {
      const nField = jur.water.fieldMap?.name;
      result.water = {
        provider: (nField && w.attributes?.[nField]) ?? null,
        raw: w.attributes ?? null,
      };
    }
  }

  // --- 4g. Vacant Land Inventory (local, presence + attributes) -------------
  // Layer 124 is the city's curated inventory of vacant/underutilized parcels.
  // A point-in-polygon HIT == the parcel is ON the inventory — a positive
  // (opportunity) signal for a developer, NOT a hazard, so it does NOT downgrade
  // the verdict. The matched feature carries context (GP designation, land
  // class, area in acres, planning area), captured for display.
  if (jur.vacant?.source) {
    const vf = await safe(
      'vacant',
      () => queryByPoint(jur.vacant.source, lng, lat),
      errors
    );
    if (vf) {
      const fmv = jur.vacant.fieldMap || {};
      const a = vf.attributes || {};
      result.vacant = {
        inInventory: true,
        gpDesignation: (fmv.gpDesignation && a[fmv.gpDesignation]) ?? null,
        landClass: (fmv.landClass && a[fmv.landClass]) ?? null,
        areaAcres: (fmv.areaAcres && a[fmv.areaAcres]) ?? null,
        planningArea: (fmv.planningArea && a[fmv.planningArea]) ?? null,
        raw: a,
      };
    } else if (!errors.some((e) => e.startsWith('vacant'))) {
      // Clean miss == not on the vacant-land inventory.
      result.vacant = {
        inInventory: false, gpDesignation: null, landClass: null,
        areaAcres: null, planningArea: null, raw: null,
      };
    }
  }

  // --- 4h. Airport height influence (local, presence + optional AGL limit) ---
  // STAGED: inert until jur.airport.source is set to a VERIFIED endpoint (see the
  // airport block in jurisdictions.js for candidate sources + the MSL/AGL caveat).
  // An intersecting AIA / Part 77 / height-limitation polygon == the parcel is
  // height-constrained near SJC. heightLimitFt is captured ONLY when the layer
  // publishes an AGL limit; raw Part 77 surfaces are MSL and stay null here.
  if (jur.airport?.source) {
    const ap = await safe(
      'airport',
      () => queryByPoint(jur.airport.source, lng, lat),
      errors
    );
    if (ap) {
      const fm = jur.airport.fieldMap || {};
      const hl = fm.heightLimitFt ? Number(ap.attributes?.[fm.heightLimitFt]) : NaN;
      result.airport = {
        inInfluenceArea: true,
        heightLimitFt: Number.isFinite(hl) && hl > 0 ? hl : null,
        surface: (fm.surface && ap.attributes?.[fm.surface]) || null,
        raw: ap.attributes ?? null,
      };
    } else if (!errors.some((e) => e.startsWith('airport'))) {
      // Clean miss == outside the mapped airport influence/height area.
      result.airport = { inInfluenceArea: false, heightLimitFt: null, surface: null, raw: null };
    }
  }

  // --- 5. Flags + verdict ----------------------------------------------------
  let severity = 'go';
  for (const rule of SCREENING_RULES) {
    let triggered = false;
    try {
      triggered = rule.test(result);
    } catch {
      triggered = false;
    }
    if (triggered) {
      let flag = rule.flag;
      // Optional per-rule detail (e.g. the specific seismic hazard type).
      if (typeof rule.detail === 'function') {
        try {
          const d = rule.detail(result);
          if (d) flag = `${flag} — ${d}`;
        } catch { /* ignore detail errors */ }
      }
      result.flags.push(flag);
      if (rule.severity === 'no-go') severity = 'no-go';
      else if (rule.severity === 'caution' && severity !== 'no-go') severity = 'caution';
    }
  }
  result.verdict = severity;

  return result;
}
