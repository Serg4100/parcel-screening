/**
 * geocode.js
 * -----------------------------------------------------------------------------
 * Address -> {lat, lng} using the free U.S. Census Geocoder. No key, no quota
 * sign-up, returns WGS84. Good enough for screening triage; for production you
 * may later swap in a paid geocoder by replacing geocodeAddress() only.
 *
 * Note: when the user already has an APN, skip this entirely and resolve the
 * parcel by attribute query (see screen.js) — it's more reliable than geocoding.
 * -----------------------------------------------------------------------------
 */

const CENSUS_BASE =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

/**
 * @param {string} address  e.g. "200 E Santa Clara St, San Jose, CA"
 * @returns {Promise<{lat:number, lng:number, matchedAddress:string}|null>}
 */
export async function geocodeAddress(address) {
  const qs = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  const res = await fetch(`${CENSUS_BASE}?${qs.toString()}`);
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  const data = await res.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;
  // Census returns coordinates as { x: lng, y: lat }.
  return {
    lat: match.coordinates.y,
    lng: match.coordinates.x,
    matchedAddress: match.matchedAddress,
  };
}
