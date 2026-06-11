/**
 * arcgis.js
 * -----------------------------------------------------------------------------
 * Minimal, dependency-free ArcGIS REST client. Runs in the MV3 service worker
 * (where cross-origin fetch is allowed with host_permissions declared).
 *
 * Responsibilities:
 *   - resolve an ArcGIS Hub item id -> live FeatureServer/MapServer URL
 *   - turn a config `source` into a concrete `{service}/{layerId}` layer URL
 *   - run point-in-polygon and attribute (APN) queries, asking the server to
 *     reproject to WGS84 (outSR=4326) so the rest of the app speaks lat/lng
 * -----------------------------------------------------------------------------
 */

const ITEM_URL_CACHE = new Map(); // itemId -> resolved service url

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON with a clear error on non-2xx or ArcGIS error envelopes.
 * Retries transient 5xx / "service not started" responses, which are common
 * with shared ArcGIS services that idle out and cold-start on first hit.
 */
async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status >= 500 && attempt < 2) {
      await delay(1200 * (attempt + 1));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const data = await res.json();
  if (data && data.error) {
    const msg = String(data.error.message || '');
    if ((Number(data.error.code) >= 500 || /not started/i.test(msg)) && attempt < 2) {
      await delay(1200 * (attempt + 1));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message}`);
  }
  return data;
}

/**
 * Resolve an ArcGIS Hub / Online item id to its underlying service URL via the
 * public sharing API. Cached for the life of the worker.
 *
 * IMPORTANT: this only works for items hosted on ArcGIS *Online*. Items served
 * from a city/county's own ArcGIS *Enterprise* server (e.g. San Jose) are not
 * visible here and will return "item does not exist or is inaccessible" — for
 * those, configure `kind: 'arcgis-service'` with the direct FeatureServer/
 * MapServer URL instead of `kind: 'arcgis-item'`.
 * @param {string} itemId
 * @returns {Promise<string>} e.g. "https://services.arcgis.com/.../FeatureServer"
 */
export async function resolveServiceUrl(itemId) {
  if (ITEM_URL_CACHE.has(itemId)) return ITEM_URL_CACHE.get(itemId);
  const meta = await fetchJson(
    `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`
  );
  if (!meta.url) {
    throw new Error(`Item ${itemId} has no service URL (type: ${meta.type || 'unknown'})`);
  }
  ITEM_URL_CACHE.set(itemId, meta.url);
  return meta.url;
}

/**
 * Turn a config `source` into a fully-qualified layer URL.
 * @param {{kind:string, serviceUrl?:string, itemId?:string, layerId:number}} source
 * @returns {Promise<string>}
 */
export async function getLayerUrl(source) {
  const layerId = source.layerId ?? 0;
  if (source.kind === 'arcgis-service') {
    return `${source.serviceUrl.replace(/\/$/, '')}/${layerId}`;
  }
  if (source.kind === 'arcgis-item') {
    const service = await resolveServiceUrl(source.itemId);
    return `${service.replace(/\/$/, '')}/${layerId}`;
  }
  throw new Error(`Unsupported source.kind: ${source.kind}`);
}

/** Build a /query URL with sane defaults, all values URL-encoded. */
function buildQueryUrl(layerUrl, params) {
  const qs = new URLSearchParams({
    f: 'json',
    where: '1=1', // some ArcGIS Server endpoints return 0 rows if where is absent
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    ...params,
  });
  return `${layerUrl}/query?${qs.toString()}`;
}

/**
 * Point-in-polygon query. Returns the first intersecting feature or null.
 * @param {object} source  config source block
 * @param {number} lng
 * @param {number} lat
 * @param {{outSR?:number|string}} [opts]  override output SR (e.g. 2227 for
 *   planar feet so polygonAreaSqFt can measure area). Default stays 4326.
 * @returns {Promise<{attributes:object, geometry:object}|null>}
 */
export async function queryByPoint(source, lng, lat, opts = {}) {
  const layerUrl = await getLayerUrl(source);
  const params = {
    // Canonical JSON geometry with embedded SR — more reliably reprojected by
    // older ArcGIS Server / Geocortex services than the bare "x,y" + inSR form.
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  };
  if (opts.outSR != null) params.outSR = String(opts.outSR);
  const url = buildQueryUrl(layerUrl, params);
  const data = await fetchJson(url);
  return data.features && data.features.length ? data.features[0] : null;
}

/**
 * Buffered point query: returns ALL features within `distance` of the point,
 * not just the first. This is the basis for "buffer + disambiguate" — the
 * caller decides what to do based on how many came back (0 / 1 / many).
 * @param {object} source
 * @param {number} lng
 * @param {number} lat
 * @param {number} distance  buffer radius
 * @param {string} units     esri unit string (default feet)
 * @returns {Promise<Array<{attributes:object, geometry:object}>>}
 */
export async function queryByPointBuffered(source, lng, lat, distance, units = 'esriSRUnit_Foot') {
  const layerUrl = await getLayerUrl(source);
  const url = buildQueryUrl(layerUrl, {
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(distance),
    units,
  });
  const data = await fetchJson(url);
  return data.features || [];
}

/**
 * Does ANY feature intersect this point? (For presence-only layers like fault
 * zones where attributes don't matter.)
 * @returns {Promise<{hit:boolean, feature:object|null}>}
 */
export async function intersectsPoint(source, lng, lat) {
  const feature = await queryByPoint(source, lng, lat);
  return { hit: !!feature, feature };
}

/**
 * Attribute query by APN. Useful when the user supplies an APN directly and you
 * want the parcel geometry/centroid without geocoding.
 * @returns {Promise<{attributes:object, geometry:object}|null>}
 */
export async function queryByApn(source, apnField, apn, opts = {}) {
  const layerUrl = await getLayerUrl(source);
  // Normalize APN to also try without dashes; many services store digits only.
  const clean = String(apn).replace(/[^0-9A-Za-z]/g, '');
  const where = `${apnField}=${sqlQuote(apn)} OR ${apnField}=${sqlQuote(clean)}`;
  const params = { where };
  if (opts.outSR != null) params.outSR = String(opts.outSR);
  const url = buildQueryUrl(layerUrl, params);
  const data = await fetchJson(url);
  return data.features && data.features.length ? data.features[0] : null;
}

/**
 * Generic attribute query. Returns all matching features (caller caps as needed).
 * `where` must already be a valid SQL fragment; callers build it via helpers
 * below that escape user input.
 * @returns {Promise<Array<{attributes:object, geometry:object}>>}
 */
export async function queryWhere(source, where, { returnGeometry = true } = {}) {
  const layerUrl = await getLayerUrl(source);
  const url = buildQueryUrl(layerUrl, { where, returnGeometry: String(returnGeometry) });
  const data = await fetchJson(url);
  return data.features || [];
}

/** Escape a value for use inside a single-quoted ArcGIS SQL string literal. */
export function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Compute a rough centroid (lng,lat) from an esri polygon's first ring. */
export function ringCentroid(geometry) {
  const ring = geometry?.rings?.[0];
  if (!ring || !ring.length) return null;
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return { lng: x / ring.length, lat: y / ring.length };
}

/**
 * Shoelace area of an esri polygon, in the units of its coordinates SQUARED.
 * For San Jose parcels (no area attribute), query the layer with outSR=2227
 * (State Plane CA III, US feet) and pass the returned geometry here to get
 * square feet. Do NOT pass 4326 (degrees) geometry — the result is meaningless.
 * Handles multiple rings (outer positive, holes negative by ring orientation).
 * @param {{rings:number[][][]}} geometry
 * @returns {number|null} area in coordinate-units^2, or null
 */
export function polygonAreaSqFt(geometry) {
  const rings = geometry?.rings;
  if (!rings || !rings.length) return null;
  let total = 0;
  for (const ring of rings) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % n];
      a += x1 * y2 - x2 * y1;
    }
    total += a / 2;
  }
  return Math.abs(total);
}
