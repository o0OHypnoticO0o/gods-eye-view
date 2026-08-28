/**
 * Shared Nominatim geocoding utilities — routes all requests through the
 * server-side /api/nominatim proxy (self-hosted or public).
 *
 * @module geocoding
 */

/**
 * Forward-geocode a place name via the Nominatim proxy.
 *
 * @param {string} query - Place name to search for.
 * @param {object} [options]
 * @param {string} [options.viewbox] - Optional viewbox bias ("lon1,lat1,lon2,lat2").
 * @param {number} [options.limit=5] - Max results.
 * @param {number} [options.timeoutMs=6000] - Request timeout.
 * @returns {Promise<Array<{lat:number, lon:number, label:string, type:string, importance:number, displayName:string}>>}
 */
export async function nominatimForward(query, options = {}) {
  const { viewbox, limit = 5, timeoutMs = 6000 } = options;
  const params = new URLSearchParams({ q: query, mode: 'search', limit: String(limit) });
  if (viewbox) params.set('viewbox', viewbox);

  try {
    const res = await fetch(`/api/nominatim?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      label: r.display_name || query,
      type: r.type || '',
      importance: r.importance || 0,
      displayName: r.display_name || '',
    }));
  } catch {
    return [];
  }
}

/**
 * Reverse-geocode coordinates via the Nominatim proxy.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} [options]
 * @param {number} [options.zoom=10] - Zoom level (higher = more precise place name).
 * @param {number} [options.timeoutMs=6000] - Request timeout.
 * @returns {Promise<{formattedAddress:string, locality:string, region:string, country:string, types:string[], labels:string[], streetLabels:string[]}|null>}
 */
export async function nominatimReverse(lat, lon, options = {}) {
  const { zoom = 10, timeoutMs = 6000 } = options;
  const params = new URLSearchParams({
    mode: 'reverse',
    lat: String(lat),
    lon: String(lon),
    zoom: String(zoom),
  });

  try {
    const res = await fetch(`/api/nominatim?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.error) return null;

    // Normalize Nominatim response to match the Google Geocoding shape
    // that the rest of the codebase expects.
    const addr = data.address || {};
    const locality = addr.city || addr.town || addr.village || addr.hamlet
      || addr.municipality || addr.county || null;
    const region = addr.state || null;
    const country = addr.country || null;

    // Build address component labels similar to Google's formatted_address
    const parts = [];
    if (locality) parts.push(locality);
    if (region) parts.push(region);
    if (country) parts.push(country);

    const labels = data.display_name ? data.display_name.split(',').map((s) => s.trim()) : [];
    const streetLabels = addr.road ? [addr.road] : [];

    return {
      formattedAddress: data.display_name || null,
      locality,
      region,
      country,
      types: data.type ? [data.type] : [],
      labels,
      streetLabels,
    };
  } catch {
    return null;
  }
}
