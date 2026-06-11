/**
 * jurisdictions.js
 * -----------------------------------------------------------------------------
 * Config-driven registry of data sources for parcel screening.
 *
 * The whole point of this file: adding or fixing a jurisdiction is a DATA edit
 * here, never a code change in the adapter. Endpoints, layer indices and field
 * names live in config so that when a city republishes its GIS (San Jose does
 * weekly) you change one line, not the pipeline.
 *
 * Two ways to point at an ArcGIS layer:
 *   { kind: 'arcgis-service', serviceUrl: '.../FeatureServer', layerId: 0 }
 *       -> direct, fastest, use when you know the exact FeatureServer URL.
 *   { kind: 'arcgis-item', itemId: '<hub item id>', layerId: 0 }
 *       -> resolved at runtime via the ArcGIS sharing API (see arcgis.js).
 *          Use for ArcGIS Hub open-data items whose service URL may change.
 *
 * fieldMap maps NORMALIZED keys -> RAW attribute names returned by that service.
 * Anything marked `// VERIFY` below must be confirmed against the live service
 * (see README -> "Validating an endpoint"). They are best-known values, not
 * guaranteed, because they couldn't be hit from the build environment.
 * -----------------------------------------------------------------------------
 */

/**
 * @typedef {Object} ScreenResult  Normalized output of screenParcel().
 * @property {{input:string, jurisdictionId:string}} query
 * @property {{lat:number, lng:number}|null} location
 * @property {{apn:string|null, areaSqft:number|null, geometry:object|null, raw:object|null}} parcel
 * @property {{method:string, note:string|null, candidates:Array<{apn:string|null, geometry:object|null}>|null}} parcelResolution
 * @property {{code:string|null, description:string|null, raw:object|null}} zoning
 * @property {{zone:string|null, sfha:boolean|null, floodway:boolean|null, bfe:number|null, raw:object|null}} flood
 * @property {{inFaultZone:boolean|null, hazardType:string|null, raw:object|null}} seismic
 * @property {{overThreshold:boolean|null, value:string|number|null, raw:object|null}} slope
 * @property {{type:string|null, raw:object|null}} soil
 * @property {{inHazardZone:boolean|null, hazardType:string|null, raw:object|null}} geologic
 * @property {{provider:string|null, raw:object|null}} water
 * @property {{inInventory:boolean|null, gpDesignation:string|null, landClass:string|null, areaAcres:number|null, planningArea:string|null, raw:object|null}} vacant
 * @property {{inInfluenceArea:boolean|null, heightLimitFt:number|null, surface:string|null, raw:object|null}} airport
 * @property {{minLotSqft:number|null, belowMinLot:boolean|null, setbacks:object|null, maxHeightFt:number|null, farThreshold:number|null, estMaxFloorAreaSqft:number|null, farBasis:string|null, note:string|null}} buildable
 * @property {string[]} flags
 * @property {'go'|'caution'|'no-go'|'unknown'} verdict
 * @property {string[]} errors
 */

/**
 * Layers shared by every California jurisdiction. Queried by point for any
 * parcel regardless of city/county.
 */
export const SHARED_LAYERS = {
  // FEMA National Flood Hazard Layer (national). Layer 28 = S_Fld_Haz_Ar.
  flood: {
    source: {
      kind: 'arcgis-service',
      // CONFIRMED path is /arcgis/rest/... (the /gis/nfhl/... path 404s).
      serviceUrl: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer',
      layerId: 28, // confirmed: "Flood Hazard Zones" (FLD_ZONE / SFHA_TF / ZONE_SUBTY)
    },
    fieldMap: {
      zone: 'FLD_ZONE',   // e.g. "X", "AE", "VE"
      sfha: 'SFHA_TF',    // "T"/"F" -> Special Flood Hazard Area
      floodway: 'ZONE_SUBTY', // e.g. "FLOODWAY"
    },
  },

  // California Geological Survey - Alquist-Priolo Earthquake Fault Zones.
  // Presence of an intersecting feature == parcel sits in a fault zone.
  // URL confirmed live (FeatureServer, layer 0 "Fault_Zones"). NOTE: this is a
  // shared CGS service that idles out and can return a 500 "service not started"
  // on a cold hit — arcgis.js retries transient 5xx, which clears it.
  seismicFault: {
    source: {
      kind: 'arcgis-service',
      serviceUrl:
        'https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Fault_Zones/FeatureServer',
      layerId: 0,
    },
    fieldMap: {}, // presence-only; attributes not required for the flag
  },

  // OPTIONAL next layers (same CGS folder). Add when ready, then wire in screen.js.
  // seismicLiquefaction: { source: { kind:'arcgis-service',
  //   serviceUrl:'https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Liquefaction_Zones/FeatureServer',
  //   layerId: 0 }, fieldMap: {} },               // VERIFY service name
  // seismicLandslide: { ... SHP_Landslide_Zones ... },  // VERIFY service name
};

/**
 * San Jose zoning-code -> human-readable label. The zoning layer encodes the
 * label only in its map renderer, not in an attribute, so we keep a lookup
 * here. Partial set (extend as needed from the city's zoning ordinance).
 */
export const SJ_ZONING_LABELS = {
  A: 'Agriculture',
  'R-1-5': 'Single-Family Residential (R-1-5)',
  'R-1-8': 'Single-Family Residential (R-1-8)',
  'R-M': 'Multiple Residence District',
  'R-MH': 'Mobilehome Park',
  'R-M(CL)': 'Cluster (Multiple Residence)',
  CIC: 'Combined Industrial/Commercial',
  CG: 'Commercial General',
  'CG(PD)': 'Commercial General (Planned Development)',
  CN: 'Commercial Neighborhood',
  CO: 'Commercial Office',
  CP: 'Commercial Pedestrian',
  PQP: 'Public/Quasi-Public',
  DC: 'Downtown Primary Commercial',
  'DC-NT1': 'Downtown Commercial – Neighborhood Transition 1',
  HI: 'Heavy Industrial',
  IP: 'Industrial Park',
  LI: 'Light Industrial',
  'MS-C': 'Main Street Commercial',
  'MS-G': 'Main Street Ground Floor Commercial',
  OS: 'Open Space',
};

/**
 * Per-jurisdiction registry. Key = jurisdictionId used everywhere downstream.
 */
export const JURISDICTIONS = {
  'san-jose': {
    label: 'San Jose, CA',
    type: 'city',
    // Bias geocoding toward the city centroid (lng, lat).
    geocodeBias: { lng: -121.8863, lat: 37.3382 },

    // All San Jose planning layers live in ONE enterprise MapServer.
    // CONFIRMED live against the service directory. Native spatial reference is
    // 2227 (State Plane CA Zone 3, US feet); the client requests outSR=4326 so
    // results come back as lat/lng. Datum transformation is supported.
    // (Note: these items are NOT on ArcGIS Online, which is why the
    // www.arcgis.com sharing API returned "item does not exist" — we point at
    // the city's own server directly instead.)

    // Parcels = layer 49. APN field = 'APN' (alias "Assessors Parcel Number").
    // This layer has NO area attribute, so parcel area is geometry-derived:
    // query with outSR:2227 and use polygonAreaSqFt() in arcgis.js.
    parcel: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 49,
      },
      fieldMap: {
        apn: 'APN',     // confirmed
        areaSqft: null, // no field; compute from geometry
      },
    },

    // Parcel-resolution strategy (see resolveParcel() in screen.js).
    // The free Census geocoder returns STREET-INTERPOLATED points (mid-road),
    // which fall in the right-of-way gap between parcels and miss on a direct
    // point-in-polygon. To stay accurate AND honest, resolution is layered:
    //   0) APN supplied directly -> exact attribute query
    //   1) geocode -> exact point-in-polygon against the parcel layer
    //   2) geocode -> small buffer; use ONLY if exactly one parcel is in range,
    //      otherwise surface candidates (buffer + disambiguate, never guess)
    //
    // NOTE: an address-point layer (SJ 131) was tried as a resolver tier and
    // REMOVED — it holds near-zero-area POINTS, so a point-intersect almost
    // never matches, and its APN field (integer) doesn't join cleanly to the
    // parcel layer's string APN. The parcel POLYGON layer + buffer is the
    // correct, jurisdiction-agnostic approach.
    resolver: {
      bufferFeet: 60,        // tested: recovers ROW-dropped points around SJ parcels
      maxCandidates: 5,      // cap features we'll show for disambiguation
    },

    // Zoning = layer 128 "Zoning District". Code field = 'ZONING' (also
    // 'ZONINGABBREV'). CONFIRMED to return a code on a point query where layer
    // 129 "Zonings (Since 2000)" has coverage GAPS — so 128 is the primary.
    zoning: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 128,
      },
      fieldMap: {
        code: 'ZONING',    // confirmed (e.g. "HI" Heavy Industrial)
        description: null, // derived from labels below
      },
      labels: SJ_ZONING_LABELS,
    },

    // DEVELOPMENT STANDARDS — residential SJMC §20.30.200, commercial §20.40.200
    // (Table 20-100), industrial §20.50.200 (Table 20-120), read live from the
    // city's Municode. Used for the buildability check + envelope reference.
    // IMPORTANT findings that shaped this:
    //   • SJ residential has NO max-lot-coverage %, so "lot × coverage" is not
    //     applicable. The standards the code DOES define cleanly are minimum lot
    //     area, setbacks, and height — captured here.
    //   • Single-family buildable SIZE is governed by FAR, implemented as a
    //     discretionary-review trigger (SJMC §20.100.1000, Single-Family House
    //     Permit): a house above 0.45 FAR triggers review. We use that as
    //     `farThreshold` to estimate a "max floor area before review." It is a
    //     REVIEW TRIGGER, not a hard cap.
    //     0.45 CORRECTED (was 0.65): confirmed by the City's own permit page
    //     (sanjoseca.gov "Single-Family House Permit" — "FAR ... will exceed
    //     0.45") and a source citing §20.100.1000. The raw §20.100.1000 text is
    //     JS-rendered on Municode and could not be machine-extracted; if a direct
    //     read of the section differs, this is a one-value-per-district revert.
    //   • R-M/R-MH (multi-family) are DENSITY-governed via the General Plan, not
    //     FAR — so farThreshold is null there and we show a note instead.
    //   • R-2: the SFH permit submittal covers "Single-Family/Duplex," so 0.45 is
    //     applied as the best-evidenced duplex value — VERIFY the duplex trigger
    //     specifically against §20.100.1000.
    //   • COMMERCIAL (§20.40.200) and INDUSTRIAL (§20.50.200) tables define NO
    //     FAR and NO lot-coverage standard (confirmed live), so their buildable
    //     size is not zoning-FAR-capped: farThreshold is null and `farBasis`
    //     shows "No zoning FAR cap". Stored setbacks are BASE building setbacks;
    //     corner-lot, R-1-adjacency, abutting-residential (+25 ft), build-to
    //     maximums, and Ch. 20.85 height overrides are noted per district.
    //     Parking / truck / loading-dock setbacks are NOT modeled.
    // The R-1 suffix is DENSITY (units/acre), NOT lot size: R-1-8 = smallest lot
    // (5,445 sf ≈ 1/8 acre), R-1-1 = 1 acre. Setbacks are interior-lot values
    // (corner-lot side/rear differ — see §20.30.200 Notes).
    developmentStandards: {
      'R-1-8':  { minLotSqft: 5445,   setbacks: { front: 20, side: 5,  rear: 20 }, maxHeightFt: 35, farThreshold: 0.45 },
      'R-1-5':  { minLotSqft: 8000,   setbacks: { front: 20, side: 5,  rear: 20 }, maxHeightFt: 35, farThreshold: 0.45 },
      'R-1-2':  { minLotSqft: 20000,  setbacks: { front: 30, side: 15, rear: 25 }, maxHeightFt: 35, farThreshold: 0.45 },
      'R-1-1':  { minLotSqft: 43560,  setbacks: { front: 30, side: 20, rear: 25 }, maxHeightFt: 35, farThreshold: 0.45 },
      'R-1-RR': { minLotSqft: 217800, setbacks: { front: 50, side: 20, rear: 30 }, maxHeightFt: 35, farThreshold: 0.45 },
      'R-2':    { minLotSqft: 5445,   setbacks: { front: 15, side: 5,  rear: 25 }, maxHeightFt: 35, farThreshold: 0.45 },
      'R-M':    { minLotSqft: 6000,   setbacks: { front: 10, side: 5,  rear: 25 }, maxHeightFt: 45, farThreshold: null, farBasis: 'Density-governed (GP)', note: 'Multi-family — buildable size governed by General Plan density, not FAR.' },
      'R-MH':   { minLotSqft: 6000,   setbacks: { front: 15, side: 5,  rear: 25 }, maxHeightFt: 45, farThreshold: null, farBasis: 'Density-governed (GP)', note: 'Mobilehome park — density-governed; FAR estimate not applicable.' },

      // COMMERCIAL — SJMC §20.40.200 (Table 20-100). No FAR / lot-coverage. Base
      // building setbacks displayed; `setbacks.matrix` holds the extras (corner-
      // lot side, CP build-to front max). Conditions also summarized in `note`.
      'CO':  { minLotSqft: 6000,  setbacks: { front: 10, side: 5,  rear: 25, matrix: { corner: { side: 12.5 } } }, maxHeightFt: 35, farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Front 15 ft if adjacent to a side property line of R-1; corner-lot side 12.5 ft. Per-occupant floor-area caps apply (2,500/5,000/15,000 sf by use). Height per Ch. 20.85.' },
      'CN':  { minLotSqft: 6000,  setbacks: { front: 10, side: 0,  rear: 0,  matrix: { corner: { side: 12.5 } } }, maxHeightFt: 50, farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Min lot / front setback may be set by an Urban Village Plan. Corner-lot side 12.5 ft. Height per Ch. 20.85.' },
      'CP':  { minLotSqft: 6000,  setbacks: { front: 0,  side: 0,  rear: 25, matrix: { frontMax: 10 } }, maxHeightFt: 50, farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Front is a 10 ft MAXIMUM (build-to), not a minimum. Min lot may be set by an Urban Village Plan. Height per Ch. 20.85.' },
      'CG':  { minLotSqft: 43560, setbacks: { front: 15, side: 0,  rear: 0,  matrix: { corner: { side: 12.5 } } }, maxHeightFt: 65, farThreshold: null, farBasis: 'No zoning FAR cap', note: 'No min lot if within a shopping center with shared access & parking. Corner-lot side 12.5 ft. Height per Ch. 20.85.' },
      'PQP': { minLotSqft: 6000,  setbacks: { front: 10, side: 10, rear: 10 }, maxHeightFt: 65, farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Public/Quasi-Public. Setbacks may be reduced per an approved development permit. Height per Ch. 20.85.' },

      // INDUSTRIAL — SJMC §20.50.200 (Table 20-120). No FAR / lot-coverage. Base
      // building setbacks displayed; `setbacks.matrix` holds abutting-residential
      // (side/rear) and the per-use parking/truck/loading setbacks + min street
      // frontage. VERIFIED live vs Table 20-120: ONE setback per use per district
      // (cols CIC, TEC, IP, LI, HI) — no separate side/rear split for these uses.
      'CIC': { minLotSqft: 6000,  setbacks: { front: 15, side: 0, rear: 0, matrix: { abuttingResidential: 25, parking: { front: 20 }, truck: { front: 40 }, loadingDock: { front: 60, fromResidential: 100 }, streetFrontageFt: 60 } }, maxHeightFt: 50,  farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Combined Industrial/Commercial. Side/rear 25 ft where abutting residential. Height per Ch. 20.85.' },
      'TEC': { minLotSqft: 6000,  setbacks: { front: 15, side: 0, rear: 0, matrix: { abuttingResidential: 25, parking: { front: 25 }, truck: { front: 40 }, loadingDock: { front: 60, fromResidential: 100 }, streetFrontageFt: 60 } }, maxHeightFt: 120, farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Side/rear 25 ft where abutting residential. Height per Ch. 20.85.' },
      'IP':  { minLotSqft: 10000, setbacks: { front: 15, side: 0, rear: 0, matrix: { abuttingResidential: 25, parking: { front: 25 }, truck: { front: 40 }, loadingDock: { front: 60, fromResidential: 100 }, streetFrontageFt: 60 } }, maxHeightFt: 50,  farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Industrial Park. Side/rear 25 ft where abutting residential. Height per Ch. 20.85.' },
      'LI':  { minLotSqft: 10000, setbacks: { front: 15, side: 0, rear: 0, matrix: { abuttingResidential: 25, parking: { front: 20 }, truck: { front: 30 }, loadingDock: { front: 60, fromResidential: 100 }, streetFrontageFt: 60 } }, maxHeightFt: 50,  farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Light Industrial. Side/rear 25 ft where abutting residential. Height per Ch. 20.85.' },
      'HI':  { minLotSqft: 6000,  setbacks: { front: 15, side: 0, rear: 0, matrix: { abuttingResidential: 25, parking: { front: 15 }, truck: { front: 15 }, loadingDock: { front: 15, fromResidential: 100 }, streetFrontageFt: 60 } }, maxHeightFt: 50,  farThreshold: null, farBasis: 'No zoning FAR cap', note: 'Heavy Industrial. Side/rear 25 ft where abutting residential. Loading-dock front setback 15 ft. Height per Ch. 20.85.' },

      // DOWNTOWN — SJMC Ch. 20.70. DC has NO minimum setbacks (build-to-line) and
      // NO fixed zoning height cap — height is airport-governed (FAA Part 77),
      // captured as a note. DC-NT1 is a TRANSITION district whose height/setbacks
      // are SUB-AREA specific (Table 20-150) and cannot be derived from the zoning
      // code alone — so it carries no fixed numbers, only the sub-area note.
      'DC':     { minLotSqft: null, setbacks: { front: 0, side: 0, rear: 0 }, maxHeightFt: null, farThreshold: null, farBasis: 'No zoning FAR cap (downtown)', note: 'Downtown Primary Commercial. No minimum setbacks (build-to-line). Height governed by San José International Airport airspace (FAA Part 77), not zoning — no fixed cap. A structure over 150 ft, or over 6:1 FAR within 100 ft of a City Landmark, triggers historic-adjacency review (§20.70.110).' },
      'DC-NT1': { minLotSqft: null, setbacks: null, maxHeightFt: null, farThreshold: null, farBasis: 'Sub-area specific (Table 20-150)', note: 'Downtown Commercial – Neighborhood Transition 1. Standards are SUB-AREA specific (Table 20-150) and depend on its street segment — not derivable from the zoning code alone. Sub-areas: Balbach (S side, Almaden Ave–Almaden Blvd): 10 ft setback, with a 50 ft setback for portions of buildings above 70 ft; Almaden Ave (W side, Balbach–Reed): 35 ft / 2.5 stories; Almaden Blvd (E side, Balbach–I-280): 70 ft (up to 100 ft with Planning Commission approval), upper-portion stepbacks; Market St (W side, Balbach–Pierce): 60 ft, no front/side setbacks except recessed entries; Market St (W side, Pierce–Hwy 280): 120 ft, min 10 ft to a residential line, 3:2 height slope from adjacent residential. Where Table 20-150 is silent, DC standards apply.' },
    },

    // FLOOD override — San Jose layer 170 "Flood Hazard Area". This is the SAME
    // FEMA DFIRM data (DFIRMID 06085C, AGENCY "FEMA") as the shared NFHL layer
    // 28, but served from the city's reliable host AND carrying a base-flood-
    // elevation field. Local-first: when present, screen.js uses this instead of
    // SHARED_LAYERS.flood — DELETE this block to fall back to the national FEMA
    // service. Field names differ from the NFHL only by dropping the underscores
    // (FLDZONE/SFHATF/ZONESUBTY vs FLD_ZONE/SFHA_TF/ZONE_SUBTY) — CONFIRMED live
    // against a sample record. STATICBFE is a string in feet (NAVD88); the
    // NoData sentinel -9999 (and blank) is normalized to null in screen.js.
    flood: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 170,
      },
      fieldMap: {
        zone: 'FLDZONE',       // confirmed (e.g. "AE")
        sfha: 'SFHATF',        // confirmed ("T"/"F")
        floodway: 'ZONESUBTY', // confirmed ("FLOODWAY" → no-go; blank = none)
        bfe: 'STATICBFE',      // confirmed — base flood elevation (ft); -9999/blank = none
      },
    },

    // Per-jurisdiction SEISMIC override. The statewide CGS fault service is
    // frequently "not started" (500); San Jose hosts its own Seismic Hazard
    // Zone layer (81) on this same reliable server, AND it carries a
    // 'HAZARDTYPE' field (e.g. "Liquefaction", "Landslide") — richer than a
    // binary fault yes/no. When present, screen.js uses this instead of the
    // shared CGS layer.
    seismic: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 81,
      },
      fieldMap: {
        hazardType: 'HAZARDTYPE', // confirmed
      },
    },

    // SLOPE override — San Jose layer 151 "Slope Over 15%". This is a THEMATIC
    // layer: a feature only exists where slope exceeds 15%, so a point-in-polygon
    // HIT == steep slope (presence-based, like the CGS fault layer). That makes
    // the verdict field-name-independent and robust to schema changes.
    //
    // `fieldMap.value` is OPTIONAL and only used to DISPLAY a slope band/percent
    // if the layer carries one (some SJ slope layers expose a class field such as
    // a range or a percent). If the field name below is wrong, the screen still
    // works — you just won't see the band. Confirm/replace via:
    //   .../MapServer/151?f=json   (read the "fields" array)
    // then set `value` to the real attribute name, or leave it null.
    slope: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 151,
      },
      fieldMap: {
        value: null, // VERIFY — optional display field (e.g. slope class/percent); null = presence-only
      },
    },

    // SOIL override — San Jose layer 83 "Soil Type". Unlike slope/seismic this is
    // NOT presence-based: every parcel sits on some soil, so the signal is the
    // TYPE attribute, not whether a polygon was hit. Field + value domain are
    // CONFIRMED live against the service (see fieldMap below). screen.js also
    // keeps the full raw attributes so other fields (MINHSG/MINUSDA) stay
    // recoverable. The problem-soil verdict rule is active in SCREENING_RULES,
    // keyed to the confirmed clay-bearing types.
    soil: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 83,
      },
      fieldMap: {
        type: 'SOILTYPE', // confirmed (layer 83, string[12]). Distinct values:
                          //   Clay, Clay Loam, Sandy Clay, Silt Loam, Loam.
                          // Also available on this layer: MINHSG (hydrologic soil
                          // group A–D) and MINUSDA (USDA description) — wire later
                          // if you want a drainage/runoff flag.
      },
    },

    // GEOLOGIC HAZARD override — San Jose layer 27 "Geologic Hazard Zone".
    // Presence-based like slope/seismic: an intersecting polygon == the parcel
    // sits in a mapped geologic hazard zone (landslide / debris-flow / fault
    // rupture), distinct from the seismic (liquefaction) layer 81. No field name
    // is needed for the flag. The hazard-type detail is optional — confirm via:
    //   .../MapServer/27?f=json   (read "fields") + a point /query for a value
    // then set `hazardType` to the real attribute name (null = presence-only).
    geologic: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 27,
      },
      fieldMap: {
        hazardType: null, // VERIFY — optional hazard-type field; null = presence-only
      },
    },

    // WATER SERVICE PROVIDER override — San Jose layer 125. Attribute layer:
    // every parcel falls inside a provider's service-area polygon, so the signal
    // is the provider NAME, not presence. Field CONFIRMED live against a sample
    // record (NAME = e.g. "San Jose Water Company"). Informational only — no
    // screening rule is attached (a future "private/non-municipal" flag would
    // need the full NAME value domain, not yet captured).
    water: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 125,
      },
      fieldMap: {
        name: 'NAME', // confirmed (layer 125) — provider name
      },
    },

    // VACANT LAND INVENTORY override — San Jose layer 124. The city's curated
    // inventory of vacant/underutilized parcels; the features ARE parcel-shaped
    // (carry an APN). A point-in-polygon HIT == the parcel is ON the inventory,
    // a POSITIVE/opportunity signal for a developer — so this adds NO caution
    // rule and never downgrades the verdict. Fields CONFIRMED live against a
    // sample record: GPDESIGNATION (General Plan land use, e.g. "Lower
    // Hillside"), LANDCLASS (coded, e.g. "LH" — value domain not yet captured,
    // displayed raw), VLIAREA (acres), PLANNINGAREA (e.g. "Alum Rock").
    vacant: {
      source: {
        kind: 'arcgis-service',
        serviceUrl:
          'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer',
        layerId: 124,
      },
      fieldMap: {
        gpDesignation: 'GPDESIGNATION', // confirmed
        landClass: 'LANDCLASS',         // confirmed (coded; label domain TODO)
        areaAcres: 'VLIAREA',           // confirmed — acres
        planningArea: 'PLANNINGAREA',   // confirmed
      },
    },

    // AIRPORT HEIGHT INFLUENCE — STAGED, NOT YET ACTIVE.
    // -------------------------------------------------------------------------
    // Near Mineta San José Int'l (SJC), building height is constrained by the
    // FAA Part 77 imaginary surfaces and the County ALUC Comprehensive Land Use
    // Plan, NOT by zoning (this is why DC height is "airport-governed"). This
    // block is intentionally INERT: `source` is null, so screen.js skips the
    // airport step. Enabling it is a one-line config edit once an endpoint is
    // VERIFIED — deliberately not guessed, per the project's never-guess rule.
    //
    // Candidate sources to verify (pick the one that exposes an AGL height):
    //   • County ALUC GIS — Airport Influence Area (AIA), Part 77 height contours,
    //     safety zones (Santa Clara County Planning & Development / ALUC).
    //   • City of San José "Specific Height Limitation Areas" (2012/2013 ords) and
    //     the 2019 Downtown/Diridon airspace policy (flysanjose.com/
    //     downtownheightlimits) — may live in the same geo.sanjoseca.gov MapServer
    //     at another layer index.
    //
    // IMPORTANT — units: raw Part 77 surfaces are MSL ELEVATION surfaces. A
    // building height (AGL) = surface elevation − ground elevation, so a raw
    // Part 77 layer alone CANNOT give a building-height number without a DEM.
    // Only map `heightLimitFt` to a layer that publishes an AGL limit directly;
    // otherwise leave it null and rely on presence (inInfluenceArea) for the flag.
    //
    // To activate: set source.serviceUrl + layerId (verify via <serviceUrl>?f=json
    // → layer list → <serviceUrl>/<id>?f=json → fields), then fill fieldMap.
    airport: {
      source: {
        kind: 'arcgis-service',
        serviceUrl: 'https://services2.arcgis.com/tcv2cMrq63AgvbHF/arcgis/rest/services/Santa_Clara_County_Airport_Influence_Areas/FeatureServer',
        layerId: 2,
      },
      fieldMap: {
        heightLimitFt: null,
        surface: 'AIRPORT',
      },
    },

    // Higher-fidelity San Jose-LOCAL layers in the same service. Wire these in
    // later as jurisdiction overrides (more accurate than the statewide/national
    // shared layers) — this doubles as your civil-engineering roadmap:
    //   170 Flood Hazard Area      81 Seismic Hazard Zone    27 Geologic Hazard Zone
    //   151 Slope Over 15%         83 Soil Type             124 Vacant Land Inventory
    //   125 Water Service Provider 69 Sanitary Mains         86 Storm Drain System
    //   131 Site Address Points (local geocoding alternative)
    localLayers: {
      floodHazardArea: 170, geologicHazardZone: 27,
      slopeOver15: 151, soilType: 83, vacantLand: 124, waterServiceProvider: 125,
    },
  },

  // Template for the next jurisdiction (e.g. demoing on your home county).
  // Copy, rename the key, fill the four source blocks + field maps, done.
  // 'alameda-county': {
  //   label: 'Alameda County (unincorporated), CA',
  //   type: 'county',
  //   geocodeBias: { lng: -121.9, lat: 37.6 },
  //   parcel:  { source: { kind:'arcgis-service', serviceUrl:'...', layerId:0 }, fieldMap:{ apn:'APN', areaSqft:'...' } },
  //   zoning:  { source: { kind:'arcgis-service', serviceUrl:'...', layerId:0 }, fieldMap:{ code:'...', description:'...' } },
  // },
};

/**
 * Screening rules, evaluated against the normalized result to produce flags
 * and a verdict. Kept here (not in code) so the logic stays inspectable and
 * tunable per your risk tolerance.
 *
 * Each rule: { test(result) => boolean, flag: string, severity: 'no-go'|'caution' }
 */
export const SCREENING_RULES = [
  {
    severity: 'no-go',
    flag: 'In regulatory floodway',
    // Source-agnostic: screen.js normalizes a `floodway` boolean from whichever
    // flood layer is active (shared FEMA NFHL or a local override like SJ 170),
    // so this rule no longer reaches into raw with a hardcoded field name.
    test: (r) => r.flood?.floodway === true,
  },
  {
    severity: 'caution',
    flag: 'In FEMA Special Flood Hazard Area',
    test: (r) => r.flood.sfha === true,
  },
  {
    severity: 'caution',
    flag: 'In a mapped seismic hazard zone (geologic/geotechnical study required before permit)',
    test: (r) => r.seismic.inFaultZone === true,
    // When the local layer supplies a hazard type, name it for specificity.
    detail: (r) => (r.seismic.hazardType
      ? `Seismic hazard type: ${r.seismic.hazardType}`
      : null),
  },
  {
    severity: 'caution',
    flag: 'Slope over 15% — grading/geotechnical cost and reduced buildable area',
    test: (r) => r.slope?.overThreshold === true,
    // If the layer exposes a band/percent (jur.slope.fieldMap.value), name it.
    detail: (r) => (r.slope?.value != null ? `Slope class: ${r.slope.value}` : null),
  },
  // PROBLEM-SOIL rule — ACTIVE. Layer 83's confirmed SOILTYPE domain is:
  //   Clay, Clay Loam, Sandy Clay, Silt Loam, Loam.
  // The buildability concern is expansive / shrink-swell clay soils, so the
  // clay-bearing types (Clay, Clay Loam, Sandy Clay) flag as caution; Loam and
  // Silt Loam do not. Tune the regex if you want to treat Silt Loam differently.
  {
    severity: 'caution',
    flag: 'Clay-bearing soil — expansive/shrink-swell risk; geotechnical review and special foundation design likely',
    test: (r) => typeof r.soil?.type === 'string' && /clay/i.test(r.soil.type),
    detail: (r) => (r.soil?.type ? `Soil type: ${r.soil.type}` : null),
  },
  {
    severity: 'caution',
    flag: 'In a mapped geologic hazard zone (landslide/debris-flow/fault) — geologic/geotechnical study likely required',
    test: (r) => r.geologic?.inHazardZone === true,
    detail: (r) => (r.geologic?.hazardType ? `Hazard type: ${r.geologic.hazardType}` : null),
  },
  {
    severity: 'caution',
    flag: 'Within the Airport Influence Area — building height may be limited by FAA Part 77; an FAA Form 7460-1 filing and/or ALUC referral may be required',
    test: (r) => r.airport?.inInfluenceArea === true,
    detail: (r) => {
      const parts = [];
      if (r.airport?.heightLimitFt != null) parts.push(`~${r.airport.heightLimitFt} ft AGL limit`);
      if (r.airport?.surface) parts.push(String(r.airport.surface));
      return parts.length ? parts.join(' · ') : null;
    },
  },
  {
    severity: 'caution',
    flag: 'Parcel is below the minimum lot area for its zoning — may not be independently developable or subdividable',
    test: (r) => r.buildable?.belowMinLot === true,
    detail: (r) => (r.buildable?.minLotSqft && r.parcel?.areaSqft != null
      ? `${r.parcel.areaSqft.toLocaleString()} sf vs ${r.buildable.minLotSqft.toLocaleString()} sf required`
      : null),
  },
  {
    severity: 'caution',
    flag: 'No zoning resolved for this parcel',
    test: (r) => !r.zoning.code,
  },
];

/** Convenience accessor with a clear error for unknown jurisdictions. */
export function getJurisdiction(jurisdictionId) {
  const j = JURISDICTIONS[jurisdictionId];
  if (!j) {
    throw new Error(
      `Unknown jurisdiction "${jurisdictionId}". Known: ${Object.keys(JURISDICTIONS).join(', ')}`
    );
  }
  return j;
}
